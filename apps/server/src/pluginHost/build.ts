import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { PluginError } from './types.js';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

/**
 * 插件包只带源码，不带 node_modules —— 依赖由平台统一提供、编译时打进去。
 * 这样插件作者不用管版本，也避免了"每个插件一份 zod"。
 */
const NODE_PATHS = [
  path.join(REPO_ROOT, 'node_modules'),
  path.join(REPO_ROOT, 'apps', 'server', 'node_modules'),
];

/**
 * 禁止出现的调用。
 * 注意：这不是"防恶意代码"（插件由内部人员上传），而是**保证可回放**——
 * 一旦用了全局随机或系统时钟，同一份动作日志就再也重放不出同一个结果。
 */
const FORBIDDEN: { pattern: RegExp; label: string }[] = [
  { pattern: /\bMath\.random\s*\(/, label: 'Math.random()' },
  { pattern: /\bDate\.now\s*\(/, label: 'Date.now()' },
  { pattern: /\bnew\s+Date\s*\(\s*\)/, label: 'new Date()' },
  { pattern: /\bperformance\.now\s*\(/, label: 'performance.now()' },
  { pattern: /\brequire\s*\(/, label: 'require()' },
  { pattern: /from\s*["']node:(fs|net|http|https|child_process|worker_threads)["']/, label: 'node 系统模块' },
  { pattern: /\bprocess\.(env|exit|argv)/, label: 'process.*' },
];

const SERVER_ENTRIES = ['src/server.ts', 'src/server.js', 'server.ts', 'server.js'];
const CLIENT_ENTRIES = ['src/client.ts', 'src/client.tsx', 'src/client.js', 'client.ts', 'client.js'];

export interface BuildResult {
  serverJs: string;
  clientJs: string;
  hash: string;
}

async function firstExisting(sourceDir: string, candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    try {
      await readFile(path.join(sourceDir, candidate));
      return path.join(sourceDir, candidate);
    } catch {
      // 继续找下一个
    }
  }
  return null;
}

export function assertDeterministic(code: string): void {
  const hits = FORBIDDEN.filter((rule) => rule.pattern.test(code)).map((rule) => rule.label);
  if (hits.length > 0) {
    throw new PluginError(
      'nondeterministic',
      `插件代码里出现了不允许的调用：${hits.join('、')}。` +
        '随机数用 ctx.rng()，时间用 ctx.now，副作用用 ctx.emit()。',
    );
  }
}

/** 只扫作者自己写的源码：依赖库里的 Date.now 不该算到插件头上 */
async function collectSources(dir: string): Promise<string> {
  let code = '';
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return code;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      code += await collectSources(full);
    } else if (/\.(ts|tsx|js|mjs|cjs|jsx)$/.test(entry.name)) {
      code += await readFile(full, 'utf8');
    }
  }
  return code;
}

/**
 * 把插件源码编译成两个自包含的 ESM 文件：
 *   server.js —— Node 端，打进 @platform/sdk（插件不能依赖宿主的 node_modules）
 *   client.js —— 浏览器端，不依赖 React 或任何 import map
 */
export async function buildPlugin(sourceDir: string, outDir: string): Promise<BuildResult> {
  const serverEntry = await firstExisting(sourceDir, SERVER_ENTRIES);
  const clientEntry = await firstExisting(sourceDir, CLIENT_ENTRIES);
  if (!serverEntry) throw new PluginError('missing_server', '缺少服务端入口 src/server.ts');
  if (!clientEntry) throw new PluginError('missing_client', '缺少客户端入口 src/client.ts');

  await mkdir(outDir, { recursive: true });
  const serverJs = path.join(outDir, 'server.js');
  const clientJs = path.join(outDir, 'client.js');

  try {
    await build({
      entryPoints: [serverEntry],
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      outfile: serverJs,
      logLevel: 'silent',
      legalComments: 'none',
      nodePaths: NODE_PATHS,
    });

    await build({
      entryPoints: [clientEntry],
      bundle: true,
      platform: 'browser',
      format: 'esm',
      target: 'es2022',
      outfile: clientJs,
      logLevel: 'silent',
      legalComments: 'none',
      nodePaths: NODE_PATHS,
    });
  } catch (error) {
    throw new PluginError('build_failed', `编译失败：${(error as Error).message}`);
  }

  const serverCode = await readFile(serverJs, 'utf8');
  const clientCode = await readFile(clientJs, 'utf8');

  // 校验作者源码，而不是编译产物（产物里会有第三方库）
  assertDeterministic(await collectSources(path.join(sourceDir, 'src')));

  const hash = createHash('sha256')
    .update(serverCode)
    .update(clientCode)
    .digest('hex')
    .slice(0, 16);

  return { serverJs, clientJs, hash };
}
