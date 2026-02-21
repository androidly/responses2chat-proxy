import http from 'node:http';
import https from 'node:https';

const PORT = process.env.PORT || 3088;
const MAX_IDLE_MS = 120_000;

// --- Conversion: Chat Completions request → Responses API request ---
function completionsToResponses(body) {
  const resp = { model: body.model, input: [], store: false };

  if (body.messages) {
    for (const msg of body.messages) {
      if (msg.role === 'system' || msg.role === 'developer') {
        const text = typeof msg.content === 'string' ? msg.content
          : Array.isArray(msg.content) ? msg.content.filter(c => c.type === 'text').map(c => c.text).join('') : '';
        resp.instructions = (resp.instructions || '') + text;
      } else if (msg.role === 'tool') {
        resp.input.push({
          type: 'function_call_output',
          call_id: msg.tool_call_id || '',
          output: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
        });
      } else if (msg.role === 'assistant' && msg.tool_calls) {
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
  if (body.frequency_penalty != null) resp.frequency_penalty = body.frequency_penalty;
  if (body.presence_penalty != null) resp.presence_penalty = body.presence_penalty;
  if (body.seed != null) resp.seed = body.seed;
  if (body.stop) resp.stop = body.stop;

  // Reasoning effort
  if (body.reasoning_effort) {
    resp.reasoning = { effort: body.reasoning_effort };
  }

  // Tools
  if (body.tools) {
    resp.tools = body.tools.map(t => {
      if (t.type === 'function' && t.function) {
        return {
          type: 'function',
          name: t.function.name,
          description: t.function.description,
          parameters: t.function.parameters,
          strict: t.function.strict,
        };
      }
      return t;
    });
  }

  // Tool choice format conversion
  if (body.tool_choice != null) {
    if (typeof body.tool_choice === 'string') {
      resp.tool_choice = body.tool_choice;
    } else if (body.tool_choice?.type === 'function' && body.tool_choice?.function?.name) {
      resp.tool_choice = { type: 'function', name: body.tool_choice.function.name };
    } else {
      resp.tool_choice = body.tool_choice;
    }
  }

  if (body.stream) resp.stream = body.stream;

  return resp;
}

// --- Conversion: Responses API response → Chat Completions response ---
function responsesToCompletions(respBody, model) {
  if (respBody.object === 'chat.completion' || respBody.choices) return respBody;

  let outputContent = '';
  let toolCalls = [];
  let finishReason = 'stop';
  let reasoningContent = null;

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
      } else if (item.type === 'reasoning') {
        for (const c of (item.content || [])) {
          if (c.type === 'reasoning_text') {
            reasoningContent = (reasoningContent || '') + c.text;
          }
        }
      }
    }
  }

  const message = { role: 'assistant', content: outputContent || null };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  if (reasoningContent) message.reasoning_content = reasoningContent;

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
    toolCalls: [],
    currentToolIndex: -1,
    hasContent: false,
    hasReasoning: false,
    sentRole: false,
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

function ensureRoleChunk(state, out) {
  if (!state.sentRole) {
    state.sentRole = true;
    out.push(makeChunk(state, { role: 'assistant', content: '' }));
  }
}

// --- Streaming conversion ---
function convertStreamChunk(line, state) {
  if (line.startsWith('event:')) return null;
  if (!line.startsWith('data:')) return null;

  const data = line.slice(5).trim();
  if (data === '[DONE]') return 'data: [DONE]\n\n';

  let event;
  try { event = JSON.parse(data); } catch { return null; }

  if (event.object === 'chat.completion.chunk') return `data: ${data}\n\n`;

  const out = [];

  switch (event.type) {
    // --- Reasoning ---
    case 'response.reasoning.delta':
    case 'response.reasoning_summary_text.delta': {
      state.hasReasoning = true;
      ensureRoleChunk(state, out);
      if (event.delta) {
        out.push(makeChunk(state, { reasoning_content: event.delta }));
      }
      break;
    }

    case 'response.reasoning.done':
    case 'response.reasoning_summary_text.done':
      break;

    // --- Text output ---
    case 'response.output_text.delta': {
      if (!state.hasContent) {
        state.hasContent = true;
        ensureRoleChunk(state, out);
      }
      out.push(makeChunk(state, { content: event.delta || '' }));
      break;
    }

    case 'response.output_text.done':
      break;

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
        console.log(`[STREAM] tool_call added: idx=${idx} name=${tc.name} id=${tc.id}`);
      }
      break;
    }

    case 'response.function_call_arguments.delta': {
      let tc = state.toolCalls[state.currentToolIndex];
      if (!tc) {
        const idx = state.toolCalls.length;
        tc = {
          index: idx,
          id: event.call_id || event.item_id || 'call_' + Date.now() + '_' + idx,
          name: event.name || '',
          started: false,
        };
        state.toolCalls.push(tc);
        state.currentToolIndex = idx;
      }

      if (!tc.started) {
        tc.started = true;
        out.push(makeChunk(state, {
          role: 'assistant',
          tool_calls: [{
            index: tc.index, id: tc.id, type: 'function',
            function: { name: tc.name, arguments: '' },
          }],
        }));
      }
      out.push(makeChunk(state, {
        tool_calls: [{
          index: tc.index,
          function: { arguments: event.delta || '' },
        }],
      }));
      break;
    }

    case 'response.function_call_arguments.done': {
      const tc = state.toolCalls[state.currentToolIndex];
      if (tc && !tc.started) {
        tc.started = true;
        out.push(makeChunk(state, {
          role: 'assistant',
          tool_calls: [{
            index: tc.index, id: tc.id, type: 'function',
            function: { name: tc.name, arguments: event.arguments || '' },
          }],
        }));
      }
      console.log(`[STREAM] tool_call args done: idx=${state.currentToolIndex}`);
      break;
    }

    // --- Completion ---
    case 'response.completed':
    case 'response.done': {
      if (!state.finished) {
        state.finished = true;
        const fr = state.toolCalls.length > 0 ? 'tool_calls' : 'stop';
        out.push(makeChunk(state, {}, fr));
        console.log(`[STREAM] done: finish_reason=${fr} tools=${state.toolCalls.length}`);
      }
      break;
    }

    case 'error': {
      console.error(`[STREAM-ERR] ${JSON.stringify(event.error || event)}`);
      if (!state.finished) {
        state.finished = true;
        out.push(makeChunk(state, {}, state.toolCalls.length > 0 ? 'tool_calls' : 'stop'));
      }
      break;
    }

    default:
      if (event.type) console.log(`[STREAM] unhandled: ${event.type}`);
      break;
  }

  if (out.length === 0) return null;
  return out.map(c => `data: ${JSON.stringify(c)}\n\n`).join('');
}

// --- Parse upstream URL ---
function parseUpstream(url) {
  const path = url.split('?')[0];
  const match = path.match(/^\/(https?:\/\/.+?)\/(?:v1\/)?chat\/completions$/);
  if (match) return { upstream: match[1], ok: true };
  const decoded = decodeURIComponent(path);
  const match2 = decoded.match(/^\/(https?:\/\/.+?)\/(?:v1\/)?chat\/completions$/);
  if (match2) return { upstream: match2[1], ok: true };
  return { upstream: null, ok: false };
}

// --- HTTP helper ---
function makeRequest(url, options, body) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.request(url, options, resolve);
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// --- SSE → JSON assembly (non-streaming fallback) ---
function assembleSSE(rawResp, requestModel) {
  const lines = rawResp.split('\n');
  let fullText = '';
  let reasoningText = '';
  let respId = '';
  let respModel = requestModel;
  let usage = null;
  const tcMap = new Map();
  const tcOrder = [];
  let curCallId = '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const data = trimmed.slice(5).trim();
    if (data === '[DONE]') break;
    let ev;
    try { ev = JSON.parse(data); } catch { continue; }

    switch (ev.type) {
      case 'response.output_text.delta':
        fullText += ev.delta || '';
        break;
      case 'response.reasoning.delta':
      case 'response.reasoning_summary_text.delta':
        reasoningText += ev.delta || '';
        break;
      case 'response.output_item.added':
        if (ev.item?.type === 'function_call') {
          curCallId = ev.item.call_id || ev.item.id || 'call_' + Date.now();
          tcMap.set(curCallId, { name: ev.item.name || '', args: '' });
          tcOrder.push(curCallId);
        }
        break;
      case 'response.function_call_arguments.delta': {
        const tc = tcMap.get(curCallId);
        if (tc) tc.args += ev.delta || '';
        break;
      }
      case 'response.function_call_arguments.done': {
        const tc = tcMap.get(curCallId);
        if (tc && ev.arguments) tc.args = ev.arguments;
        break;
      }
      case 'response.completed':
      case 'response.done':
        if (ev.response) {
          respId = ev.response.id || respId;
          respModel = ev.response.model || respModel;
          usage = ev.response.usage || usage;
          if (ev.response.output) {
            for (const item of ev.response.output) {
              if (item.type === 'message') {
                for (const c of (item.content || [])) {
                  if (c.type === 'output_text' && !fullText) fullText += c.text;
                }
              } else if (item.type === 'function_call' && !tcMap.has(item.call_id)) {
                const cid = item.call_id || item.id;
                tcMap.set(cid, { name: item.name || '', args: item.arguments || '' });
                tcOrder.push(cid);
              }
            }
          }
        }
        break;
      default:
        if (ev.output) {
          for (const item of ev.output) {
            if (item.type === 'message') {
              for (const c of (item.content || [])) {
                if (c.type === 'output_text') fullText += c.text;
              }
            }
          }
        }
        break;
    }
  }

  const toolCalls = tcOrder.map(cid => {
    const tc = tcMap.get(cid);
    return { id: cid, type: 'function', function: { name: tc.name, arguments: tc.args } };
  });

  const fr = toolCalls.length > 0 ? 'tool_calls' : 'stop';
  const message = { role: 'assistant', content: fullText || null };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  if (reasoningText) message.reasoning_content = reasoningText;

  console.log(`[OK] SSE→JSON: text=${fullText.length} reasoning=${reasoningText.length} tools=${toolCalls.length}`);

  return {
    id: respId || 'chatcmpl-proxy-' + Date.now(),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: respModel,
    choices: [{ index: 0, message, finish_reason: fr }],
    usage: usage ? {
      prompt_tokens: usage.input_tokens || 0,
      completion_tokens: usage.output_tokens || 0,
      total_tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
    } : undefined,
  };
}

// --- Main handler ---
async function handleRequest(req, res) {
  if (req.url === '/health') {
    res.writeHead(200);
    return res.end('ok');
  }

  if (req.method !== 'POST') {
    res.writeHead(405);
    return res.end('POST only');
  }

  const { upstream, ok } = parseUpstream(req.url);
  if (!ok) {
    res.writeHead(400);
    return res.end(JSON.stringify({ error: { message: 'Invalid path. Use: /<upstream-base>/v1/chat/completions' } }));
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
  const ts = new Date().toISOString();

  const toolCount = (body.tools || []).length;
  const msgCount = (body.messages || []).length;
  const hasToolResults = (body.messages || []).some(m => m.role === 'tool');
  console.log(`[${ts}] ${upstream} model=${body.model} stream=${!!isStream} tools=${toolCount} msgs=${msgCount} toolResults=${hasToolResults}`);

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
      console.error(`[ERR] ${upRes.statusCode} from ${upstream}: ${errBody.slice(0, 500)}`);
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

      const idleCheck = setInterval(() => {
        if (Date.now() - lastData > MAX_IDLE_MS) {
          console.warn(`[STREAM-TIMEOUT] No data for ${MAX_IDLE_MS / 1000}s, force closing`);
          clearInterval(idleCheck);
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
        if (buffer.trim()) {
          const converted = convertStreamChunk(buffer.trim(), state);
          if (converted) try { res.write(converted); } catch {}
        }
        if (!state.finished) {
          state.finished = true;
          const fr = state.toolCalls.length > 0 ? 'tool_calls' : 'stop';
          try { res.write(`data: ${JSON.stringify(makeChunk(state, {}, fr))}\n\n`); } catch {}
        }
        try { res.write('data: [DONE]\n\n'); res.end(); } catch {}
        console.log(`[STREAM-END] tools=${state.toolCalls.length} content=${state.hasContent} reasoning=${state.hasReasoning}`);
      });

      upRes.on('error', (err) => {
        clearInterval(idleCheck);
        console.error(`[STREAM-ERR] ${err.message}`);
        if (!state.finished) {
          state.finished = true;
          try { res.write(`data: ${JSON.stringify(makeChunk(state, {}, 'stop'))}\n\n`); } catch {}
        }
        try { res.write('data: [DONE]\n\n'); res.end(); } catch {}
      });

    } else {
      // Non-streaming
      const respChunks = [];
      for await (const c of upRes) respChunks.push(c);
      const rawResp = Buffer.concat(respChunks).toString();

      if (rawResp.trimStart().startsWith('event:') || rawResp.trimStart().startsWith('data:')) {
        const result = assembleSSE(rawResp, body.model);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } else {
        let respBody;
        try { respBody = JSON.parse(rawResp); } catch {
          console.error(`[ERR] Failed to parse upstream response: ${rawResp.slice(0, 200)}`);
          res.writeHead(502);
          return res.end(JSON.stringify({ error: { message: 'Invalid upstream response' } }));
        }
        const result = responsesToCompletions(respBody, body.model);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      }
    }

  } catch (err) {
    console.error(`[ERR] ${err.message}`);
    if (!res.headersSent) res.writeHead(502);
    res.end(JSON.stringify({ error: { message: err.message } }));
  }
}

const server = http.createServer(handleRequest);
server.listen(PORT, () => {
  console.log(`Completions↔Responses proxy on :${PORT}`);
  console.log(`Usage: POST http://localhost:${PORT}/<upstream-base>/v1/chat/completions`);
});
