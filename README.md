# responses2chat-proxy

[English](./README.md) | [简体中文](./README.zh-CN.md)

A lightweight Node.js proxy that bridges **OpenAI Chat Completions** requests to upstream **Responses API** style providers, with strong compatibility for:

- multi-turn tool calls
- SSE streaming conversion
- reasoning content passthrough
- request validation and upstream hardening

## Features

- Chat Completions → Responses request conversion
- Responses → Chat Completions response conversion
- Stream and non-stream mode support
- Tool call mapping (`call_id` / `item_id`) for robust multi-step loops
- Reasoning extraction (`reasoning_content`) in both stream/non-stream paths
- SSE fallback assembly when upstream returns SSE for non-stream request
- Upstream host allowlist guard (SSRF mitigation)
- Upstream timeout guard
- Standardized error JSON responses

## Project Structure

- `proxy.mjs` - main proxy implementation
- `start-prod.sh` - production startup script
- `PROD_ENV.example` - recommended production env values
- `README-PROD.md` - production deployment notes
- `tests/proxy-regression.mjs` - regression test suite

## Quick Start

```bash
cd /root/completions-proxy
node proxy.mjs
```

Health check:

```bash
curl -s http://localhost:3088/health
```

## How to Use (important)

The proxy expects this request path format:

```text
POST http://127.0.0.1:3088/<upstream-base>/v1/chat/completions
```

Where `<upstream-base>` is your real upstream origin, for example:

- `https://api.example.com`
- `https://api.example.com/openai`

### cURL example

```bash
curl -s http://127.0.0.1:3088/https://api.example.com/v1/chat/completions \
  -H "Authorization: Bearer <YOUR_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.3-codex",
    "messages": [{"role":"user","content":"hello"}],
    "stream": false
  }'
```

### Client `baseURL` examples

If your SDK sends `.../chat/completions`, use:

- `http://127.0.0.1:3088/https://api.example.com`

If your SDK forces `.../v1/chat/completions`, use:

- `http://127.0.0.1:3088/https://api.example.com/v1`

In both cases, keep API key in the caller-side `Authorization` header.

## Production Run

```bash
cd /root/completions-proxy
nohup ./start-prod.sh >/tmp/proxy-launch.log 2>&1 &
```

## Environment Variables

- `PORT` (default: `3088`)
- `REQUEST_TIMEOUT_MS` (default: `90000`)
- `UPSTREAM_TIMEOUT_MS` (legacy alias; optional)
- `ALLOWED_UPSTREAM_HOSTS` (default: `api.example.com`)
- `PROXY_LOG` (default: `/tmp/proxy.log`)

## Run Regression Tests

```bash
node tests/proxy-regression.mjs
```

## Security Notes

- Only upstream hosts in `ALLOWED_UPSTREAM_HOSTS` are permitted.
- Keep API keys in caller-side `Authorization` headers; do not hardcode keys into this repository.

## Roadmap

- More SSE event compatibility coverage
- Optional metrics endpoint
- Optional structured JSON logs

## License

MIT License. See [LICENSE](./LICENSE).
