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

## 生产运行

```bash
cd /root/completions-proxy
nohup ./start-prod.sh >/tmp/proxy-launch.log 2>&1 &
```

## 环境变量

- `PORT`（默认：`3088`）
- `REQUEST_TIMEOUT_MS`（默认：`90000`）
- `ALLOWED_UPSTREAM_HOSTS`（默认：`api.infiniteai.cc`）
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
