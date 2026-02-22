# responses2chat-proxy 生产运行建议

## 1) 环境变量（推荐）

可参考 `PROD_ENV.example`：

- `PORT=3088`
- `REQUEST_TIMEOUT_MS=90000`
- `ALLOWED_UPSTREAM_HOSTS=api.example.com`
- `PROXY_LOG=/tmp/proxy.log`

> 兼容说明：程序同时支持 `UPSTREAM_TIMEOUT_MS`（旧名）与 `REQUEST_TIMEOUT_MS`。

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

## 4) 请求路径规则（关键）

请求必须走：

```text
http://127.0.0.1:3088/<upstream-base>/v1/chat/completions
```

例如：

```text
http://127.0.0.1:3088/https://api.example.com/v1/chat/completions
```

## 5) 白名单规则提醒

当前代理已做白名单限制：
- 仅 `ALLOWED_UPSTREAM_HOSTS` 里的 host 可被转发
- 默认仅允许 `api.example.com`

若未来要允许新上游（例如灰度环境），请显式添加到白名单：

```bash
ALLOWED_UPSTREAM_HOSTS=api.example.com,api-staging.example.com
```
