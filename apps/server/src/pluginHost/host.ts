import path from 'node:path';
import type { GameManifest } from '@platform/sdk';
import type { Store } from '../store.js';
import { WorkerPluginRuntime, type PluginRuntime } from './runtime.js';
import { PluginError, type GameVersionRecord } from './types.js';

/**
 * 插件运行时注册表。
 *
 * 每个 (游戏, 版本) 对应一个 worker。缓存按版本存，
 * 一张桌锁哪个版本就永远拿哪个实例；版本退役且没有桌在用 → terminate，内存真正释放。
 */
export class PluginHost {
  private readonly loaded = new Map<string, PluginRuntime>();
  private readonly active = new Map<string, GameVersionRecord>();

  constructor(
    private readonly store: Store,
    readonly storageRoot: string,
  ) {}

  private key(gameId: string, version: string): string {
    return `${gameId}@${version}`;
  }

  /** 启动时按库恢复：只把每个游戏的 active 版本先加载进来，其它版本按需加载 */
  async refresh(): Promise<void> {
    const versions = await this.store.listGameVersions();
    this.active.clear();
    for (const record of versions) {
      if (record.status !== 'active') continue;
      this.active.set(record.gameId, record);
      await this.load(record);
    }
  }

  async load(record: GameVersionRecord): Promise<PluginRuntime> {
    const key = this.key(record.gameId, record.version);
    const cached = this.loaded.get(key);
    if (cached) return cached;

    const runtime = new WorkerPluginRuntime(
      record.gameId,
      record.version,
      record.manifest,
      path.join(record.dir, 'server.js'),
      record.hash,
    );

    try {
      await runtime.ready();
    } catch (error) {
      await runtime.terminate().catch(() => undefined);
      throw new PluginError('load_failed', `加载 ${key} 失败：${(error as Error).message}`);
    }

    this.loaded.set(key, runtime);
    return runtime;
  }

  get(gameId: string, version: string): PluginRuntime | undefined {
    return this.loaded.get(this.key(gameId, version));
  }

  /** 桌子里锁定的版本可能不是 active（老桌），这里按需从库里补加载 */
  async ensure(gameId: string, version: string): Promise<PluginRuntime> {
    const found = this.get(gameId, version);
    if (found) return found;
    const record = await this.store.getGameVersion(gameId, version);
    if (!record) throw new PluginError('unknown_version', `找不到插件 ${gameId}@${version}`);
    return this.load(record);
  }

  activeFor(gameId: string): GameVersionRecord | undefined {
    return this.active.get(gameId);
  }

  /** 大厅列表：每个游戏一条（当前 active 版本） */
  listActive(): GameManifest[] {
    return [...this.active.values()].map((record) => record.manifest);
  }

  async invalidate(gameId: string, version: string): Promise<void> {
    const key = this.key(gameId, version);
    const runtime = this.loaded.get(key);
    this.loaded.delete(key);
    if (runtime) await runtime.terminate();
  }

  /**
   * 切换 active 版本：**先加载成功再切指针**，
   * 避免把一个跑不起来的版本推上线（加载失败时旧版本继续服务）。
   */
  async setActive(gameId: string, version: string): Promise<GameVersionRecord> {
    const record = await this.store.getGameVersion(gameId, version);
    if (!record) throw new PluginError('unknown_version', `找不到插件 ${gameId}@${version}`);

    await this.load(record);
    await this.store.setActiveVersion(gameId, version);

    const updated: GameVersionRecord = { ...record, status: 'active', activatedAt: Date.now() };
    this.active.set(gameId, updated);
    return updated;
  }

  /**
   * 禁用：从 active 指针上摘掉，游戏就不再出现在大厅、也开不了新房。
   *
   * worker 先不动——可能还有进行中的牌桌在用它，`releaseIdle()` 会在没桌用的时候收掉。
   * 恢复走 `setActive()`，它会重新加载并切回 active。
   */
  async disable(gameId: string, version: string): Promise<void> {
    const record = await this.store.getGameVersion(gameId, version);
    if (!record) throw new PluginError('unknown_version', `找不到插件 ${gameId}@${version}`);

    await this.store.setVersionStatus(gameId, version, 'disabled');
    if (this.active.get(gameId)?.version === version) this.active.delete(gameId);
  }

  /**
   * 回收：卸载既不是 active、也没有进行中牌桌在用的版本。
   *
   * 这就是 worker 隔离换来的东西——卸载 = terminate，模块图真能从内存消失；
   * 之后若还有人要看回放，`ensure()` 会重新按需加载。
   */
  async releaseIdle(inUse: Set<string>): Promise<string[]> {
    const released: string[] = [];

    for (const [key, runtime] of [...this.loaded.entries()]) {
      const isActive = this.active.get(runtime.gameId)?.version === runtime.version;
      if (isActive) continue;
      if (inUse.has(key)) continue;

      this.loaded.delete(key);
      await runtime.terminate();
      released.push(key);
    }

    return released;
  }

  /** 当前内存里活着哪些版本（诊断用） */
  loadedVersions(): string[] {
    return [...this.loaded.keys()];
  }

  async closeAll(): Promise<void> {
    for (const runtime of this.loaded.values()) {
      await runtime.terminate().catch(() => undefined);
    }
    this.loaded.clear();
  }
}
