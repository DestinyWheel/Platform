/**
 * 插件 worker 的引导文件（纯 JS，Node 原生就能跑）。
 *
 * 为什么需要这一层：真正的入口是 worker.ts，但 Node 的模块加载钩子是**按线程**注册的——
 * 父线程用 tsx 起的服务，不会让子线程认得 `.ts`；tsx 4.2x 之后直接透传 `execArgv` 也不再生效。
 * 所以在 worker 线程里先调一次 tsx 的 `register()`，再去 import 真正的入口。
 *
 * 这一层刻意写成 .mjs：它自己必须能在没有 loader 的情况下被加载。
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { register } from 'tsx/esm/api';

register();

const tsEntry = new URL('./worker.ts', import.meta.url);
const entry = existsSync(fileURLToPath(tsEntry)) ? tsEntry : new URL('./worker.js', import.meta.url);

await import(entry.href);
