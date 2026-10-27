import type { GameClient } from '@platform/sdk';

const cache = new Map<string, Promise<GameClient>>();

/**
 * 运行时加载插件前端产物。
 *
 * URL 里带版本号，所以：
 *   - 发新版 = 换 URL，浏览器缓存不会串
 *   - 老桌锁定老版本，继续加载老 URL
 * 产物是自包含 ESM，不依赖 React，也不需要 import map。
 */
export function loadGameClient(gameId: string, version: string): Promise<GameClient> {
  const url = `/plugins/${encodeURIComponent(gameId)}/${encodeURIComponent(version)}/client.js`;
  const cached = cache.get(url);
  if (cached) return cached;

  const loading = import(/* @vite-ignore */ url).then(
    (module: { default?: GameClient; client?: GameClient }) => {
      const client = module.default ?? module.client;
      if (!client || typeof client.mount !== 'function') {
        throw new Error(`${gameId}@${version} 的 client.js 没有导出 mount/update/unmount`);
      }
      return client;
    },
  );

  cache.set(url, loading);
  loading.catch(() => cache.delete(url));
  return loading;
}
