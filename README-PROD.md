# completions-proxy 生产运行建议

## 1) 环境变量（推荐）

可参考 `PROD_ENV.example`：

- `PORT=3088`
- `REQUEST_TIMEOUT_MS=90000`
- `ALLOWED_UPSTREAM_HOSTS=api.infiniteai.cc`
- `PROXY_LOG=/tmp/proxy.log`

## 2) 启动方式

```bash
cd /root/completions-proxy
./start-prod.sh
```

或后台运行：

```bash
cd /root/completions-proxy
nohup ./start-prod.sh >/tmp/proxy-launch.log 2>&1 &
```

## 3) 健康检查

```bash
curl -s http://localhost:3088/health
```

返回 `ok` 即正常。

## 4) 规则提醒

当前代理已做白名单限制：
- 仅 `ALLOWED_UPSTREAM_HOSTS` 里的 host 可被转发
- 默认仅允许 `api.infiniteai.cc`

若未来要允许新上游（例如灰度环境），请显式添加到白名单：

```bash
ALLOWED_UPSTREAM_HOSTS=api.infiniteai.cc,api-staging.example.com
```
