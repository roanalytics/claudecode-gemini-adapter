import assert from 'node:assert/strict';
import test from 'node:test';
import { agyArgs } from '../src/agy-agent.mjs';
import { SAFE_EVENT_CHARS } from '../src/agy-limits.mjs';
import { createAgyTransport, decodeTurn } from '../src/agy-transport.mjs';

const model = 'gemini-4-neon-medium';
const request = { model: 'gemini-bridge', max_tokens: 100, messages: [{ role: 'user', content: 'PRIVATE_FIXTURE' }] };
const init = { event: 'init', conversation_id: 'local', init: { model, permission_mode: 'request-review' } };
const success = { event: 'result', result: { conversation_id: 'local', status: 'SUCCESS', num_turns: 1,
  response: JSON.stringify({ content: [{ type: 'text', text: 'OK' }] }), usage: { input_tokens: 17, output_tokens: 6 } } };
const ndjson = (...events) => events.map((event) => JSON.stringify(event)).join('\n') + '\n';
const transport = (...events) => createAgyTransport({ model, invoke: async () => ndjson(...events) });
const withResult = (patch) => ({ ...success, result: { ...success.result, ...patch } });

test('agy receives one documented stdin event, explicit model, the lean agent and the supported plan mode', async () => {
  const infer = createAgyTransport({ model, invoke: async ({ args, stdin }) => {
    assert.deepEqual(args, agyArgs(model));
    assert.deepEqual(args, ['--input-format', 'stream-json', '--output-format', 'stream-json', '--mode', 'plan', '--model', model, '--agent', 'claude-bridge']);
    assert.ok(!args.includes('--json-schema'));
    assert.equal(stdin.trim().split('\n').length, 1);
    const event = JSON.parse(stdin);
    assert.equal(event.event, 'user');
    assert.ok(event.message.content.includes('PRIVATE_FIXTURE'));
    assert.ok(event.message.content.includes('<latest_turn>'));
    assert.ok(!args.join(' ').includes('PRIVATE_FIXTURE'));
    return ndjson(init, success);
  } });
  const out = await infer(request);
  assert.deepEqual(out.content, [{ type: 'text', text: 'OK' }]);
  assert.deepEqual(out.usage, success.result.usage);
  assert.equal(out.meta.session, 'stateless');
});

test('agy accepts the canary strict permission mode', async () => {
  const strictInit = { ...init, init: { ...init.init, permission_mode: 'strict' } };
  assert.deepEqual((await transport(strictInit, success)(request)).content, [{ type: 'text', text: 'OK' }]);
});

test('agy preserves a raw JSON final answer as text content', async () => {
  const raw = '{"entries":96,"north":1,"south":-2,"west":3}';
  assert.deepEqual((await transport(init, withResult({ response: raw }))(request)).content, [{ type: 'text', text: raw }]);
});

test('fenced or noisy envelopes are recovered', async () => {
  const noisy = 'Sure!\n```json\n{"content":[{"type":"text","text":"clean"}]}\n```';
  assert.deepEqual((await transport(init, withResult({ response: noisy }))(request)).content, [{ type: 'text', text: 'clean' }]);
});

test('output tokens are clamped to the request budget', async () => {
  const out = await transport(init, withResult({ usage: { input_tokens: 5, output_tokens: 900 } }))(request);
  assert.equal(out.usage.output_tokens, 100);
});

test('agy native tool and subagent activity is never handed to Claude as inference', async () => {
  for (const step_update of [{ step_type: 'tool' }, { step_type: 'agent_response', subagent_info: {} }]) {
    await assert.rejects(transport(init, { event: 'step_update', step_update }, success)(request),
      (error) => error.message === 'AGY_NATIVE_ACTION' && error.status === 502 && error.retry === false);
  }
});

test('malformed, duplicate, cross-conversation and protocol-violating results fail closed and are not retried', async () => {
  for (const events of [[success], [init, success, success], [init, withResult({ conversation_id: 'other' })],
    [init, withResult({ usage: {} })], [{ ...init, init: { ...init.init, model: 'other' } }, success],
    [{ ...init, init: { ...init.init, permission_mode: 'always-proceed' } }, success], [init, withResult({ num_turns: 2 })]]) {
    await assert.rejects(transport(...events)(request), (error) => error.message === 'AGY_INVALID_RESULT' && error.retry === false);
  }
  const infer = createAgyTransport({ model, invoke: async () => 'broken JSON' });
  await assert.rejects(infer(request), { message: 'AGY_INVALID_RESULT' });
});

test('print timeout is a clear deterministic error, not an invalid result', async () => {
  const timed = withResult({ response: '', finished_reason: 'print_timeout', usage: { input_tokens: 0, output_tokens: 0 } });
  await assert.rejects(transport(init, timed)(request), (error) => error.message === 'AGY_TIMEOUT' && error.status === 502 && error.retry === false);
});

test('provider errors map to quota, auth or transient failures without relaying provider text', async () => {
  const failed = (error) => withResult({ status: 'ERROR', error });
  await assert.rejects(transport(init, failed('RESOURCE_EXHAUSTED: PRIVATE_FIXTURE'))(request), (e) => e.message === 'AGY_QUOTA' && e.status === 429 && e.retry);
  await assert.rejects(transport(init, failed('You are not logged into Antigravity'))(request), (e) => e.message === 'AGY_AUTH_REQUIRED' && !e.retry);
  await assert.rejects(transport(init, failed('PRIVATE_FIXTURE'))(request), (e) => e.message === 'AGY_INVALID_RESULT' && e.status === 502 && e.retry);
});

test('an unparseable envelope is reported once as INVALID_MODEL_JSON, not shown as text', async () => {
  await assert.rejects(transport(init, withResult({ response: '{"content":[{"type":"tool_use","name":' }))(request),
    (error) => error.message === 'INVALID_MODEL_JSON' && error.retry === false && error.status === 502);
});

test('empty successful answers are deterministic in stateless mode', async () => {
  await assert.rejects(transport(init, withResult({ response: '' }))(request), { message: 'AGY_EMPTY_RESULT' });
});

test('no default live executable; reject unimplemented sampling and never relay provider diagnostics', async () => {
  assert.throws(() => createAgyTransport({ model }), /AGY_INVOCATION_REQUIRED/);
  let invoked = false;
  const infer = createAgyTransport({ model, invoke: async () => {
    invoked = true;
    throw Error('PRIVATE_FIXTURE');
  } });
  await assert.rejects(infer({ ...request, temperature: 0 }), { message: 'AGY_UNSUPPORTED_SAMPLING' });
  assert.equal(invoked, false);
  await assert.rejects(infer(request), { message: 'AGY_INFERENCE_FAILED' });
});

test('process failures are classified: timeout, quota and auth', async () => {
  const failing = (props) => createAgyTransport({ model, invoke: async () => { throw Object.assign(Error('AGY_PROCESS_FAILED'), props); } });
  await assert.rejects(failing({ timedOut: true })(request), (e) => e.message === 'AGY_TIMEOUT' && !e.retry);
  await assert.rejects(failing({ stderrTail: 'E1 RESOURCE_EXHAUSTED' })(request), { message: 'AGY_QUOTA' });
  await assert.rejects(failing({ stderrTail: 'E1 error getting token source: You are not logged into Antigravity' })(request), { message: 'AGY_AUTH_REQUIRED' });
});

test('stateless requests above the safe event size fail explicitly instead of being truncated', async () => {
  let invoked = false;
  const infer = createAgyTransport({ model, invoke: async () => { invoked = true; return ndjson(init, success); } });
  const big = { ...request, messages: [{ role: 'user', content: 'z'.repeat(SAFE_EVENT_CHARS) }] };
  await assert.rejects(infer(big), (error) => error.message === 'CONTEXT_TOO_LARGE' && error.status === 502 && error.retry === false);
  assert.equal(invoked, false);
});

test('decodeTurn accepts later turns without init and validates the turn counter', () => {
  const later = { ...success, result: { ...success.result, num_turns: 3 } };
  const turn = decodeTurn([{ event: 'step_update', step_update: { conversation_id: 'local', step_type: 'agent_response' } }, later],
    { model, first: false, expectedTurns: 3, conversationId: 'local' });
  assert.equal(turn.content[0].text, 'OK');
  assert.throws(() => decodeTurn([later], { model, first: false, expectedTurns: 2, conversationId: 'local' }), { message: 'AGY_INVALID_RESULT' });
});
