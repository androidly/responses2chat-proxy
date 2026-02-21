import http from 'node:http';
import https from 'node:https';

const PORT = process.env.PORT || 3088;

// --- Conversion: Chat Completions request → Responses API request ---
function completionsToResponses(body) {
  const resp = { model: body.model, input: [] };

  if (body.messages) {
    for (const msg of body.messages) {
      if (msg.role === 'system') {
        const text = typeof msg.content === 'string' ? msg.content
          : Array.isArray(msg.content) ? msg.content.filter(c => c.type === 'text').map(c => c.text).join('') : '';
        resp.instructions = (resp.instructions || '') + text;
      } else if (msg.role === 'tool') {
        // Tool results: convert to Responses API format
        resp.input.push({
          type: 'function_call_output',
          call_id: msg.tool_call_id || '',
          output: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
        });
      } else if (msg.role === 'assistant' && msg.tool_calls) {
        // Assistant message with tool calls: emit function_call items
        if (msg.content) {
          resp.input.push({ role: 'assistant', content: typeof msg.content === 'string' ? msg.content : '' });
        }
        for (const tc of msg.tool_calls) {
          resp.input.push({
            type: 'function_call',
            name: tc.function?.name || '',
            arguments: tc.function?.arguments || '',
            call_id: tc.id || '',
          });
        }
      } else {
        const item = { role: msg.role === 'assistant' ? 'assistant' : 'user' };
        if (typeof msg.content === 'string') {
          item.content = msg.content;
        } else if (Array.isArray(msg.content)) {
          const hasImage = msg.content.some(c => c.type === 'image_url');
          if (hasImage) {
            item.content = msg.content.map(c => {
              if (c.type === 'text') return { type: 'input_text', text: c.text };
              if (c.type === 'image_url') return { type: 'input_image', image_url: c.image_url.url };
              return c;
            });
          } else {
            item.content = msg.content.filter(c => c.type === 'text').map(c => c.text).join('');
          }
        } else {
          item.content = msg.content ?? '';
        }
        if (item.content == null) item.content = '';
        resp.input.push(item);
      }
    }
  }

  if (body.temperature != null) resp.temperature = body.temperature;
  if (body.top_p != null) resp.top_p = body.top_p;
  if (body.max_tokens != null) resp.max_output_tokens = body.max_tokens;
  if (body.max_completion_tokens != null) resp.max_output_tokens = body.max_completion_tokens;
  if (body.tools) {
    resp.tools = body.tools.map(t => {
      if (t.type === 'function' && t.function) {
        return {
          type: 'function',
          name: t.function.name,
          description: t.function.description,
          parameters: t.function.parameters,
        };
      }
      return t;
    });
  }
  if (body.tool_choice) resp.tool_choice = body.tool_choice;
  if (body.stream) resp.stream = body.stream;

  return resp;
}

// --- Conversion: Responses API response → Chat Completions response ---
function responsesToCompletions(respBody, model) {
  if (respBody.object === 'chat.completion' || respBody.choices) return respBody;

  let outputContent = '';
  let toolCalls = [];
  let finishReason = 'stop';

  if (respBody.output) {
    for (const item of respBody.output) {
      if (item.type === 'message') {
        for (const c of (item.content || [])) {
          if (c.type === 'output_text') outputContent += c.text;
        }
      } else if (item.type === 'function_call') {
        toolCalls.push({
          id: item.call_id || item.id,
          type: 'function',
          function: { name: item.name, arguments: item.arguments || '' },
        });
        finishReason = 'tool_calls';
      }
    }
  }

  const message = { role: 'assistant', content: outputContent || null };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;

  return {
    id: respBody.id || 'chatcmpl-proxy-' + Date.now(),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model || respBody.model || 'unknown',
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: respBody.usage ? {
      prompt_tokens: respBody.usage.input_tokens || 0,
      completion_tokens: respBody.usage.output_tokens || 0,
      total_tokens: (respBody.usage.input_tokens || 0) + (respBody.usage.output_tokens || 0),
    } : undefined,
  };
}

// --- Streaming state ---
function createStreamState(model) {
  return {
    id: 'chatcmpl-proxy-' + Date.now(),
    created: Math.floor(Date.now() / 1000),
    model,
    // Track multiple tool calls
    toolCalls: [],        // { index, id, name, started }
    currentToolIndex: -1,
    hasContent: false,
    finished: false,
  };
}

function makeChunk(state, delta, finishReason = null) {
  return {
    id: state.id,
    object: 'chat.completion.chunk',
    created: state.created,
    model: state.model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

// --- Streaming conversion ---
function convertStreamChunk(line, state) {
  // Handle event: lines (just skip, we parse from data:)
  if (line.startsWith('event:')) return null;
  if (!line.startsWith('data:')) return null;

  const data = line.slice(5).trim();
  if (data === '[DONE]') return 'data: [DONE]\n\n';

  let event;
  try { event = JSON.parse(data); } catch { return null; }

  // Already in Chat Completions format — pass through
  if (event.object === 'chat.completion.chunk') return `data: ${data}\n\n`;

  const out = [];

  switch (event.type) {
    // --- Text output ---
    case 'response.output_text.delta': {
      if (!state.hasContent) {
        state.hasContent = true;
        out.push(makeChunk(state, { role: 'assistant', content: '' }));
      }
      out.push(makeChunk(state, { content: event.delta || '' }));
      break;
    }

    case 'response.output_text.done': {
      // Final text — no action needed, we streamed deltas
      break;
    }

    // --- Function/tool calls ---
    case 'response.output_item.added': {
      if (event.item?.type === 'function_call') {
        const idx = state.toolCalls.length;
        const tc = {
          index: idx,
          id: event.item.call_id || event.item.id || 'call_' + Date.now() + '_' + idx,
          name: event.item.name || '',
          started: false,
        };
        state.toolCalls.push(tc);
        state.currentToolIndex = idx;
        console.log(`[STREAM] tool_call added: index=${idx} name=${tc.name} id=${tc.id}`);
      }
      break;
    }

    case 'response.function_call_arguments.delta': {
      const tc = state.toolCalls[state.currentToolIndex];
      if (!tc) {
        // No output_item.added received — create one on the fly
        const idx = state.toolCalls.length;
        const newTc = {
          index: idx,
          id: event.call_id || event.item_id || 'call_' + Date.now() + '_' + idx,
          name: event.name || '',
          started: false,
        };
        state.toolCalls.push(newTc);
        state.currentToolIndex = idx;
      }

      const activeTc = state.toolCalls[state.currentToolIndex];
      if (!activeTc.started) {
        activeTc.started = true;
        // Emit the tool call header
        out.push(makeChunk(state, {
          tool_calls: [{
            index: activeTc.index,
            id: activeTc.id,
            type: 'function',
            function: { name: activeTc.name, arguments: '' },
          }],
        }));
      }
      // Emit argument delta
      out.push(makeChunk(state, {
        tool_calls: [{
          index: activeTc.index,
          function: { arguments: event.delta || '' },
        }],
      }));
      break;
    }

    case 'response.function_call_arguments.done': {
      const tc = state.toolCalls[state.currentToolIndex];
      if (tc && !tc.started) {
        // Edge case: got done without any delta — emit full call at once
        tc.started = true;
        out.push(makeChunk(state, {
          tool_calls: [{
            index: tc.index,
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: event.arguments || '' },
          }],
        }));
      }
      console.log(`[STREAM] tool_call args done: index=${state.currentToolIndex}`);
      break;
    }

    // --- Completion ---
    case 'response.completed':
    case 'response.done': {
      if (!state.finished) {
        state.finished = true;
        const finishReason = state.toolCalls.length > 0 ? 'tool_calls' : 'stop';
        out.push(makeChunk(state, {}, finishReason));
        console.log(`[STREAM] response done, finish_reason=${finishReason}`);
      }
      break;
    }

    // --- Error from upstream ---
    case 'error': {
      console.error(`[STREAM-UPSTREAM-ERR] ${JSON.stringify(event.error || event)}`);
      // Send what we have and close
      if (!state.finished) {
        state.finished = true;
        const fr = state.toolCalls.length > 0 ? 'tool_calls' : 'stop';
        out.push(makeChunk(state, {}, fr));
      }
      break;
    }

    default: {
      // Log unhandled event types for debugging
      if (event.type) {
        console.log(`[STREAM] unhandled event.type=${event.type}`);
      }
      break;
    }
  }

  if (out.length === 0) return null;
  return out.map(c => `data: ${JSON.stringify(c)}\n\n`).join('');
}

// --- Parse upstream URL from request path ---
function parseUpstream(url) {
  const path = url.split('?')[0];
  const match = path.match(/^\/(https?:\/\/.+?)\/(?:v1\/)?chat\/completions$/);
  if (match) return { upstream: match[1], ok: true };

  const decoded = decodeURIComponent(path);
  const match2 = decoded.match(/^\/(https?:\/\/.+?)\/(?:v1\/)?chat\/completions$/);
  if (match2) return { upstream: match2[1], ok: true };

  return { upstream: null, ok: false };
}

// --- HTTP request helper ---
function makeRequest(url, options, body) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.request(url, options, resolve);
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// --- Main handler ---
async function handleRequest(req, res) {
  if (req.url === '/health') {
    res.writeHead(200);
    return res.end('ok');
  }

  console.log(`[REQ] ${req.method} ${req.url}`);

  if (req.method !== 'POST') {
    res.writeHead(405);
    return res.end('POST only');
  }

  const { upstream, ok } = parseUpstream(req.url);
  if (!ok) {
    res.writeHead(400);
    return res.end(JSON.stringify({
      error: { message: 'Invalid path. Use: /<upstream-base>/v1/chat/completions' }
    }));
  }

  const bodyChunks = [];
  for await (const chunk of req) bodyChunks.push(chunk);
  let body;
  try { body = JSON.parse(Buffer.concat(bodyChunks).toString()); } catch {
    res.writeHead(400);
    return res.end('Invalid JSON');
  }

  const upstreamUrl = upstream.replace(/\/$/, '') + '/v1/responses';
  const responsesBody = completionsToResponses(body);
  const responsesJson = JSON.stringify(responsesBody);
  const isStream = body.stream;

  console.log(`[${new Date().toISOString()}] ${upstream} model=${body.model} stream=${!!isStream} tools=${(body.tools||[]).length}`);

  try {
    const upRes = await makeRequest(upstreamUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': req.headers['authorization'] || '',
        'Content-Length': Buffer.byteLength(responsesJson),
      },
    }, responsesJson);

    if (upRes.statusCode !== 200) {
      const errChunks = [];
      for await (const c of upRes) errChunks.push(c);
      const errBody = Buffer.concat(errChunks).toString();
      console.log(`[ERR] ${upRes.statusCode}: ${errBody.slice(0, 500)}`);
      res.writeHead(upRes.statusCode, { 'Content-Type': 'application/json' });
      return res.end(errBody);
    }

    if (isStream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });

      const state = createStreamState(body.model);
      let buffer = '';
      let lastData = Date.now();

      // Safety timeout: 90s idle → force close
      const idleCheck = setInterval(() => {
        if (Date.now() - lastData > 90000) {
          console.warn(`[STREAM-TIMEOUT] No data for 90s, force closing`);
          clearInterval(idleCheck);
          // Emit a finish chunk if we haven't yet
          if (!state.finished) {
            state.finished = true;
            const fr = state.toolCalls.length > 0 ? 'tool_calls' : 'stop';
            try { res.write(`data: ${JSON.stringify(makeChunk(state, {}, fr))}\n\n`); } catch {}
          }
          try { res.write('data: [DONE]\n\n'); res.end(); } catch {}
          try { upRes.destroy(); } catch {}
        }
      }, 5000);

      upRes.on('data', (chunk) => {
        lastData = Date.now();
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const converted = convertStreamChunk(trimmed, state);
          if (converted) {
            try { res.write(converted); } catch {}
          }
        }
      });

      upRes.on('end', () => {
        clearInterval(idleCheck);
        // Flush remaining buffer
        if (buffer.trim()) {
          const converted = convertStreamChunk(buffer.trim(), state);
          if (converted) {
            try { res.write(converted); } catch {}
          }
        }
        // Ensure we sent a finish chunk
        if (!state.finished) {
          state.finished = true;
          const fr = state.toolCalls.length > 0 ? 'tool_calls' : 'stop';
          try { res.write(`data: ${JSON.stringify(makeChunk(state, {}, fr))}\n\n`); } catch {}
        }
        try { res.write('data: [DONE]\n\n'); res.end(); } catch {}
        console.log(`[STREAM-END] completed normally, tools=${state.toolCalls.length} hasContent=${state.hasContent}`);
      });

      upRes.on('error', (err) => {
        clearInterval(idleCheck);
        console.error(`[STREAM-ERR] ${err.message}`);
        if (!state.finished) {
          state.finished = true;
          const fr = state.toolCalls.length > 0 ? 'tool_calls' : 'stop';
          try { res.write(`data: ${JSON.stringify(makeChunk(state, {}, fr))}\n\n`); } catch {}
        }
        try { res.write('data: [DONE]\n\n'); res.end(); } catch {}
      });

    } else {
      // Non-streaming
      const respChunks = [];
      for await (const c of upRes) respChunks.push(c);
      const rawResp = Buffer.concat(respChunks).toString();

      // Check if upstream returned SSE despite stream=false
      if (rawResp.trimStart().startsWith('event:') || rawResp.trimStart().startsWith('data:')) {
        const lines = rawResp.split('\n');
        let fullText = '';
        let respId = '';
        let respModel = body.model;
        let usage = null;
        let toolCalls = [];
        let currentToolName = '';
        let currentToolArgs = '';
        let currentToolId = '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(5).trim();
          if (data === '[DONE]') break;
          let event;
          try { event = JSON.parse(data); } catch { continue; }

          if (event.type === 'response.output_text.delta') {
            fullText += event.delta || '';
          } else if (event.type === 'response.output_item.added' && event.item?.type === 'function_call') {
            currentToolName = event.item.name || '';
            currentToolId = event.item.call_id || event.item.id || '';
          } else if (event.type === 'response.function_call_arguments.delta') {
            currentToolArgs += event.delta || '';
          } else if (event.type === 'response.function_call_arguments.done') {
            toolCalls.push({
              id: currentToolId || 'call_' + Date.now(),
              type: 'function',
              function: { name: currentToolName, arguments: currentToolArgs },
            });
            currentToolArgs = '';
            currentToolName = '';
            currentToolId = '';
          } else if (event.type === 'response.completed' || event.type === 'response.done') {
            if (event.response) {
              respId = event.response.id || respId;
              respModel = event.response.model || respModel;
              usage = event.response.usage || usage;
            }
          }
          if (event.output) {
            for (const item of event.output) {
              if (item.type === 'message') {
                for (const c of (item.content || [])) {
                  if (c.type === 'output_text') fullText += c.text;
                }
              }
            }
          }
        }

        const message = { role: 'assistant', content: fullText || null };
        const finishReason = toolCalls.length > 0 ? 'tool_calls' : 'stop';
        if (toolCalls.length > 0) message.tool_calls = toolCalls;

        const result = {
          id: respId || 'chatcmpl-proxy-' + Date.now(),
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: respModel,
          choices: [{ index: 0, message, finish_reason: finishReason }],
          usage: usage ? {
            prompt_tokens: usage.input_tokens || 0,
            completion_tokens: usage.output_tokens || 0,
            total_tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
          } : undefined,
        };

        console.log(`[OK] SSE→JSON assembled, text=${fullText.length} tools=${toolCalls.length}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } else {
        const respBody = JSON.parse(rawResp);
        const result = responsesToCompletions(respBody, body.model);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      }
    }

  } catch (err) {
    console.error('[ERR]', err.message);
    if (!res.headersSent) res.writeHead(502);
    res.end(JSON.stringify({ error: { message: err.message } }));
  }
}

const server = http.createServer(handleRequest);
server.listen(PORT, () => {
  console.log(`Completions↔Responses proxy on :${PORT}`);
  console.log(`Usage: POST http://localhost:${PORT}/<upstream-base>/v1/chat/completions`);
});
