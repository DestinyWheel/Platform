import { createServer } from 'node:http';
import { buildApp } from './app.js';

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '127.0.0.1';
/** 配了证书就是 HTTPS：Fastify 那边会带 https 选项起来 */
const tls = Boolean(process.env.TLS_CERT && process.env.TLS_KEY);
const scheme = tls ? 'https' : 'http';

const app = await buildApp();

try {
  await app.listen({ port, host });
  app.log.info(`桌游平台服务已启动： ${scheme}://${host}:${port}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

/**
 * 顺手开一个 80 端口做跳转：直接敲 IP 的人也能被带到 https，
 * 不然浏览器默认走 80，会看到"无法访问"而不是证书警告。
 */
const redirectPort = Number(process.env.HTTP_REDIRECT_PORT ?? 0);
let redirect: ReturnType<typeof createServer> | null = null;
if (tls && Number.isInteger(redirectPort) && redirectPort > 0) {
  redirect = createServer((request, response) => {
    const hostname = (request.headers.host ?? '').replace(/:\d+$/, '');
    response.writeHead(301, { location: `https://${hostname}${request.url ?? '/'}` });
    response.end();
  });
  redirect.on('error', (err) => app.log.error(err, 'HTTP 跳转端口起不来，https 本身不受影响'));
  redirect.listen(redirectPort, host, () => {
    app.log.info(`HTTP → HTTPS 跳转已启动： ${host}:${redirectPort}`);
  });
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    app.log.info(`收到 ${signal}，正在关闭…`);
    const closed: Promise<unknown>[] = [app.close()];
    if (redirect) {
      closed.push(
        new Promise((resolve) => {
          redirect!.close(resolve);
        }),
      );
    }
    Promise.all(closed)
      .then(() => process.exit(0))
      .catch((err) => {
        app.log.error(err);
        process.exit(1);
      });
  });
}
