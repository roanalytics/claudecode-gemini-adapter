import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createSessionPool } from '../src/agy-session-pool.mjs';
import { createAgyTransport } from '../src/agy-transport.mjs';
import { makeMessage } from '../src/protocol.mjs';

const fixture = path.join(import.meta.dirname, 'fixtures/agy-session.mjs');
const model = 'gemini-4-neon-medium';
const tools = [{ name: 'Read', description: 'Read a file', input_schema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } }];
const system = [{ type: 'text', text: 'You are a harness.' }];
const user = (content) => ({ role: 'user', content });

async function setup(t, { mode = '', pool: options = {} } = {}) {
  const home = await mkdtemp(path.join(tmpdir(), 'agy-pool-'));
  const file = path.join(home, 'fixture.txt');
  await writeFile(file, 'A synthetic fixture.\n');
  const spawned = [];
  const pool = createSessionPool({ spawnSession: (args) => {
    const child = spawn(process.execPath, [fixture, ...args], { env: { HOME: home, FIXTURE_FILE: file, FIXTURE_MODE: mode }, stdio: ['pipe', 'pipe', 'pipe'] });
    spawned.push(child);
    return child;
  }, ...options });
  t.after(async () => { pool.close(); await rm(home, { recursive: true, force: true }); });
  const infer = createAgyTransport({ model, pool });
  const events = async () => (await readFile(path.join(home, 'events.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  // Answer as the bridge would: ids are assigned by the pool and kept by makeMessage.
  const ask = async (messages, extra = {}) => {
    const request = { model, max_tokens: 1000, system, tools, messages, ...extra };
    const out = await infer(request);
    return { out, message: makeMessage(request, out), request };
  };
  return { pool, spawned, events, ask, home, file };
}

test('first request bootstraps a session; the follow-up sends only the delta to the same process', async (t) => {
  const { ask, events, spawned, pool } = await setup(t);
  const first = await ask([user('Read the file')]);
  assert.equal(first.out.meta.session, 'new');
  assert.equal(first.message.content[0].type, 'tool_use');
  const messages = [user('Read the file'), { role: 'assistant', content: first.message.content },
    user([{ type: 'tool_result', tool_use_id: first.message.content[0].id, content: 'A synthetic fixture.' }])];
  const second = await ask(messages);
  assert.equal(second.out.meta.session, 'reused');
  assert.equal(second.message.content[0].text, 'BRIDGE_HARNESS_OK');
  assert.equal(spawned.length, 1);
  assert.equal(pool.size, 1);
  const log = await events();
  assert.equal(log.length, 2);
  assert.ok(log[0].static && !log[0].delta);
  assert.ok(log[1].delta && !log[1].static);
  assert.ok(log[1].chars < log[0].chars);
  assert.deepEqual(second.out.meta.events, [log[1].chars]);
  assert.equal(second.out.usage.input_tokens, 102);
});

test('a history that diverges from the session prefix opens a fresh session', async (t) => {
  const { ask, spawned } = await setup(t);
  const first = await ask([user('Read the file')]);
  await ask([user('Read the file'), { role: 'assistant', content: first.message.content }, user('thanks')]);
  assert.equal(spawned.length, 1);
  const forked = await ask([user('A different conversation')]);
  assert.equal(forked.out.meta.session, 'new');
  assert.equal(spawned.length, 2);
});

test('oversized context is split into READY parts and never exceeds the event limit', async (t) => {
  const { ask, events } = await setup(t, { pool: { safeChars: 4000 } });
  const big = Array.from({ length: 400 }, (_, index) => `row ${index} ${'y'.repeat(50)}`).join('\n');
  const { out } = await ask([user(big)]);
  const log = await events();
  assert.ok(log.length > 3);
  for (const entry of log) assert.ok(entry.chars <= 4000, String(entry.chars));
  assert.equal(out.meta.parts, log.length);
  assert.deepEqual(log.at(-1).part, [String(log.length), String(log.length)]);
  assert.equal(out.content[0].type, 'tool_use');
});

test('lean profile omissions are reported without prompt text', async (t) => {
  const { ask, events } = await setup(t);
  const memory = 'SessionStart:startup hook success: ## Memory from Previous Sessions\n\nsynthetic\n\n# Environment\nx';
  const { out } = await ask([{ role: 'system', content: memory }, user('hi')]);
  assert.deepEqual(Object.keys(out.meta.omitted), ['claude-mem session memory']);
  assert.ok((await events())[0].lean);
  assert.ok(!JSON.stringify(out.meta).includes('synthetic'));
});

test('an invalid tool call gets one repair turn inside the same session; a second failure is final and drops the session', async (t) => {
  const once = await setup(t, { mode: 'badtool-once' });
  const repaired = await once.ask([user('Read the file')]);
  assert.equal(repaired.message.content[0].name, 'Read');
  assert.equal((await once.events()).length, 2);
  const always = await setup(t, { mode: 'badtool-always' });
  await assert.rejects(always.ask([user('Read the file')]), (error) => error.message === 'INVALID_MODEL_TOOL_CALL' && error.retry === false);
  assert.equal(always.pool.size, 0);
});

test('an empty answer is repaired once', async (t) => {
  const { ask, events } = await setup(t, { mode: 'empty-once' });
  const { message } = await ask([user('Read the file')]);
  assert.equal(message.content[0].name, 'Read');
  assert.equal((await events()).length, 2);
});

test('a session that dies is replaced once; the error is final if the fresh session also fails', async (t) => {
  const { ask, spawned, pool } = await setup(t, { mode: 'crash-after-first' });
  const first = await ask([user('Read the file')]);
  await new Promise((resolve) => spawned[0].once('close', resolve));
  const messages = [user('Read the file'), { role: 'assistant', content: first.message.content },
    user([{ type: 'tool_result', tool_use_id: first.message.content[0].id, content: 'ok' }])];
  const second = await ask(messages);
  assert.equal(second.out.meta.session, 'new');
  assert.equal(spawned.length, 2);
  assert.equal(pool.size, 1);
});

test('turn timeout is deterministic, kills the process and removes the session', async (t) => {
  const { ask, spawned, pool } = await setup(t, { mode: 'hang', pool: { turnTimeoutMs: 150 } });
  await assert.rejects(ask([user('Read the file')]), (error) => error.message === 'AGY_TIMEOUT' && error.retry === false && error.status === 502);
  await new Promise((resolve) => (spawned[0].exitCode !== null || spawned[0].signalCode ? resolve() : spawned[0].once('close', resolve)));
  assert.equal(pool.size, 0);
});

test('client abort kills the session process', async (t) => {
  const { pool, spawned } = await setup(t, { mode: 'hang', pool: { turnTimeoutMs: 5000 } });
  const infer = createAgyTransport({ model, pool });
  const controller = new AbortController();
  const pending = infer({ model, max_tokens: 100, system, tools, messages: [user('x')] }, controller.signal);
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(pending, { message: 'INFERENCE_ABORTED' });
  await new Promise((resolve) => (spawned[0].exitCode !== null || spawned[0].signalCode ? resolve() : spawned[0].once('close', resolve)));
  assert.equal(pool.size, 0);
});

test('pool cap evicts the least recently used idle session; idle sessions expire', async (t) => {
  const { ask, spawned, pool } = await setup(t, { pool: { maxSessions: 2, idleMs: 100 } });
  await ask([user('one')]);
  await ask([user('two')]);
  await ask([user('three')]);
  assert.equal(spawned.length, 3);
  assert.equal(pool.size, 2);
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(pool.size, 0);
});

test('new tools mid-session are announced in the delta', async (t) => {
  const { ask, events } = await setup(t);
  const first = await ask([user('Read the file')]);
  const messages = [user('Read the file'), { role: 'assistant', content: first.message.content }, user('continue')];
  const more = [...tools, { name: 'Write', description: 'Write a file', input_schema: { type: 'object' } }];
  const second = await ask(messages, { tools: more });
  assert.equal(second.out.meta.session, 'reused');
  assert.equal((await events()).length, 2);
});

test('a tool result carrying an image keeps the session reusable', async (t) => {
  const { ask, spawned } = await setup(t);
  const first = await ask([user('Read the picture')]);
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } };
  const messages = [user('Read the picture'), { role: 'assistant', content: first.message.content },
    user([{ type: 'tool_result', tool_use_id: first.message.content[0].id, content: [image] }])];
  const second = await ask(messages);
  assert.equal(second.out.meta.session, 'reused');
  const third = await ask([...messages, { role: 'assistant', content: second.message.content }, user('and now?')]);
  assert.equal(third.out.meta.session, 'reused');
  assert.equal(spawned.length, 1);
});

test('malformed JSON gets one repair turn with the parser context; a second failure is final and never leaks raw text', async (t) => {
  const once = await setup(t, { mode: 'brokenjson-once' });
  const repaired = await once.ask([user('Read the file')]);
  assert.equal(repaired.message.content[0].name, 'Read');
  assert.equal((await once.events()).length, 2);
  const always = await setup(t, { mode: 'brokenjson-always' });
  await assert.rejects(always.ask([user('Read the file')]), (error) => error.message === 'INVALID_MODEL_JSON' && error.retry === false && error.status === 502);
  assert.equal(always.pool.size, 0);
});

test('usage is reported per request even though agy counts output and cache tokens cumulatively per session', async (t) => {
  const { ask } = await setup(t, { mode: 'empty-once' });
  const first = await ask([user('Read the file')]); // empty answer, then one repair turn: two agy turns
  assert.equal(first.out.usage.output_tokens, 12);
  const messages = [user('Read the file'), { role: 'assistant', content: first.message.content },
    user([{ type: 'tool_result', tool_use_id: first.message.content[0].id, content: 'ok' }])];
  const second = await ask(messages);
  assert.equal(second.out.usage.output_tokens, 6);
  assert.equal(second.out.meta.cacheRead, 10);
  const third = await ask([...messages, { role: 'assistant', content: second.message.content }, user('thanks')]);
  assert.equal(third.out.usage.output_tokens, 6);
  assert.equal(third.out.meta.cacheRead, 10);
});
