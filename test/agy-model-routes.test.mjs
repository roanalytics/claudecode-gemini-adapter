import assert from 'node:assert/strict';
import test from 'node:test';
import { createBridge } from '../src/bridge.mjs';
import { AGY_ALIASES, claudeAgyModelPins, createRoutedAgyTransport } from '../src/agy-model-routes.mjs';

const routes = {
  fable: 'gemini-4-neon-xhigh',
  opus: 'gemini-4-neon-high',
  sonnet: 'gemini-4-neon-low',
  haiku: 'gemini-3.8-flash-low',
};
const token = 'synthetic-model-routing-test-token';
const success = (id, model) => [
  { event: 'init', conversation_id: id, init: { model, permission_mode: 'request-review' } },
  { event: 'result', result: { conversation_id: id, status: 'SUCCESS', num_turns: 1,
    response: '{"content":[{"type":"text","text":"route-fixture"}]}',
    usage: { input_tokens: 21, output_tokens: 7 } } },
].map(JSON.stringify).join('\n');
const post = (bridge, model) => fetch(bridge.url + '/v1/messages', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': token },
  body: JSON.stringify({ model, max_tokens: 64, messages: [{ role: 'user', content: 'route-fixture' }] }),
});

test('pins the four Claude aliases to Gemini and routes aliases and pinned IDs over Messages', async (t) => {
  assert.deepEqual(AGY_ALIASES, routes);
  assert.deepEqual(claudeAgyModelPins(), {
    ANTHROPIC_DEFAULT_FABLE_MODEL: routes.fable,
    ANTHROPIC_DEFAULT_OPUS_MODEL: routes.opus,
    ANTHROPIC_DEFAULT_SONNET_MODEL: routes.sonnet,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: routes.haiku,
  });
  const seen = [];
  const bridge = await createBridge({ token, infer: createRoutedAgyTransport({ invoke: async ({ args, stdin }) => {
    const model = args[args.indexOf('--model') + 1];
    const input = JSON.parse(stdin);
    assert.equal(input.event, 'user');
    assert.match(input.message.content, /route-fixture/);
    seen.push(model);
    return success(String(seen.length), model);
  } }) });
  t.after(() => bridge.close());
  for (const [alias, model] of Object.entries(routes)) {
    for (const requested of [alias, model]) {
      const response = await post(bridge, requested);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).content[0].text, 'route-fixture');
      assert.equal(seen.at(-1), model);
    }
  }
  assert.equal(seen.length, 8);
});

test('unknown model IDs and substitute model responses have no fallback', async (t) => {
  let calls = 0;
  const bridge = await createBridge({ token, infer: createRoutedAgyTransport({ invoke: async () => {
    calls++;
    return success('wrong-id', routes.haiku);
  } }) });
  t.after(() => bridge.close());
  for (const model of ['claude-unknown-model', 'gemini-4-argon-high', 'gemini-4-carbon-medium', '__proto__']) {
    const response = await post(bridge, model);
    assert.equal(response.status, 502);
    assert.equal(response.headers.get('x-should-retry'), 'false');
    assert.match((await response.json()).error.message, /^AGY_MODEL_NOT_ROUTED/);
  }
  assert.equal(calls, 0);
  const mismatch = await post(bridge, 'fable');
  assert.equal(mismatch.status, 502);
  assert.equal(mismatch.headers.get('x-should-retry'), 'false');
  assert.match((await mismatch.json()).error.message, /^AGY_INVALID_RESULT/);
  assert.equal(calls, 1);
});

test('model overrides replace only the requested alias and are validated', async () => {
  const { resolveAliases } = await import('../src/agy-model-routes.mjs');
  assert.deepEqual(resolveAliases({}), routes);
  const custom = resolveAliases({ CLAUDE_GEMINI_MODEL_SONNET: 'gemini-4-carbon-medium', CLAUDE_GEMINI_MODEL_HAIKU: '' });
  assert.deepEqual(custom, { ...routes, sonnet: 'gemini-4-carbon-medium' });
  assert.equal(claudeAgyModelPins(custom).ANTHROPIC_DEFAULT_SONNET_MODEL, 'gemini-4-carbon-medium');
  for (const bad of ['sonnet', 'gemini-', 'gemini-4 medium', '../x', 'claude-opus-5-5-low']) {
    assert.throws(() => resolveAliases({ CLAUDE_GEMINI_MODEL_SONNET: bad }), { message: 'INVALID_MODEL_OVERRIDE' });
  }
  const seen = [];
  const routed = createRoutedAgyTransport({ aliases: custom, invoke: async ({ args }) => { const model = args[args.indexOf('--model') + 1]; seen.push(model); return success('1', model); } });
  await routed({ model: 'sonnet', max_tokens: 10, messages: [{ role: 'user', content: 'x' }] });
  assert.deepEqual(seen, ['gemini-4-carbon-medium']);
});
