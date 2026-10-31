# 传输加密（自签证书）

站点用**自签证书**跑 HTTPS，没有域名，证书直接签给 IP。

## 现在的部署形态

```
浏览器 ──https(443)──> node (Fastify, TLS)  ──> 127.0.0.1 上的 PGlite / 插件 worker
浏览器 ──http(8080)───> 301 到 https
```

- `https://150.158.13.77/`：正常入口
- `http://150.158.13.77:8080/`：301 跳到 https，老书签不会失效
- 443/80 是特权端口，但服务**不用 root 跑**：systemd 里只给了 `CAP_NET_BIND_SERVICE`

## 证书

| 项 | 值 |
|---|---|
| 位置 | `/opt/boardgame/.certs/boardgame.crt`、`boardgame.key`（600，boardgame 属主） |
| 主体 | `CN=150.158.13.77` |
| SAN | `IP:150.158.13.77, IP:127.0.0.1, DNS:localhost` |
| 有效期 | 825 天 |
| 算法 | RSA 2048 / SHA-256 |

重新生成（换 IP、到期续签都走这个）：

```bash
cd /opt/boardgame/.certs
openssl req -x509 -newkey rsa:2048 -sha256 -days 825 -nodes \
  -keyout boardgame.key -out boardgame.crt \
  -subj '/CN=150.158.13.77' \
  -addext 'subjectAltName=IP:150.158.13.77,IP:127.0.0.1,DNS:localhost' \
  -addext 'basicConstraints=critical,CA:FALSE' \
  -addext 'keyUsage=critical,digitalSignature,keyEncipherment' \
  -addext 'extendedKeyUsage=serverAuth'
chown boardgame:boardgame boardgame.* && chmod 600 boardgame.key
systemctl restart boardgame
```

## 配置

`.env`：

```
PORT=443
HOST=0.0.0.0
TLS_CERT=/opt/boardgame/.certs/boardgame.crt
TLS_KEY=/opt/boardgame/.certs/boardgame.key
HTTP_REDIRECT_PORT=8080
```

- 没有 `TLS_CERT`/`TLS_KEY` 时服务退回普通 HTTP（本地开发和测试就是这条路，不用改代码）
- 有证书时自动加 `Strict-Transport-Security: max-age=31536000`
- 前端不用改：接口都是相对路径，WebSocket 按 `location.protocol` 自动选 `ws` / `wss`

## 让浏览器认这张证书

自签证书不装不进根证书库，浏览器就会警告一次。装法（Windows，当前用户，不用管理员）：

```powershell
certutil -addstore -user Root boardgame.crt
```

或者在「双击 .crt → 安装证书 → 当前用户 → 把证书放入下列存储 → 受信任的根证书颁发机构」。

装完 Chrome / Edge 直接用系统证书库，就绿锁了；Firefox 有独立证书库，要在设置里单独导入。

## 什么时候换掉它

有域名之后就该换正规证书，配置可以更简单：

```caddy
gang.example.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:8080
}
```

Caddy 自动签发 + 自动续期，然后删掉 `.env` 里的 `TLS_CERT` / `TLS_KEY`，把 `PORT` 改回 8080、
`HTTP_REDIRECT_PORT` 去掉，让 Caddy 去占 443。
