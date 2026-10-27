import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import type { GameManifest, GamePlugin } from '@platform/sdk';
import type { Store } from '../store.js';
import { buildPlugin } from './build.js';
import type { PluginHost } from './host.js';
import { smokePlugin } from './smoke.js';
import { assertApiCompatible, PluginError, type GameVersionRecord } from './types.js';

const manifestSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,31}$/, 'id 只能用小写字母/数字/连字符'),
  name: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+$/, 'version 必须是 semver，如 1.0.0'),
  apiVersion: z.string().min(1),
  players: z.object({ min: z.number().int().min(1), max: z.number().int().min(1) }),
  modes: z.array(z.enum(['realtime', 'turnbased'])).min(1),
  tags: z.array(z.string()).default([]),
  estimatedMinutes: z.number().int().min(1).max(600),
});

export interface PublishDeps {
  store: Store;
  host: PluginHost;
  storageRoot: string;
  log?: (message: string) => void;
}

export interface PublishOptions {
  activate?: boolean;
  /** 开发模式：允许同版本覆盖。生产环境必须升版本号，否则会把老桌的规则换掉 */
  allowReplace?: boolean;
}

export async function readManifest(sourceDir: string): Promise<GameManifest> {
  let raw: string;
  try {
    raw = await readFile(path.join(sourceDir, 'manifest.json'), 'utf8');
  } catch {
    throw new PluginError('missing_manifest', '缺少 manifest.json');
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new PluginError('bad_manifest', 'manifest.json 不是合法 JSON');
  }

  const parsed = manifestSchema.safeParse(json);
  if (!parsed.success) {
    throw new PluginError('bad_manifest', `manifest.json 不合法：${parsed.error.issues[0]?.message}`);
  }
  return parsed.data as GameManifest;
}

/**
 * 发布流水线：校验 manifest → 编译 → 静态检查 → 冒烟 → 落盘 → 入库 → （可选）激活。
 * 任何一步失败都不会影响正在跑的版本。
 */
export async function publishDirectory(
  deps: PublishDeps,
  sourceDir: string,
  options: PublishOptions = {},
): Promise<GameVersionRecord> {
  const manifest = await readManifest(sourceDir);
  assertApiCompatible(manifest.apiVersion);

  const targetDir = path.join(deps.storageRoot, manifest.id, manifest.version);
  const existing = await deps.store.getGameVersion(manifest.id, manifest.version);

  const tmpRoot = path.join(deps.storageRoot, '.tmp');
  await mkdir(tmpRoot, { recursive: true });
  const tmpDir = await mkdtemp(path.join(tmpRoot, `${manifest.id}-${manifest.version}-`));

  try {
    const built = await buildPlugin(sourceDir, tmpDir);

    const replacing = existing !== undefined && existing.hash !== built.hash;
    if (replacing && !options.allowReplace && existing?.status !== 'failed') {
      throw new PluginError(
        'version_conflict',
        `版本 ${manifest.version} 已存在且内容不同，请升版本号再发`,
      );
    }

    // 冒烟：把**编译产物**真的 import 进来跑一局，而不是信任源码
    const module = (await import(pathToFileURL(built.serverJs).href)) as Record<string, unknown>;
    const plugin = (module.default ?? module.plugin) as GamePlugin<any> | undefined;
    if (!plugin) throw new PluginError('invalid_module', 'server.js 没有默认导出 GamePlugin');

    const report = smokePlugin(plugin);

    await rm(targetDir, { recursive: true, force: true });
    await mkdir(path.dirname(targetDir), { recursive: true });
    await rename(tmpDir, targetDir);
    await writeFile(
      path.join(targetDir, 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf8',
    );

    const record: GameVersionRecord = {
      gameId: manifest.id,
      version: manifest.version,
      apiVersion: manifest.apiVersion,
      manifest,
      dir: targetDir,
      hash: built.hash,
      status: existing?.status ?? 'pending',
      error: null,
      createdAt: existing?.createdAt ?? Date.now(),
      activatedAt: existing?.activatedAt ?? null,
    };

    await deps.store.upsertGameVersion(record);
    deps.host.invalidate(manifest.id, manifest.version);

    deps.log?.(`插件 ${manifest.id}@${manifest.version} 已发布（冒烟 ${report.steps} 步，hash ${built.hash}）`);

    if (options.activate) {
      return deps.host.setActive(manifest.id, manifest.version);
    }
    return record;
  } catch (error) {
    const failure =
      error instanceof PluginError
        ? error
        : new PluginError('publish_failed', (error as Error).message ?? String(error));

    await deps.store
      .markVersionFailed(manifest.id, manifest.version, `${failure.code}: ${failure.message}`)
      .catch(() => undefined);

    throw failure;
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** 启动时把仓库里的开发用游戏全部发一遍（内容没变则跳过编译后的落盘） */
export async function publishLocalGames(
  deps: PublishDeps,
  gamesDir: string,
): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(gamesDir);
  } catch {
    return;
  }

  for (const entry of entries) {
    const sourceDir = path.join(gamesDir, entry);
    try {
      await publishDirectory(deps, sourceDir, { activate: true, allowReplace: true });
    } catch (error) {
      const message = error instanceof PluginError ? `${error.code}: ${error.message}` : String(error);
      deps.log?.(`跳过 ${entry}：${message}`);
    }
  }
}
