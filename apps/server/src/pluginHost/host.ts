import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { GameManifest, GamePlugin } from '@platform/sdk';
import type { Store } from '../store.js';
import { PluginError, type GameVersionRecord, type LoadedPlugin } from './types.js';

/**
 * 插件运行时注册表。
 *
 * 关键点：缓存按 `游戏@版本` 存，一张桌锁哪个版本就永远拿哪个实例。
 * 发布新版本只是新增一个 key，正在跑的老桌完全不受影响。
 */
export class PluginHost {
  private readonly loaded = new Map<string, LoadedPlugin>();
  private readonly active = new Map<string, GameVersionRecord>();

  constructor(
    private readonly store: Store,
    readonly storageRoot: string,
  ) {}

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

  async load(record: GameVersionRecord): Promise<LoadedPlugin> {
    const key = `${record.gameId}@${record.version}`;
    const cached = this.loaded.get(key);
    if (cached) return cached;

    const entry = path.join(record.dir, 'server.js');
    let module: Record<string, unknown>;
    try {
      module = (await import(`${pathToFileURL(entry).href}?v=${record.hash}`)) as Record<
        string,
        unknown
      >;
    } catch (error) {
      throw new PluginError('load_failed', `加载 ${key} 失败：${(error as Error).message}`);
    }

    const plugin = (module.default ?? module.plugin) as GamePlugin<any> | undefined;
    if (
      !plugin ||
      typeof plugin.createState !== 'function' ||
      typeof plugin.view !== 'function' ||
      !plugin.states ||
      !plugin.actions
    ) {
      throw new PluginError('invalid_module', `${key} 的 server.js 没有导出合法的 GamePlugin`);
    }

    const loaded: LoadedPlugin = {
      gameId: record.gameId,
      version: record.version,
      manifest: record.manifest,
      plugin,
      dir: record.dir,
    };
    this.loaded.set(key, loaded);
    return loaded;
  }

  get(gameId: string, version: string): LoadedPlugin | undefined {
    return this.loaded.get(`${gameId}@${version}`);
  }

  /** 桌子里锁定的版本可能不是 active（老桌），这里按需从库里补加载 */
  async ensure(gameId: string, version: string): Promise<LoadedPlugin> {
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

  invalidate(gameId: string, version: string): void {
    this.loaded.delete(`${gameId}@${version}`);
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

    const updated: GameVersionRecord = {
      ...record,
      status: 'active',
      activatedAt: Date.now(),
    };
    this.active.set(gameId, updated);
    return updated;
  }
}
