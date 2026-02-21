import http from 'node:http';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const PROXY_PORT = 3091;

function startMockUpstream() {
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/responses') {
      res.writeHead(404);
      return res.end('not found');
    }

    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');

    // Case 1: standard JSON response
    if (!body.stream && body.model === 'json-case') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        id: 'resp_json_case',
        model: 'json-case',
        output: [
          { type: 'message', content: [{ type: 'output_text', text: 'JSON_TEXT' }] },
          { type: 'reasoning', content: [{ type: 'reasoning_text', text: 'JSON_REASON' }] },
          { type: 'function_call', call_id: 'call_json_1', name: 'sum', arguments: { a: 1, b: 2 } },
        ],
        usage: { input_tokens: 11, output_tokens: 22 },
      }));
    }

    // Case 2: non-stream request but upstream returns SSE
    if (!body.stream && body.model === 'sse-fallback') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"type":"response.output_text.delta","delta":"A"}\n\n');
      res.write('data: {"type":"response.content_part.added","part":{"type":"text","text":"B"}}\n\n');
      res.write('data: {"type":"response.reasoning_summary_part.added","part":{"type":"text","text":"R"}}\n\n');
      res.write('data: {"type":"response.output_item.added","item":{"type":"function_call","id":"item_sse_1","call_id":"call_sse_1","name":"lookup"}}\n\n');
      res.write('data: {"type":"response.function_call_arguments.delta","call_id":"call_sse_1","delta":"{\\"q\\":\\"x\\""}\n\n');
      res.write('data: {"type":"response.function_call_arguments.done","call_id":"call_sse_1","arguments":"{\\"q\\":\\"xyz\\"}"}\n\n');
      res.write('data: {"type":"response.done","response":{"id":"resp_sse_case","model":"sse-fallback","usage":{"input_tokens":3,"output_tokens":4}}}\n\n');
      res.write('data: [DONE]\n\n');
      return res.end();
    }

    // Case 3: stream request with tool+reasoning+content
    if (body.stream && body.model === 'stream-case') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"type":"response.created"}\n\n');
      res.write('data: {"type":"response.output_item.done","item":{"type":"message","content":[{"type":"output_text","text":""}]}}\n\n');
      res.write('data: {"type":"response.output_text.delta","delta":"HELLO_"}\n\n');
      res.write('data: {"type":"response.content_part.added","part":{"type":"text","text":"WORLD"}}\n\n');
      res.write('data: {"type":"response.reasoning_summary_part.added","part":{"type":"text","text":"WHY"}}\n\n');
      res.write('data: {"type":"response.output_item.added","item":{"type":"function_call","id":"item_stream_1","call_id":"call_stream_1","name":"toolA"}}\n\n');
      res.write('data: {"type":"response.function_call_arguments.delta","call_id":"call_stream_1","delta":"{\\"k\\":"}\n\n');
      res.write('data: {"type":"response.function_call_arguments.done","call_id":"call_stream_1","arguments":"{\\"k\\":1}"}\n\n');
      res.write('data: {"type":"response.completed"}\n\n');
      res.write('data: [DONE]\n\n');
      return res.end();
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'resp_default',
      model: body.model || 'unknown',
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'DEFAULT' }] }],
    }));
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, port: addr.port });
    });
  });
}

async function waitProxyReady(url, ms = 8000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {}
    await delay(200);
  }
  throw new Error('Proxy did not become ready in time');
}

async function run() {
  const { server: upstream, port: upstreamPort } = await startMockUpstream();
  const proxy = spawn('node', ['proxy.mjs'], {
    cwd: '/root/completions-proxy',
    env: {
      ...process.env,
      PORT: String(PROXY_PORT),
      ALLOWED_UPSTREAM_HOSTS: '127.0.0.1,localhost,api.infiniteai.cc',
      REQUEST_TIMEOUT_MS: '15000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  proxy.stdout.on('data', (d) => process.stdout.write(`[proxy] ${d}`));
  proxy.stderr.on('data', (d) => process.stderr.write(`[proxy-err] ${d}`));

  const baseProxyPath = `http://127.0.0.1:${PROXY_PORT}/http://127.0.0.1:${upstreamPort}/v1/chat/completions`;

  try {
    await waitProxyReady(`http://127.0.0.1:${PROXY_PORT}/health`);

    // Test 1: JSON path
    {
      const r = await fetch(baseProxyPath, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test_key',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'json-case',
          messages: [{ role: 'user', content: 'hi' }],
          stream: false,
        }),
      });
      assert.equal(r.status, 200, 'json-case status');
      const j = await r.json();
      assert.equal(j.choices?.[0]?.message?.content, 'JSON_TEXT');
      assert.equal(j.choices?.[0]?.message?.reasoning_content, 'JSON_REASON');
      assert.equal(j.choices?.[0]?.finish_reason, 'tool_calls');
      assert.equal(j.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments, '{"a":1,"b":2}');
      console.log('✅ test1 json-case passed');
    }

    // Test 2: SSE fallback assembly path
    {
      const r = await fetch(baseProxyPath, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test_key',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'sse-fallback',
          messages: [{ role: 'user', content: 'hi' }],
          stream: false,
        }),
      });
      assert.equal(r.status, 200, 'sse-fallback status');
      const j = await r.json();
      assert.equal(j.choices?.[0]?.message?.content, 'AB');
      assert.equal(j.choices?.[0]?.message?.reasoning_content, 'R');
      assert.equal(j.choices?.[0]?.message?.tool_calls?.[0]?.function?.name, 'lookup');
      assert.equal(j.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments, '{"q":"xyz"}');
      console.log('✅ test2 sse-fallback passed');
    }

    // Test 3: stream conversion path
    {
      const r = await fetch(baseProxyPath, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test_key',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'stream-case',
          messages: [{ role: 'user', content: 'hi' }],
          stream: true,
        }),
      });
      assert.equal(r.status, 200, 'stream-case status');
      const t = await r.text();
      assert.ok(t.includes('"reasoning_content":"WHY"'), 'stream reasoning present');
      assert.ok(t.includes('"tool_calls"'), 'stream tool_calls present');
      assert.ok(t.includes('"finish_reason":"tool_calls"'), 'stream finish reason tool_calls');
      assert.ok(t.includes('data: [DONE]'), 'stream DONE present');
      console.log('✅ test3 stream-case passed');
    }

    // Test 4: missing auth guard
    {
      const r = await fetch(baseProxyPath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'json-case', messages: [{ role: 'user', content: 'hi' }] }),
      });
      assert.equal(r.status, 401);
      const j = await r.json();
      assert.equal(j.error?.message, 'Missing Authorization header');
      console.log('✅ test4 auth-guard passed');
    }

    // Test 5: request body validation
    {
      const r = await fetch(baseProxyPath, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test_key',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model: 'x' }),
      });
      assert.equal(r.status, 400);
      const j = await r.json();
      assert.equal(j.error?.code, 'INVALID_REQUEST_BODY');
      console.log('✅ test5 body-validation passed');
    }

    // Test 6: upstream host whitelist block
    {
      const blocked = `http://127.0.0.1:${PROXY_PORT}/http://example.com/v1/chat/completions`;
      const r = await fetch(blocked, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test_key',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'hi' }] }),
      });
      assert.equal(r.status, 400);
      const j = await r.json();
      assert.equal(j.error?.code, 'INVALID_UPSTREAM_PATH');
      console.log('✅ test6 host-whitelist passed');
    }

    console.log('\n🎉 All regression tests passed.');
  } finally {
    upstream.close();
    proxy.kill('SIGTERM');
  }
}

run().catch((err) => {
  console.error('\n❌ Regression tests failed:', err);
  process.exit(1);
});
