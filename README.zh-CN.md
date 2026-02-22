# responses2chat-proxy

[English](./README.md) | [简体中文](./README.zh-CN.md)

一个轻量级 Node.js 中转代理，用于把 **OpenAI Chat Completions** 请求桥接到上游 **Responses API** 风格提供商，并重点兼容以下场景：

- 多轮工具调用（tool call loop）
- SSE 流式事件转换
- 推理内容（reasoning）透传
- 请求校验与上游安全加固

## 功能特性

- Chat Completions → Responses 请求转换
- Responses → Chat Completions 响应转换
- 支持流式与非流式两种模式
- 基于 `call_id` / `item_id` 的工具调用映射，提升多步工具链路稳定性
- 流式与非流式路径统一支持 `reasoning_content`
- 非流式请求遇到上游 SSE 时可自动组装回标准 JSON
- 上游主机白名单限制（缓解 SSRF 风险）
- 上游请求超时保护
- 标准化错误 JSON 返回
- SSE 保活注释（keepalive comment）降低“假死”体感

## 项目结构

- `proxy.mjs`：主代理实现
- `start-prod.sh`：生产环境启动脚本
- `PROD_ENV.example`：生产环境变量示例
- `README-PROD.md`：生产部署说明
- `tests/proxy-regression.mjs`：回归测试脚本

## 快速开始

```bash
cd /root/completions-proxy
node proxy.mjs
```

健康检查：

```bash
curl -s http://localhost:3088/health
```

## 怎么用（重点）

代理要求请求路径是下面这种格式：

```text
POST http://127.0.0.1:3088/<上游-base>/v1/chat/completions
```

其中 `<上游-base>` 是你真实上游的 origin（可带前缀路径），例如：

- `https://api.example.com`
- `https://api.example.com/openai`

### cURL 示例

```bash
curl -s http://127.0.0.1:3088/https://api.example.com/v1/chat/completions \
  -H "Authorization: Bearer <YOUR_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.3-codex",
    "messages": [{"role":"user","content":"你好"}],
    "stream": false
  }'
```

### 客户端 baseURL 写法

如果你的 SDK 会自动补 `.../chat/completions`，就用：

- `http://127.0.0.1:3088/https://api.example.com`

如果你的 SDK 固定补 `.../v1/chat/completions`，就用：

- `http://127.0.0.1:3088/https://api.example.com/v1`

两种都要保证：API Key 放在调用方请求头 `Authorization` 里。

## 生产运行

```bash
cd /root/completions-proxy
nohup ./start-prod.sh >/tmp/proxy-launch.log 2>&1 &
```

## 环境变量

- `PORT`（默认：`3088`）
- `REQUEST_TIMEOUT_MS`（默认：`90000`）
- `UPSTREAM_TIMEOUT_MS`（兼容旧变量，可选）
- `ALLOWED_UPSTREAM_HOSTS`（默认：`api.example.com`）
- `PROXY_LOG`（默认：`/tmp/proxy.log`）

## 运行回归测试

```bash
node tests/proxy-regression.mjs
```

## 安全说明

- 仅允许 `ALLOWED_UPSTREAM_HOSTS` 中的上游主机被转发。
- API Key 应通过调用方 `Authorization` 头传入，不要硬编码在仓库中。

## 路线图

- 补充更多 SSE 事件兼容覆盖
- 可选 metrics 指标端点
- 可选结构化 JSON 日志

## 许可证

MIT License，详见 [LICENSE](./LICENSE)。
