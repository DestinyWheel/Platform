import type { GameManifest, GamePlugin } from '@platform/sdk';

/** 宿主支持的插件 API 大版本。插件 manifest.apiVersion 必须与之匹配。 */
export const HOST_API_VERSION = '1.0.0';

export type VersionStatus = 'pending' | 'active' | 'retired' | 'failed' | 'disabled';

export interface GameVersionRecord {
  gameId: string;
  version: string;
  apiVersion: string;
  manifest: GameManifest;
  dir: string;
  hash: string;
  status: VersionStatus;
  error: string | null;
  createdAt: number;
  activatedAt: number | null;
}

/** 已经在内存里跑起来的插件实例 */
export interface LoadedPlugin {
  gameId: string;
  version: string;
  manifest: GameManifest;
  plugin: GamePlugin<any>;
  dir: string;
}

export class PluginError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PluginError';
  }
}

export function assertApiCompatible(range: string): void {
  const hostMajor = Number(HOST_API_VERSION.split('.')[0]);
  const matched = /^\^?(\d+)/.exec(range.trim());
  if (!matched) {
    throw new PluginError('bad_api_version', `apiVersion 格式不对：${range}`);
  }
  if (Number(matched[1]) !== hostMajor) {
    throw new PluginError(
      'api_version_mismatch',
      `插件要求 API ${range}，宿主是 ${HOST_API_VERSION}`,
    );
  }
}
