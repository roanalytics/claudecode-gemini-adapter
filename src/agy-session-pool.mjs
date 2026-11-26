import { randomUUID } from 'node:crypto';
import { BridgeError, deterministic, makeMessage } from './protocol.mjs';
import { agyArgs } from './agy-agent.mjs';
import { SAFE_EVENT_CHARS } from './agy-limits.mjs';
import { decodeTurn } from './agy-transport.mjs';
import { LATEST, createRenderContext, escapeAt, hashMessage, hashSystem, referencedTools, renderConversation,
  renderStatic, renderTool, splitEvents } from './agy-render.mjs';

const REPAIR = 'Your previous reply was empty. Reply now with only the JSON envelope for the latest turn.\n';
const MODEL_ERRORS = new Set(['INVALID_MODEL_ENVELOPE', 'INVALID_MODEL_TOOL_CALL', 'TOOL_CHOICE_VIOLATION']);
const withIds = (content) => content.map((block) => block.type === 'tool_use' && !block.id
  ? { ...block, id: `toolu_${randomUUID().replaceAll('-', '')}` } : block);
const RETRYABLE = new Set(['AGY_INFERENCE_FAILED', 'AGY_INVALID_RESULT', 'AGY_EMPTY_RESULT']);

function attach(session) {
  const { proc } = session;
  let buffer = '';
  proc.stdout.on('data', (chunk) => {
    buffer += chunk;
    for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      session.onLine?.(line);
    }
  });
  proc.stderr?.on('data', (chunk) => { session.stderr = (session.stderr + chunk).slice(-20_000); });
  proc.stdin.on('error', () => {});
  proc.once('error', () => { session.closed = true; session.onClose?.(); });
  proc.once('close', () => { session.closed = true; session.onClose?.(); });
}

function kill(session) {
  session.closed = true;
  try { session.proc.stdin.destroy(); } catch {}
  try { session.proc.kill('SIGKILL'); } catch {}
}

export function createSessionPool({ spawnSession, maxSessions = 6, idleMs = 20 * 60_000, turnTimeoutMs = 600_000,
  safeChars = SAFE_EVENT_CHARS, log = () => {}, rules } = {}) {
  if (typeof spawnSession !== 'function') throw Error('SESSION_SPAWN_REQUIRED');
  const sessions = new Set();
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const session of sessions) if (!session.busy && now - session.lastUsed > idleMs) drop(session, 'idle');
  }, Math.min(60_000, Math.max(10, Math.floor(idleMs / 2))));
  sweep.unref?.();

  function drop(session, reason) {
    kill(session);
    sessions.delete(session);
    log({ event: 'session_closed', reason, turns: session.turns });
  }

  function openSession(model, systemHash) {
    if (sessions.size >= maxSessions) {
      const idle = [...sessions].filter((candidate) => !candidate.busy).sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (!idle) throw new BridgeError('INFERENCE_BUSY', 429);
      drop(idle, 'evicted');
    }
    const session = { proc: spawnSession(agyArgs(model)), model, systemHash, toolsSeen: new Set(), hashes: [], seen: new Set(),
      turns: 0, outTotal: 0, cacheTotal: 0, conversationId: undefined, busy: false, closed: false, stderr: '', lastUsed: Date.now() };
    attach(session);
    session.proc.once('close', () => { if (!session.busy) sessions.delete(session); });
    sessions.add(session);
    return session;
  }

  function pick(model, systemHash, hashes, messages) {
    let best;
    for (const session of sessions) {
      if (session.busy || session.closed || session.model !== model || session.systemHash !== systemHash) continue;
      const length = session.hashes.length;
      if (!length || length >= hashes.length || messages[length].role === 'assistant') continue;
      if (!session.hashes.every((hash, index) => hash === hashes[index])) continue;
      if (!best || length > best.hashes.length) best = session;
    }
    return best;
  }

  function exchange(session, text, { signal }) {
    return new Promise((resolve, reject) => {
      const events = [];
      let timer;
      const finish = (settle, value) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        session.onLine = null; session.onClose = null;
        settle(value);
      };
      const onAbort = () => finish(reject, new BridgeError('INFERENCE_ABORTED'));
      session.onLine = (line) => {
        let event;
        try { event = JSON.parse(line); } catch { return; }
        events.push(event);
        if (event.event === 'result') finish(resolve, events);
      };
      session.onClose = () => finish(reject, new BridgeError('AGY_INFERENCE_FAILED', 502, { meta: { exited: true } }));
      timer = setTimeout(() => finish(reject, deterministic('AGY_TIMEOUT')), turnTimeoutMs);
      if (signal?.aborted) { onAbort(); return; }
      signal?.addEventListener('abort', onAbort, { once: true });
      if (session.closed) { session.onClose(); return; }
      session.proc.stdin.write(JSON.stringify({ event: 'user', message: { content: text } }) + '\n');
    });
  }

  async function turn(session, text, options) {
    const events = await exchange(session, text, options);
    const decoded = decodeTurn(events, { model: session.model, first: session.turns === 0, expectedTurns: session.turns + 1,
      conversationId: session.conversationId, toolNames: options.toolNames });
    session.turns++;
    session.conversationId = decoded.id;
    // agy reports output and cache-read tokens as running totals for the whole session (measured); input_tokens is per turn.
    const output = decoded.usage.output_tokens, cache = decoded.cacheRead;
    const usage = { input_tokens: decoded.usage.input_tokens, output_tokens: output >= session.outTotal ? output - session.outTotal : output };
    const cacheRead = cache >= session.cacheTotal ? cache - session.cacheTotal : cache;
    session.outTotal = output;
    session.cacheTotal = cache;
    return { ...decoded, usage, cacheRead };
  }

  function buildEvents(session, request, lean, reused) {
    const context = createRenderContext({ lean, seen: session.seen, rules });
    let body;
    if (reused) {
      const delta = request.messages.slice(session.hashes.length);
      const referenced = referencedTools(request.messages);
      const names = new Set((request.tools ?? []).map((tool) => tool.name));
      const added = (request.tools ?? []).filter((tool) => !session.toolsSeen.has(tool.name));
      const removed = [...session.toolsSeen].filter((name) => !names.has(name));
      body = (added.length ? `<tools_added>\n${added.map((tool) => renderTool(tool, referenced, { lean })).join('\n')}\n</tools_added>\n` : '')
        + (removed.length ? `<tools_removed>${removed.join(',')}</tools_removed>\n` : '')
        + `<conversation_delta>\n${renderConversation(delta, context)}\n</conversation_delta>\n`;
    } else {
      body = `${renderStatic(request, context)}\n<conversation>\n${renderConversation(request.messages, context)}\n</conversation>\n`;
    }
    return { events: splitEvents(escapeAt(body), { limit: safeChars, tail: LATEST }), omitted: context.omitted };
  }

  async function run(session, request, signal, { lean, hashes, systemHash }) {
    const reused = session.turns > 0;
    const toolNames = (request.tools ?? []).map((tool) => tool.name);
    const { events, omitted } = buildEvents(session, request, lean, reused);
    session.busy = true;
    const started = Date.now();
    try {
      let outputTokens = 0, last, content, repairs = 0;
      for (const [index, text] of events.entries()) {
        last = await turn(session, text, { signal, toolNames });
        outputTokens += last.usage.output_tokens;
        if (index + 1 < events.length) continue;
        for (;;) {
          let problem;
          if (last.invalidJson) problem = deterministic('INVALID_MODEL_JSON');
          else if (!last.content) problem = deterministic('AGY_EMPTY_RESULT');
          else {
            content = withIds(last.content);
            try { makeMessage(request, { content, usage: { input_tokens: 0, output_tokens: 0 } }); break; }
            catch (error) { if (!MODEL_ERRORS.has(error?.message)) throw error; problem = error; }
          }
          if (repairs++) throw problem;
          const notice = problem.message === 'AGY_EMPTY_RESULT' ? REPAIR
            : problem.message === 'INVALID_MODEL_JSON'
              ? `Your previous reply was not valid JSON (${last.invalidJson.message} near «${last.invalidJson.near}»). Send the same answer again as one valid JSON object: inside strings escape every double quote as \\", every backslash as \\\\ and every newline as \\n.\n`
              : `Your previous reply was rejected (${problem.message}). Use only offered tool names, match each input_schema exactly, honor tool_choice, and reply again with only the JSON envelope.\n`;
          last = await turn(session, notice + LATEST, { signal, toolNames });
          outputTokens += last.usage.output_tokens;
        }
      }
      session.hashes = [...hashes, hashMessage({ role: 'assistant', content })];
      session.toolsSeen = new Set(toolNames);
      session.systemHash = systemHash;
      session.lastUsed = Date.now();
      const labels = {};
      for (const entry of omitted) labels[entry.label] = (labels[entry.label] ?? 0) + entry.chars;
      return { content, usage: { input_tokens: last.usage.input_tokens, output_tokens: Math.min(outputTokens, request.max_tokens) },
        meta: { session: reused ? 'reused' : 'new', sessionTurns: session.turns, events: events.map((event) => event.length),
          parts: events.length, omitted: labels, cacheRead: last.cacheRead, ms: Date.now() - started } };
    } catch (error) {
      drop(session, error?.message ?? 'error');
      throw error;
    } finally { session.busy = false; }
  }

  async function infer(request, signal, { model, lean = true } = {}) {
    const hashes = request.messages.map(hashMessage);
    const systemHash = hashSystem(request.system ?? []);
    const options = { lean, hashes, systemHash };
    const reusable = pick(model, systemHash, hashes, request.messages);
    if (reusable) {
      try { return await run(reusable, request, signal, options); }
      catch (error) {
        if (signal?.aborted || !RETRYABLE.has(error?.message)) throw error;
        log({ event: 'session_retry', reason: error.message });
      }
    }
    return run(openSession(model, systemHash), request, signal, options);
  }

  return { infer, close() { clearInterval(sweep); for (const session of [...sessions]) drop(session, 'close'); },
    get size() { return sessions.size; } };
}
