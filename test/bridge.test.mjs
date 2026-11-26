import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createBridge } from '../src/bridge.mjs';

const request = (extra = {}) => ({ model: 'gemini-bridge', max_tokens: 1024,
  messages: [{ role: 'user', content: 'Hello' }], ...extra });
const answer = (content = [{ type: 'text', text: 'Hello back' }]) => ({
  content, usage: { input_tokens: 12, output_tokens: 7 } });

async function withBridge(t, infer) {
  const token = randomUUID();
  const bridge = await createBridge({ infer, token });
  t.after(() => bridge.close());
  const post = (body, headers = {}, path = '/v1/messages') => fetch(bridge.url + path, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': token, ...headers },
    body: JSON.stringify(body),
  });
  return { bridge, post };
}

test('text request returns an Anthropic message with measured usage', async (t) => {
  const { post } = await withBridge(t, async () => answer());
  const response = await post(request());
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.type, 'message');
  assert.equal(body.role, 'assistant');
  assert.equal(body.model, 'gemini-bridge');
  assert.equal(body.content[0].text, 'Hello back');
  assert.equal(body.stop_reason, 'end_turn');
  assert.deepEqual(body.usage, { input_tokens: 12, output_tokens: 7 });
});

test('Anthropic SDK beta query reaches the same validated Messages interface', async (t) => {
  const { post } = await withBridge(t, async () => answer());
  assert.equal((await post(request(), {}, '/v1/messages?beta=true')).status, 200);
});

test('current Claude Code system messages remain in the inference history', async (t) => {
  let seen;
  const { post } = await withBridge(t, async (input) => { seen = input; return answer(); });
  const messages = [{ role: 'system', content: 'A harness instruction' }, ...request().messages];
  assert.equal((await post(request({ messages }))).status, 200);
  assert.deepEqual(seen.messages, messages);
});

test('tool request and tool result round-trip without executing the tool in the bridge', async (t) => {
  const seen = [];
  const tool = { name: 'Read', description: 'Read a file', input_schema: {
    type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } };
  const { post } = await withBridge(t, async (input) => {
    seen.push(input);
    return seen.length === 1 ? answer([{ type: 'tool_use', name: 'Read', input: { file_path: '/fixture' } }]) : answer();
  });
  const first = await (await post(request({ tools: [tool] }))).json();
  assert.equal(first.stop_reason, 'tool_use');
  assert.equal(first.content[0].name, 'Read');
  assert.match(first.content[0].id, /^toolu_/);
  const messages = [...request().messages, { role: 'assistant', content: first.content },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: first.content[0].id, content: 'fixture text' }] }];
  const second = await post(request({ tools: [tool], messages }));
  assert.equal(second.status, 200);
  assert.deepEqual(seen[1].messages, messages);
  assert.equal(seen.length, 2);
});

test('streaming emits a complete ordered Anthropic SSE message', async (t) => {
  const { post } = await withBridge(t, async () => answer());
  const response = await post(request({ stream: true }));
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  const events = (await response.text()).trim().split('\n\n').map((event) => JSON.parse(event.split('\ndata: ')[1]));
  assert.deepEqual(events.map((event) => event.type), ['message_start', 'content_block_start',
    'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
  assert.equal(events[2].delta.text, 'Hello back');
  assert.equal(events[4].delta.stop_reason, 'end_turn');
});

test('authentication and browser-origin rejection happen before inference', async (t) => {
  let calls = 0;
  const { post } = await withBridge(t, async () => { calls++; return answer(); });
  assert.equal((await post(request(), { 'x-api-key': 'wrong' })).status, 401);
  assert.equal((await post(request(), { origin: 'https://untrusted.example' })).status, 403);
  assert.equal(calls, 0);
});

test('unsupported options, malformed blocks and orphan tool results fail once, without inference or retries', async (t) => {
  let calls = 0;
  const { post } = await withBridge(t, async () => { calls++; return answer(); });
  for (const extra of [{ thinking: { type: 'enabled', budget_tokens: 1000 } },
    { messages: [{ role: 'user', content: [{ type: 'image', source: 'not-an-object' }] }] },
    { messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'orphan', content: 'x' }] }] }]) {
    const response = await post(request(extra));
    assert.equal(response.status, 502);
    assert.equal(response.headers.get('x-should-retry'), 'false');
  }
  assert.equal(calls, 0);
});

test('unknown tools and invalid tool inputs are rejected', async (t) => {
  const tools = [{ name: 'Read', input_schema: { type: 'object',
    properties: { file_path: { type: 'string' } }, required: ['file_path'] } }];
  let output = [{ type: 'tool_use', name: 'Bash', input: { command: 'touch never' } }];
  const { post } = await withBridge(t, async () => answer(output));
  assert.equal((await post(request({ tools }))).status, 502);
  output = [{ type: 'tool_use', name: 'Read', input: { file_path: 17 } }];
  assert.equal((await post(request({ tools }))).status, 502);
});

test('JSON Schema pattern is accepted and enforced on model tool calls', async (t) => {
  const tools = [{ name: 'Write', input_schema: { type: 'object', properties: {
    content: { type: 'string', pattern: '^[a-z]+$' } }, required: ['content'] } }];
  let content = 'valid';
  const { post } = await withBridge(t, async () => answer([{ type: 'tool_use', name: 'Write', input: { content } }]));
  assert.equal((await post(request({ tools }))).status, 200);
  content = 'INVALID';
  assert.equal((await post(request({ tools }))).status, 502);
});

test('JSON Schema propertyNames is accepted and enforced on model tool calls', async (t) => {
  const tools = [{ name: 'Config', input_schema: { type: 'object',
    propertyNames: { type: 'string', pattern: '^[a-z]+$' } } }];
  let input = { valid: true };
  const { post } = await withBridge(t, async () => answer([{ type: 'tool_use', name: 'Config', input }]));
  assert.equal((await post(request({ tools }))).status, 200);
  input = { INVALID: true };
  assert.equal((await post(request({ tools }))).status, 502);
});

test('deferred MCP tools and tool_reference results survive the public Messages loop', async (t) => {
  const tools = [{ name: 'ToolSearch', input_schema: { type: 'object' } },
    ...Array.from({ length: 129 }, (_, i) => ({ name: `mcp__demo__tool_${i}`, defer_loading: true, input_schema: true }))];
  const seen = [];
  const { post } = await withBridge(t, async (input) => {
    seen.push(input);
    return seen.length === 1 ? answer([{ type: 'tool_use', name: 'ToolSearch', input: {} }]) : answer();
  });
  const first = await (await post(request({ tools }))).json();
  assert.equal(first.stop_reason, 'tool_use');
  const messages = [...request().messages, { role: 'assistant', content: first.content },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: first.content[0].id,
      content: [{ type: 'tool_reference', tool_name: 'mcp__demo__tool_0' }] }] }];
  assert.equal((await post(request({ tools, messages }))).status, 200);
  assert.deepEqual(seen[1].messages, messages);
});

test('items:false accepts an empty array and rejects nonempty tool arguments', async (t) => {
  const tools = [{ name: 'OnlyEmpty', input_schema: { type: 'object', properties: {
    values: { type: 'array', items: false } }, required: ['values'], additionalProperties: false } }];
  let values = [];
  const { post } = await withBridge(t, async () => answer([{ type: 'tool_use', name: 'OnlyEmpty', input: { values } }]));
  assert.equal((await post(request({ tools }))).status, 200);
  values = ['not permitted'];
  const response = await post(request({ tools }));
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.message, 'INVALID_MODEL_TOOL_CALL');
});

test('tool_choice is enforced rather than silently ignored', async (t) => {
  const tools = [{ name: 'Read', input_schema: { type: 'object' } }];
  const { post } = await withBridge(t, async () => answer());
  assert.equal((await post(request({ tools, tool_choice: { type: 'tool', name: 'Read' } }))).status, 502);
});

test('token-count endpoint reports unsupported rather than inventing usage', async (t) => {
  const { post } = await withBridge(t, async () => answer());
  assert.equal((await post(request(), {}, '/v1/messages/count_tokens')).status, 501);
});

test('transport errors do not leak prompts or credentials', async (t) => {
  const { post } = await withBridge(t, async () => { throw Error('secret-value-in-provider-error'); });
  const response = await post(request());
  assert.equal(response.status, 502);
  const body = await response.text();
  assert.ok(!body.includes('secret-value'));
  assert.ok(body.includes('INFERENCE_FAILED'));
});

test('concurrent model requests are rejected instead of racing the shared login', async (t) => {
  let release;
  let entered;
  const ready = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const { post } = await withBridge(t, async () => { entered(); await gate; return answer(); });
  const first = post(request());
  await ready;
  assert.equal((await post(request())).status, 429);
  release();
  assert.equal((await first).status, 200);
});

test('streamed tool calls preserve JSON arguments and terminate with tool_use', async (t) => {
  const { post } = await withBridge(t, async () => answer([{ type: 'tool_use', name: 'Read', input: { file_path: '/fixture' } }]));
  const response = await post(request({ stream: true, tools: [{ name: 'Read', input_schema: { type: 'object' } }] }));
  const events = (await response.text()).trim().split('\n\n').map((event) => JSON.parse(event.split('\ndata: ')[1]));
  assert.equal(events[1].content_block.name, 'Read');
  assert.deepEqual(JSON.parse(events[2].delta.partial_json), { file_path: '/fixture' });
  assert.equal(events[4].delta.stop_reason, 'tool_use');
});

async function customBridge(t, options) {
  const token = randomUUID();
  const bridge = await createBridge({ token, ...options });
  t.after(() => bridge.close());
  const post = (body, path = '/v1/messages') => fetch(bridge.url + path, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': token }, body: JSON.stringify(body) });
  return { bridge, post };
}

test('deterministic provider failures tell Claude Code not to retry; transient ones may be retried', async (t) => {
  const { BridgeError, deterministic } = await import('../src/protocol.mjs');
  let error = deterministic('AGY_TIMEOUT');
  const { post } = await withBridge(t, async () => { throw error; });
  let response = await post(request());
  assert.equal(response.status, 502);
  assert.equal(response.headers.get('x-should-retry'), 'false');
  const body = await response.json();
  assert.equal(body.error.type, 'api_error');
  assert.match(body.error.message, /^AGY_TIMEOUT: .*faster model/);
  error = new BridgeError('AGY_QUOTA', 429);
  response = await post(request());
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('x-should-retry'), 'true');
  assert.equal((await response.json()).error.type, 'rate_limit_error');
  error = Error('secret-provider-detail');
  response = await post(request());
  assert.equal(response.status, 502);
  assert.equal(response.headers.get('x-should-retry'), 'true');
});

test('invalid model tool calls are final for Claude Code', async (t) => {
  const { post } = await withBridge(t, async () => answer([{ type: 'tool_use', name: 'Nope', input: {} }]));
  const response = await post(request({ tools: [{ name: 'Read', input_schema: { type: 'object' } }] }));
  assert.equal(response.status, 502);
  assert.equal(response.headers.get('x-should-retry'), 'false');
});

test('queued requests wait for the slot instead of failing, and give up after the queue timeout', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const { post } = await customBridge(t, { infer: async () => { if (!calls++) await gate; return answer(); }, queueTimeoutMs: 300 });
  const first = post(request());
  await new Promise((resolve) => setTimeout(resolve, 30));
  const second = post(request());
  await new Promise((resolve) => setTimeout(resolve, 30));
  release();
  assert.equal((await first).status, 200);
  assert.equal((await second).status, 200);
  let hold;
  const blocker = new Promise((resolve) => { hold = resolve; });
  const slow = await customBridge(t, { infer: async () => { await blocker; return answer(); }, queueTimeoutMs: 80 });
  const occupying = slow.post(request());
  await new Promise((resolve) => setTimeout(resolve, 30));
  const timedOut = await slow.post(request());
  assert.equal(timedOut.status, 429);
  assert.equal(timedOut.headers.get('x-should-retry'), 'true');
  hold();
  assert.equal((await occupying).status, 200);
});

test('count_tokens answers locally when an estimator is configured and needs no max_tokens', async (t) => {
  const { post } = await customBridge(t, { infer: async () => answer(), countTokens: (body) => body.messages.length * 1000 });
  const response = await post({ model: 'gemini-bridge', messages: [{ role: 'user', content: 'x' }] }, '/v1/messages/count_tokens');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { input_tokens: 1000 });
  assert.equal((await post({ model: 'm', messages: [] }, '/v1/messages/count_tokens')).status, 502);
});

test('streaming sends message_start at once, pings while waiting, and reports late errors as SSE', async (t) => {
  const { post } = await customBridge(t, { pingMs: 20, infer: async () => { await new Promise((resolve) => setTimeout(resolve, 130)); return answer(); } });
  const text = await (await post(request({ stream: true }))).text();
  assert.match(text, /^event: message_start/);
  assert.ok((text.match(/event: ping/g) ?? []).length >= 2);
  assert.ok(text.indexOf('event: message_stop') > text.lastIndexOf('event: ping'));
  const { deterministic } = await import('../src/protocol.mjs');
  const failing = await customBridge(t, { pingMs: 20, infer: async () => { throw deterministic('AGY_TIMEOUT'); } });
  const failed = await failing.post(request({ stream: true }));
  const body = await failed.text();
  assert.match(body, /event: error\ndata: \{"type":"error","error":\{"type":"api_error","message":"AGY_TIMEOUT: /);
  assert.ok(!body.includes('message_stop'));
});

test('request log entries carry status, timing, usage and meta but never prompt text', async (t) => {
  const entries = [];
  const { post } = await customBridge(t, { infer: async () => ({ ...answer(), meta: { session: 'reused' } }), log: (entry) => entries.push(entry) });
  await post(request({ messages: [{ role: 'user', content: 'PRIVATE_PROMPT' }] }));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].status, 200);
  assert.deepEqual(entries[0].meta, { session: 'reused' });
  assert.deepEqual(entries[0].usage, { input_tokens: 12, output_tokens: 7 });
  assert.equal(typeof entries[0].ms, 'number');
  assert.ok(!JSON.stringify(entries).includes('PRIVATE_PROMPT'));
});

test('more than 128 tools without defer_loading are accepted', async (t) => {
  const tools = Array.from({ length: 144 }, (_, i) => ({ name: `tool_${i}`, description: 'd', input_schema: { type: 'object' } }));
  const { post } = await withBridge(t, async () => answer());
  assert.equal((await post(request({ tools }))).status, 200);
});

test('images, documents and unknown blocks in tool results never poison the conversation', async (t) => {
  const seen = [];
  const { post } = await withBridge(t, async (input) => { seen.push(input); return answer(); });
  const png = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } };
  const gif = { type: 'image', source: { type: 'base64', media_type: 'image/gif', data: 'R0lGODlh' } };
  const doc = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' } };
  const odd = { type: 'search_result', content: [] };
  for (const entry of [png, gif, doc, odd]) {
    const messages = [{ role: 'user', content: 'look' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/x' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [entry] }] },
      { role: 'user', content: [...(entry.type === 'search_result' ? [] : [entry]), { type: 'text', text: 'again' }] }];
    const response = await post(request({ messages, tools: [{ name: 'Read', input_schema: { type: 'object' } }] }));
    assert.equal(response.status, 200, JSON.stringify(entry).slice(0, 40));
  }
  assert.equal(seen.length, 4);
});

test('structurally broken tool pairs are still rejected', async (t) => {
  const { post } = await withBridge(t, async () => answer());
  const response = await post(request({ messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'nope', content: [{ type: 'image', source: {} }] }] }] }));
  assert.equal(response.status, 502);
  assert.equal(response.headers.get('x-should-retry'), 'false');
});

test('fields, blocks and server tools from newer Claude Code versions are ignored, named in the log, and never fatal', async (t) => {
  const entries = [];
  const seen = [];
  const { post } = await customBridge(t, { infer: async (input) => { seen.push(input); return answer(); }, log: (entry) => entries.push(entry) });
  const tools = [{ name: 'Read', input_schema: { type: 'object' } }, { type: 'web_search_20250305', name: 'web_search', max_uses: 5 },
    { type: 'custom', name: 'Plain', description: 'd', input_schema: { type: 'object' } }];
  const messages = [{ role: 'user', content: [{ type: 'search_result', content: [] }, { type: 'text', text: 'hi' }] }];
  const response = await post(request({ safeguards: { mode: 'plan' }, brand_new_field: 1, context_management: {}, tools, messages }));
  assert.equal(response.status, 200);
  assert.deepEqual(seen[0].tools.map((tool) => tool.name), ['Read', 'Plain']);
  assert.ok(!('brand_new_field' in seen[0]));
  assert.deepEqual(entries[0].meta.ignoredFields, ['brand_new_field', 'context_management']);
  assert.deepEqual(entries[0].meta.ignoredTools, ['web_search']);
  assert.ok(!JSON.stringify(entries).includes('plan"'));
});

test('options that change meaning are still rejected once', async (t) => {
  const { post } = await withBridge(t, async () => answer());
  for (const extra of [{ thinking: { type: 'enabled', budget_tokens: 100 } }, { stop_sequences: ['x'] }, { temperature: -1 }, { output_config: { surprise: true } }]) {
    const response = await post(request(extra));
    assert.equal(response.status, 502, JSON.stringify(extra));
    assert.equal(response.headers.get('x-should-retry'), 'false');
  }
});

test('unfamiliar JSON Schema keywords never block a tool, while real violations are still caught', async (t) => {
  const schema = { type: 'object', required: ['name'], minProperties: 1, maxProperties: 3, nullable: true, 'x-vendor': { a: 1 },
    properties: { name: { type: 'string', not: { enum: ['forbidden'] }, readOnly: false, contentEncoding: 'x' }, mode: { type: 'any' } },
    if: { properties: { mode: { const: 'a' } } }, then: { required: ['extra'] }, dependentRequired: { name: ['mode'] }, patternProperties: { '^x': {} } };
  let input = { name: 'ok' };
  const { post } = await withBridge(t, async () => answer([{ type: 'tool_use', name: 'Odd', input }]));
  const tools = [{ name: 'Odd', input_schema: schema }];
  assert.equal((await post(request({ tools }))).status, 200);
  for (const bad of [{}, { name: 'forbidden' }, { name: 5 }, { name: 'a', b: 1, c: 2, d: 3 }]) {
    input = bad;
    const response = await post(request({ tools }));
    assert.equal(response.status, 502, JSON.stringify(bad));
    assert.equal(response.headers.get('x-should-retry'), 'false');
  }
  const malformed = [{ name: 'Odd', input_schema: { type: 'object', required: true, enum: 'x', anyOf: 'y', properties: 'z', items: [{}] } }];
  input = { anything: 1 };
  assert.equal((await post(request({ tools: malformed }))).status, 200);
});
