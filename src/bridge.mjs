import http from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { BridgeError, ignoredOf, makeMessage, streamFinish, streamStart, validateRequest } from './protocol.mjs';

const HINTS = {
  AGY_TIMEOUT: 'Gemini did not answer in time. Try a faster model (/model sonnet or haiku) or raise --gemini-timeout.',
  CONTEXT_TOO_LARGE: 'The conversation is larger than the provider accepts in one message. Run /clear or start a new session.',
  AGY_QUOTA: 'The Antigravity quota or rate limit was reached. Wait and retry.',
  AGY_AUTH_REQUIRED: 'Antigravity is not signed in. Run agy in a terminal to sign in.',
  AGY_NATIVE_ACTION: 'Gemini tried to run its own tool instead of proposing one to Claude Code.',
  AGY_EMPTY_RESULT: 'Gemini returned an empty answer.',
  INVALID_MODEL_JSON: 'Gemini returned malformed JSON twice. Retry or rephrase; code with many quotes is the usual cause.',
  AGY_INVALID_RESULT: 'Gemini returned an answer the bridge could not validate.',
  AGY_INFERENCE_FAILED: 'The Antigravity process failed. See ~/Library/Logs/claudecode-gemini-adapter/bridge.jsonl.',
  AGY_MODEL_NOT_ROUTED: 'This model id is not routed. Use /model and pick one of the Gemini routes.',
  UNSUPPORTED_REQUEST_FIELD: 'The request body was not a JSON object.',
  INVALID_TOOLS: 'The request carried an invalid tools list.',
  UNSUPPORTED_TOOL_RESULT: 'A tool result contained a block the bridge cannot represent.',
  UNSUPPORTED_CONTENT: 'The conversation contains an unsupported content block or an unpaired tool call.',
};
const TYPES = { 400: 'invalid_request_error', 401: 'authentication_error', 403: 'permission_error', 404: 'not_found_error',
  413: 'request_too_large', 429: 'rate_limit_error', 529: 'overloaded_error' };

const errorInfo = (error) => {
  const known = error instanceof BridgeError;
  const code = known ? error.message : 'INFERENCE_FAILED';
  const status = known ? error.status : 502;
  return { code, status, retry: known ? error.retry : true, type: TYPES[status] ?? 'api_error',
    message: HINTS[code] ? `${code}: ${HINTS[code]}` : code, meta: known ? error.meta : undefined };
};

export async function createBridge({ infer, token, maxBodyBytes = 2_000_000, allowImages = false, maxConcurrent = 1,
  queueTimeoutMs = 0, maxQueue = 32, countTokens, log = () => {}, pingMs = 0 }) {
  if (typeof infer !== 'function' || typeof token !== 'string' || token.length < 16 ||
    typeof allowImages !== 'boolean' || !Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 16) {
    throw Error('INVALID_BRIDGE_CONFIG');
  }
  const active = new Set();
  const waiters = [];
  let running = 0;
  const stats = { requests: 0, toolCalls: 0, rejected: {} };

  async function acquire(signal) {
    if (running < maxConcurrent) { running++; return; }
    if (!queueTimeoutMs || waiters.length >= maxQueue) throw new BridgeError('INFERENCE_BUSY', 429);
    await new Promise((resolve, reject) => {
      const waiter = { resolve };
      const leave = () => { clearTimeout(waiter.timer); const at = waiters.indexOf(waiter); if (at >= 0) waiters.splice(at, 1); };
      waiter.timer = setTimeout(() => { leave(); reject(new BridgeError('INFERENCE_BUSY', 429)); }, queueTimeoutMs);
      signal.addEventListener('abort', () => { leave(); reject(new BridgeError('INFERENCE_ABORTED')); }, { once: true });
      waiters.push(waiter);
    });
  }
  function release() {
    running--;
    const next = waiters.shift();
    if (next) { clearTimeout(next.timer); running++; next.resolve(); }
  }

  const server = http.createServer(async (request, response) => {
    const abort = new AbortController();
    const entry = { ts: new Date().toISOString(), id: randomUUID().slice(0, 8) };
    const began = Date.now();
    let started = false;
    let ping;
    let skipped = {};
    active.add(abort);
    response.on('close', () => { if (!response.writableEnded) abort.abort(); });
    try {
      const credential = request.headers['x-api-key'] ?? request.headers.authorization?.replace(/^Bearer /, '');
      if (typeof credential !== 'string' || Buffer.byteLength(credential) !== Buffer.byteLength(token)
        || !timingSafeEqual(Buffer.from(credential), Buffer.from(token))) throw new BridgeError('UNAUTHORIZED', 401);
      if (request.headers.origin) throw new BridgeError('BROWSER_ORIGIN_DENIED', 403);
      if (request.headers.host !== `127.0.0.1:${server.address().port}`) throw new BridgeError('HOST_DENIED', 403);
      if (request.method !== 'POST') throw new BridgeError('METHOD_UNSUPPORTED', 405);
      const url = new URL(request.url, 'http://127.0.0.1');
      if ([...url.searchParams].some(([key, value]) => key !== 'beta' || value !== 'true')) throw new BridgeError('UNSUPPORTED_QUERY', 502, { retry: false });
      const counting = url.pathname === '/v1/messages/count_tokens';
      if (counting && typeof countTokens !== 'function') throw new BridgeError('TOKEN_COUNT_UNSUPPORTED', 501);
      if (!counting && url.pathname !== '/v1/messages') throw new BridgeError('NOT_FOUND', 404);
      if (request.headers['content-type']?.split(';')[0] !== 'application/json') throw new BridgeError('JSON_REQUIRED', 415);
      const chunks = [];
      let length = 0;
      for await (const chunk of request) {
        length += chunk.length;
        if (length > maxBodyBytes) throw new BridgeError('BODY_TOO_LARGE', 413);
        chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new BridgeError('INVALID_JSON', 502, { retry: false }); }
      try { validateRequest(counting ? { max_tokens: 1, ...body } : body, { allowImages }); }
      catch (error) {
        stats.messageShapes = { total: body.messages?.length ?? 0 };
        for (const role of ['user', 'assistant', 'system', 'developer']) {
          stats.messageShapes[role] = body.messages?.filter((message) => message?.role === role).length ?? 0;
        }
        throw error;
      }
      const dropped = ignoredOf(body);
      skipped = { ...(dropped.fields.length ? { ignoredFields: dropped.fields } : {}), ...(dropped.tools.length ? { ignoredTools: dropped.tools } : {}) };
      Object.assign(entry, { model: body.model, stream: body.stream === true, count: counting || undefined });
      if (counting) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ input_tokens: countTokens(body) }));
        entry.status = 200;
        return;
      }
      await acquire(abort.signal);
      started = true;
      stats.requests++;
      const id = `msg_${randomUUID().replaceAll('-', '')}`;
      // Keepalive is opt-in: once SSE headers are out, Claude Code retries late errors regardless of x-should-retry.
      if (body.stream && pingMs > 0) {
        streamStart(response, { id, model: body.model });
        ping = setInterval(() => { if (!response.writableEnded) response.write('event: ping\ndata: {"type":"ping"}\n\n'); }, pingMs);
        ping.unref?.();
      }
      const output = await infer(body, abort.signal);
      const message = makeMessage(body, output, id);
      stats.toolCalls += message.content.filter((block) => block.type === 'tool_use').length;
      Object.assign(entry, { status: 200, usage: message.usage, meta: { ...output.meta, ...skipped } });
      if (body.stream) {
        clearInterval(ping);
        if (!response.headersSent) streamStart(response, { id, model: body.model, usage: message.usage });
        streamFinish(response, message);
      }
      else { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(message)); }
    } catch (error) {
      const info = errorInfo(error);
      stats.rejected[info.code] = (stats.rejected[info.code] ?? 0) + 1;
      Object.assign(entry, { status: info.status, error: info.code, meta: { ...info.meta, ...skipped } });
      clearInterval(ping);
      const payload = { type: 'error', error: { type: info.type, message: info.message } };
      if (response.headersSent) {
        if (!response.writableEnded && !response.destroyed) { response.write(`event: error\ndata: ${JSON.stringify(payload)}\n\n`); response.end(); }
      } else if (!response.destroyed) {
        response.writeHead(info.status, { 'content-type': 'application/json', 'x-should-retry': String(info.retry) });
        response.end(JSON.stringify(payload));
      }
    } finally {
      if (started) release();
      active.delete(abort);
      if (entry.status !== undefined) { try { log({ ...entry, ms: Date.now() - began }); } catch {} }
    }
  });
  server.requestTimeout = 30_000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { url: `http://127.0.0.1:${server.address().port}`, stats,
    close: () => new Promise((resolve) => { for (const abort of active) abort.abort(); server.close(resolve); server.closeAllConnections(); }) };
}
