import { buildApp } from './app.js';

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '127.0.0.1';

const app = await buildApp();

try {
  await app.listen({ port, host });
  app.log.info(`桌游平台服务已启动： http://${host}:${port}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
