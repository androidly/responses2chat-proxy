import http from 'node:http';
import https from 'node:https';

const PORT = process.env.PORT || 3088;
const MAX_IDLE_MS = 120_000;
const REQUEST_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 90_000);
const ALLOWED_UPSTREAM_HOSTS = new Set(
  String(process.env.ALLOWED_UPSTREAM_HOSTS || 'api.infiniteai.cc')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean),
);

function makeId(prefix = 'id') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function toToolArgsString(args) {
  if (typeof args === 'string') return args;
  if (args == null) return '';
  try { return JSON.stringify(args); } catch { return String(args); }
}

function extractOutputTextFromContent(content) {
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const c of content) {
    if (!c || typeof c !== 'object') continue;
    if ((c.type === 'output_text' || c.type === 'text') && typeof c.text === 'string') {
      out += c.text;
    }
  }
  return out;
}

function extractReasoningTextFromContent(content) {
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const c of content) {
    if (!c || typeof c !== 'object') continue;
    if ((c.type === 'reasoning_text' || c.type === 'text') && typeof c.text === 'string') {
      out += c.text;
    }
  }
  return out;
}

function extractPartText(part) {
  if (!part || typeof part !== 'object') return '';
  if (typeof part.text === 'string') return part.text;
  if (typeof part.delta === 'string') return part.delta;
  if (Array.isArray(part.content)) {
    return extractOutputTextFromContent(part.content) || extractReasoningTextFromContent(part.content);
  }
  return '';
}

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
            arguments: toToolArgsString(tc.function?.arguments),
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
  if (!respBody || typeof respBody !== 'object') {
    return {
      id: makeId('chatcmpl-proxy'),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: model || 'unknown',
      choices: [{ index: 0, message: { role: 'assistant', content: null }, finish_reason: 'stop' }],
    };
  }

  if (respBody.object === 'chat.completion' || respBody.choices) return respBody;

  let outputContent = '';
  const toolCalls = [];
  let finishReason = 'stop';
  let reasoningContent = null;

  if (Array.isArray(respBody.output)) {
    for (const item of respBody.output) {
      if (item.type === 'message') {
        outputContent += extractOutputTextFromContent(item.content);
      } else if (item.type === 'function_call') {
        toolCalls.push({
          id: item.call_id || item.id || makeId('call'),
          type: 'function',
          function: {
            name: item.name || '',
            arguments: toToolArgsString(item.arguments),
          },
        });
        finishReason = 'tool_calls';
      } else if (item.type === 'reasoning') {
        const t = extractReasoningTextFromContent(item.content);
        if (t) reasoningContent = (reasoningContent || '') + t;
      }
    }
  }

  const message = { role: 'assistant', content: outputContent || null };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  if (reasoningContent) message.reasoning_content = reasoningContent;

  const usage = (respBody.usage && typeof respBody.usage === 'object') ? {
    prompt_tokens: respBody.usage.input_tokens || 0,
    completion_tokens: respBody.usage.output_tokens || 0,
    total_tokens: (respBody.usage.input_tokens || 0) + (respBody.usage.output_tokens || 0),
  } : undefined;

  return {
    id: respBody.id || makeId('chatcmpl-proxy'),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model || respBody.model || 'unknown',
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage,
  };
}

// --- Streaming state ---
function createStreamState(model) {
  return {
    id: makeId('chatcmpl-proxy'),
    created: Math.floor(Date.now() / 1000),
    model,
    toolCalls: [],
    currentToolIndex: -1,
    toolCallByCallId: new Map(),
    toolCallByItemId: new Map(),
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

function getToolByEvent(state, event) {
  if (event.call_id && state.toolCallByCallId.has(event.call_id)) {
    return state.toolCallByCallId.get(event.call_id);
  }
  if (event.item_id && state.toolCallByItemId.has(event.item_id)) {
    return state.toolCallByItemId.get(event.item_id);
  }
  if (state.currentToolIndex >= 0 && state.toolCalls[state.currentToolIndex]) {
    return state.toolCalls[state.currentToolIndex];
  }
  return null;
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

    case 'response.reasoning_summary_part.added': {
      const t = extractPartText(event.part);
      if (t) {
        state.hasReasoning = true;
        ensureRoleChunk(state, out);
        out.push(makeChunk(state, { reasoning_content: t }));
      }
      break;
    }

    case 'response.reasoning_summary_part.done':
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

    case 'response.content_part.added': {
      const t = extractPartText(event.part);
      if (t) {
        if (!state.hasContent) {
          state.hasContent = true;
          ensureRoleChunk(state, out);
        }
        out.push(makeChunk(state, { content: t }));
      }
      break;
    }

    case 'response.content_part.done':
      break;

    // --- Function/tool calls ---
    case 'response.output_item.added': {
      if (event.item?.type === 'function_call') {
        const idx = state.toolCalls.length;
        const tc = {
          index: idx,
          id: event.item.call_id || event.item.id || makeId('call'),
          call_id: event.item.call_id || null,
          item_id: event.item.id || null,
          name: event.item.name || '',
          started: false,
        };
        state.toolCalls.push(tc);
        state.currentToolIndex = idx;
        if (tc.call_id) state.toolCallByCallId.set(tc.call_id, tc);
        if (tc.item_id) state.toolCallByItemId.set(tc.item_id, tc);
        console.log(`[STREAM] tool_call added: idx=${idx} name=${tc.name} id=${tc.id}`);
      }
      break;
    }

    case 'response.output_item.done': {
      const item = event.item;
      if (!item || typeof item !== 'object') break;

      if (item.type === 'message' && !state.hasContent) {
        const t = extractOutputTextFromContent(item.content);
        if (t) {
          state.hasContent = true;
          ensureRoleChunk(state, out);
          out.push(makeChunk(state, { content: t }));
        }
      }

      if (item.type === 'reasoning') {
        const t = extractReasoningTextFromContent(item.content);
        if (t) {
          state.hasReasoning = true;
          ensureRoleChunk(state, out);
          out.push(makeChunk(state, { reasoning_content: t }));
        }
      }

      if (item.type === 'function_call') {
        let tc = getToolByEvent(state, { call_id: item.call_id, item_id: item.id });
        if (!tc) {
          const idx = state.toolCalls.length;
          tc = {
            index: idx,
            id: item.call_id || item.id || makeId('call'),
            call_id: item.call_id || null,
            item_id: item.id || null,
            name: item.name || '',
            started: false,
          };
          state.toolCalls.push(tc);
          state.currentToolIndex = idx;
          if (tc.call_id) state.toolCallByCallId.set(tc.call_id, tc);
          if (tc.item_id) state.toolCallByItemId.set(tc.item_id, tc);
        }
        if (!tc.started) {
          tc.started = true;
          ensureRoleChunk(state, out);
          out.push(makeChunk(state, {
            tool_calls: [{
              index: tc.index,
              id: tc.id,
              type: 'function',
              function: { name: tc.name, arguments: toToolArgsString(item.arguments) },
            }],
          }));
        }
      }
      break;
    }

    case 'response.function_call_arguments.delta': {
      let tc = getToolByEvent(state, event);
      if (!tc) {
        const idx = state.toolCalls.length;
        tc = {
          index: idx,
          id: event.call_id || event.item_id || makeId('call'),
          call_id: event.call_id || null,
          item_id: event.item_id || null,
          name: event.name || '',
          started: false,
        };
        state.toolCalls.push(tc);
        state.currentToolIndex = idx;
        if (tc.call_id) state.toolCallByCallId.set(tc.call_id, tc);
        if (tc.item_id) state.toolCallByItemId.set(tc.item_id, tc);
      } else {
        state.currentToolIndex = tc.index;
      }

      if (!tc.started) {
        tc.started = true;
        ensureRoleChunk(state, out);
        out.push(makeChunk(state, {
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
      const tc = getToolByEvent(state, event);
      if (tc && !tc.started) {
        tc.started = true;
        ensureRoleChunk(state, out);
        out.push(makeChunk(state, {
          tool_calls: [{
            index: tc.index, id: tc.id, type: 'function',
            function: { name: tc.name, arguments: toToolArgsString(event.arguments) },
          }],
        }));
      }
      console.log(`[STREAM] tool_call args done: idx=${tc ? tc.index : state.currentToolIndex}`);
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
  const decoded = decodeURIComponent(path);
  const match2 = decoded.match(/^\/(https?:\/\/.+?)\/(?:v1\/)?chat\/completions$/);

  const rawUpstream = match?.[1] || match2?.[1] || null;
  if (!rawUpstream) return { upstream: null, ok: false, reason: 'path_mismatch' };

  let parsed;
  try {
    parsed = new URL(rawUpstream);
  } catch {
    return { upstream: null, ok: false, reason: 'invalid_url' };
  }

  if (!['https:', 'http:'].includes(parsed.protocol)) {
    return { upstream: null, ok: false, reason: 'invalid_protocol' };
  }

  const hostname = parsed.hostname.toLowerCase();
  if (!ALLOWED_UPSTREAM_HOSTS.has(hostname)) {
    return { upstream: null, ok: false, reason: `host_not_allowed:${hostname}` };
  }

  parsed.pathname = parsed.pathname.replace(/\/$/, '');
  const safeUpstream = parsed.origin + parsed.pathname;
  return { upstream: safeUpstream, ok: true };
}

// --- HTTP helper ---
function makeRequest(url, options, body) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.request(url, options, resolve);

    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`Upstream timeout after ${REQUEST_TIMEOUT_MS}ms`));
    });

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
  const tcMap = new Map(); // key: call_id or fallback id, val: { id, name, args }
  const itemToCall = new Map();
  const tcOrder = [];

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
      case 'response.content_part.added':
        fullText += extractPartText(ev.part);
        break;
      case 'response.reasoning.delta':
      case 'response.reasoning_summary_text.delta':
        reasoningText += ev.delta || '';
        break;
      case 'response.reasoning_summary_part.added':
        reasoningText += extractPartText(ev.part);
        break;
      case 'response.output_item.added':
        if (ev.item?.type === 'function_call') {
          const key = ev.item.call_id || ev.item.id || makeId('call');
          if (!tcMap.has(key)) {
            tcMap.set(key, { id: key, name: ev.item.name || '', args: '' });
            tcOrder.push(key);
          }
          if (ev.item.id) itemToCall.set(ev.item.id, key);
        }
        break;
      case 'response.function_call_arguments.delta': {
        const key = ev.call_id || itemToCall.get(ev.item_id) || null;
        const tc = key ? tcMap.get(key) : null;
        if (tc) tc.args += ev.delta || '';
        break;
      }
      case 'response.function_call_arguments.done': {
        const key = ev.call_id || itemToCall.get(ev.item_id) || null;
        const tc = key ? tcMap.get(key) : null;
        if (tc && ev.arguments != null) tc.args = toToolArgsString(ev.arguments);
        break;
      }
      case 'response.completed':
      case 'response.done':
        if (ev.response) {
          respId = ev.response.id || respId;
          respModel = ev.response.model || respModel;
          usage = ev.response.usage || usage;
          if (Array.isArray(ev.response.output)) {
            for (const item of ev.response.output) {
              if (item.type === 'message') {
                if (!fullText) fullText += extractOutputTextFromContent(item.content);
              } else if (item.type === 'reasoning') {
                reasoningText += extractReasoningTextFromContent(item.content);
              } else if (item.type === 'function_call') {
                const key = item.call_id || item.id || makeId('call');
                if (!tcMap.has(key)) {
                  tcMap.set(key, { id: key, name: item.name || '', args: toToolArgsString(item.arguments) });
                  tcOrder.push(key);
                }
              }
            }
          }
        }
        break;
      default:
        if (Array.isArray(ev.output)) {
          for (const item of ev.output) {
            if (item.type === 'message') {
              fullText += extractOutputTextFromContent(item.content);
            } else if (item.type === 'reasoning') {
              reasoningText += extractReasoningTextFromContent(item.content);
            }
          }
        }
        break;
    }
  }

  const toolCalls = tcOrder.map(key => {
    const tc = tcMap.get(key);
    return { id: tc.id || makeId('call'), type: 'function', function: { name: tc.name || '', arguments: toToolArgsString(tc.args) } };
  });

  const fr = toolCalls.length > 0 ? 'tool_calls' : 'stop';
  const message = { role: 'assistant', content: fullText || null };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  if (reasoningText) message.reasoning_content = reasoningText;

  console.log(`[OK] SSE→JSON: text=${fullText.length} reasoning=${reasoningText.length} tools=${toolCalls.length}`);

  return {
    id: respId || makeId('chatcmpl-proxy'),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: respModel,
    choices: [{ index: 0, message, finish_reason: fr }],
    usage: (usage && typeof usage === 'object') ? {
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
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      error: {
        message: 'Invalid path. Use: /<upstream-base>/v1/chat/completions and allowed host list',
        code: 'INVALID_UPSTREAM_PATH',
      },
    }));
  }

  const bodyChunks = [];
  for await (const chunk of req) bodyChunks.push(chunk);
  let body;
  try { body = JSON.parse(Buffer.concat(bodyChunks).toString()); } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: 'Invalid JSON body', code: 'INVALID_JSON' } }));
  }

  if (!body || typeof body !== 'object' || !body.model || !Array.isArray(body.messages)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      error: {
        message: 'Body must include model(string) and messages(array)',
        code: 'INVALID_REQUEST_BODY',
      },
    }));
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
    const upstreamAuth = req.headers['authorization'];
    if (!upstreamAuth) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'Missing Authorization header' } }));
    }

    const upRes = await makeRequest(upstreamUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': upstreamAuth,
        'Content-Length': Buffer.byteLength(responsesJson),
      },
    }, responsesJson);

    if (upRes.statusCode !== 200) {
      const errChunks = [];
      for await (const c of upRes) errChunks.push(c);
      const errBody = Buffer.concat(errChunks).toString();
      const status = upRes.statusCode || 502;
      console.error(`[ERR] ${status} from ${upstream}: ${errBody.slice(0, 500)}`);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      if (errBody && errBody.trim()) {
        return res.end(errBody);
      }
      return res.end(JSON.stringify({
        error: {
          message: 'Upstream returned non-200 without body',
          code: 'UPSTREAM_BAD_STATUS',
          status,
        },
      }));
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
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: {
        message: err.message || 'Upstream request failed',
        code: 'UPSTREAM_REQUEST_FAILED',
      },
    }));
  }
}

const server = http.createServer(handleRequest);
server.listen(PORT, () => {
  console.log(`Completions↔Responses proxy on :${PORT}`);
  console.log(`Usage: POST http://localhost:${PORT}/<upstream-base>/v1/chat/completions`);
});
