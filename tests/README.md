# Proxy Regression Tests

## Run

```bash
node tests/proxy-regression.mjs
```

## What it covers

- JSON upstream → Chat Completions conversion (`responsesToCompletions`)
- Non-stream request with upstream SSE fallback assembly (`assembleSSE`)
- Stream request SSE conversion (`convertStreamChunk`) including:
  - output text
  - content_part
  - reasoning summary part
  - tool call arguments deltas + done
  - finish reason
- Auth guard (missing Authorization -> 401)
- Request body validation (missing messages -> 400)
- Upstream host whitelist enforcement (non-allowed host -> 400)

## Notes

- Test script launches a mock upstream server and a temporary proxy instance on port `3091`.
- It does not touch your production proxy on `3088`.
