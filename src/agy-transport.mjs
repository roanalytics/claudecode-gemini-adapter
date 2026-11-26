import { BridgeError, deterministic } from './protocol.mjs';
import { extractEnvelope } from './agy-envelope.mjs';
import { agyArgs } from './agy-agent.mjs';
import { SAFE_EVENT_CHARS } from './agy-limits.mjs';
import { renderFull } from './agy-render.mjs';

const QUOTA = /RESOURCE_EXHAUSTED|rate limit|quota exceeded|\b429\b/i;
const AUTH = /not logged|authentication (required|failed)|sign in/i;

const invalid = () => { throw deterministic('AGY_INVALID_RESULT'); };

// Validate the events of ONE turn. `first` turns must open with `init`.
export function decodeTurn(events, { model, first = true, expectedTurns = 1, conversationId, toolNames = [] } = {}) {
  const result = events.at(-1);
  if (result?.event !== 'result') invalid();
  let id = conversationId;
  let body = events.slice(0, -1);
  if (first) {
    const init = events[0];
    id = init?.conversation_id;
    if (init?.event !== 'init' || typeof id !== 'string' || !id || init.init?.model !== model
      || !['strict', 'request-review'].includes(init.init?.permission_mode)) invalid();
    body = events.slice(1, -1);
  }
  for (const event of body) {
    const step = event?.step_update;
    if (event?.event === 'init') continue;
    if (event?.event !== 'step_update' || !step) invalid();
    if (step.step_type === 'tool' || step.tool_name || step.tool_info || step.subagent_info) {
      throw deterministic('AGY_NATIVE_ACTION');
    }
    if (step.conversation_id !== id || !['user_input', 'agent_response', 'checkpoint'].includes(step.step_type)) invalid();
  }
  const outcome = result.result;
  if (outcome?.finished_reason === 'print_timeout') throw deterministic('AGY_TIMEOUT');
  if (outcome?.status === 'ERROR') {
    const text = String(outcome.error ?? '');
    if (QUOTA.test(text)) throw new BridgeError('AGY_QUOTA', 429);
    if (AUTH.test(text)) throw deterministic('AGY_AUTH_REQUIRED');
    throw new BridgeError('AGY_INVALID_RESULT', 502);
  }
  if (outcome?.status !== 'SUCCESS' || outcome.conversation_id !== id || outcome.num_turns !== expectedTurns
    || typeof outcome.response !== 'string') invalid();
  const usage = outcome.usage;
  if (!usage || !['input_tokens', 'output_tokens'].every((key) => Number.isSafeInteger(usage[key]) && usage[key] >= 0)) invalid();
  const parsed = extractEnvelope(outcome.response, toolNames);
  return { id, content: parsed.content ?? null, empty: parsed.empty === true, invalidJson: parsed.invalidJson,
    usage: { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens }, cacheRead: usage.cache_read_tokens ?? 0 };
}

export function parseEvents(stdout) {
  try { return String(stdout).trim().split('\n').map((line) => JSON.parse(line)); }
  catch { return invalid(); }
}

export function classifyProcessError(error, signal) {
  if (signal?.aborted) return new BridgeError('INFERENCE_ABORTED');
  if (error?.timedOut) return deterministic('AGY_TIMEOUT');
  const tail = String(error?.stderrTail ?? '');
  if (QUOTA.test(tail)) return new BridgeError('AGY_QUOTA', 429);
  if (AUTH.test(tail)) return deterministic('AGY_AUTH_REQUIRED');
  return new BridgeError('AGY_INFERENCE_FAILED', 502, { meta: { stderrTail: tail } });
}

export function createAgyTransport({ model, invoke, lean = true, pool, rules } = {}) {
  if (typeof invoke !== 'function' && !pool) throw Error('AGY_INVOCATION_REQUIRED');
  if (typeof model !== 'string' || !/^gemini-[a-z0-9.-]{1,100}$/.test(model)) throw Error('INVALID_AGY_MODEL');
  return async (request, signal) => {
    if (signal?.aborted) throw new BridgeError('INFERENCE_ABORTED');
    if (['temperature', 'top_p', 'top_k'].some((key) => request[key] !== undefined)) {
      throw deterministic('AGY_UNSUPPORTED_SAMPLING');
    }
    if (pool) return pool.infer(request, signal, { model, lean });
    const started = Date.now();
    const { text, omitted } = renderFull(request, { lean, rules });
    if (text.length > SAFE_EVENT_CHARS) throw deterministic('CONTEXT_TOO_LARGE', { chars: text.length });
    const stdin = JSON.stringify({ event: 'user', message: { content: text } }) + '\n';
    let stdout;
    try { stdout = await invoke({ args: agyArgs(model), stdin, signal }); }
    catch (error) { throw classifyProcessError(error, signal); }
    if (signal?.aborted) throw new BridgeError('INFERENCE_ABORTED');
    const turn = decodeTurn(parseEvents(stdout), { model, toolNames: (request.tools ?? []).map((tool) => tool.name) });
    if (turn.invalidJson) throw deterministic('INVALID_MODEL_JSON');
    if (!turn.content) throw deterministic('AGY_EMPTY_RESULT');
    return { content: turn.content,
      usage: { input_tokens: turn.usage.input_tokens, output_tokens: Math.min(turn.usage.output_tokens, request.max_tokens ?? Infinity) },
      meta: { session: 'stateless', chars: text.length, omitted: omitted.length, cacheRead: turn.cacheRead, ms: Date.now() - started } };
  };
}
