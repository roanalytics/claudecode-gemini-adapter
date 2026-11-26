import assert from 'node:assert/strict';
import test from 'node:test';
import { SAFE_EVENT_CHARS } from '../src/agy-limits.mjs';
import { LATEST, compactSchema, createRenderContext, estimateTokens, hashMessage, hashSystem, renderConversation, renderFull,
  renderStatic, renderTool, splitEvents } from '../src/agy-render.mjs';

const tools = [{ name: 'Read', description: 'Read a file', input_schema: { type: 'object', properties: { file_path: { type: 'string' } } } },
  { name: 'mcp__demo__a', description: 'Deferred A', defer_loading: true, input_schema: { type: 'object' } },
  { name: 'mcp__demo__b', description: 'Deferred B', defer_loading: true, input_schema: { type: 'object' } }];
const memory = 'SessionStart:startup hook success: ## Memory from Previous Sessions\n\n### Recent Sessions\n- synthetic session\n\n# Environment\nPlatform: test';
const nudge = 'UserPromptSubmit hook additional context: CRITICAL FIRST ACTION - Execute this ToolSearch NOW before responding:\nselect:a,b\n\nAfter loading tools, call mem_context to check for prior session history before responding.\n\nToday is a day.';

test('render uses tagged sections, real newlines, defers unreferenced tools and escapes @', () => {
  const request = { system: [{ type: 'text', text: 'You are a harness.' }], tools, messages: [
    { role: 'user', content: 'mail me@example.com' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/x' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'tool_reference', tool_name: 'mcp__demo__a' }, { type: 'text', text: 'line1\nline2' }] }] }] };
  const { text } = renderFull(request);
  assert.match(text, /<harness_system>\nYou are a harness\.\n<\/harness_system>/);
  assert.match(text, /<tool name="Read">\nRead a file\ninput_schema: /);
  assert.match(text, /<tool name="mcp__demo__a">\nDeferred A/);
  assert.match(text, /<tool name="mcp__demo__b" deferred="true"\/>/);
  assert.match(text, /<tool_use id="toolu_1" name="Read">\{"file_path":"\/x"\}<\/tool_use>/);
  assert.match(text, /<tool_result id="toolu_1" error="false">\n\[tool loaded: mcp__demo__a\]\nline1\nline2\n<\/tool_result>/);
  assert.ok(text.includes('me\\u0040example.com') && !text.includes('me@example.com'));
  assert.ok(text.endsWith(LATEST));
});

test('lean profile drops claude-mem memory and engram nudges but keeps the rest; full context keeps everything', () => {
  const request = { messages: [{ role: 'system', content: memory }, { role: 'user', content: 'hola' }, { role: 'system', content: nudge }] };
  const lean = renderFull(request, { lean: true });
  assert.ok(!lean.text.includes('synthetic session') && !lean.text.includes('CRITICAL FIRST ACTION') && !lean.text.includes('After loading tools'));
  assert.ok(lean.text.includes('# Environment') && lean.text.includes('Platform: test') && lean.text.includes('Today is a day.'));
  assert.deepEqual(lean.omitted.map((entry) => entry.label), ['claude-mem session memory', 'engram first-action nudge', 'engram follow-up nudge']);
  const full = renderFull(request, { lean: false });
  assert.ok(full.text.includes('synthetic session') && full.text.includes('CRITICAL FIRST ACTION'));
  assert.equal(full.omitted.length, 0);
});

test('large skill lists are never filtered', () => {
  const skills = Array.from({ length: 200 }, (_, index) => `- skill-${index}: ${'does something useful '.repeat(5)}`).join('\n');
  assert.ok(renderFull({ messages: [{ role: 'user', content: skills }] }).text.includes('skill-199: does something useful'));
});

test('duplicate system paragraphs are sent once per session', () => {
  const line = 'Style guideline is active. Remember to follow the specific guidelines for this style.';
  const seen = new Set();
  const context = createRenderContext({ lean: true, seen });
  const first = renderConversation([{ role: 'system', content: line }, { role: 'user', content: 'x' }, { role: 'system', content: line }], context);
  assert.equal(first.split(line).length - 1, 1);
  const second = renderConversation([{ role: 'system', content: line }], createRenderContext({ lean: true, seen }));
  assert.ok(!second.includes(line));
});

test('message hashes ignore cache_control and tool inputs but not text, ids or tool output', () => {
  const base = { role: 'user', content: [{ type: 'text', text: 'hi' }] };
  assert.equal(hashMessage(base), hashMessage({ role: 'user', content: 'hi' }));
  assert.equal(hashMessage(base), hashMessage({ role: 'user', content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }] }));
  assert.notEqual(hashMessage(base), hashMessage({ role: 'user', content: 'ho' }));
  const use = (input) => ({ role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_a', name: 'Read', input }] });
  assert.equal(hashMessage(use({ a: 1 })), hashMessage(use({ a: 2 })));
  const result = (text) => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_a', content: text }] });
  assert.notEqual(hashMessage(result('one')), hashMessage(result('two')));
  assert.equal(hashSystem([{ type: 'text', text: 'a' }]), hashSystem([{ type: 'text', text: 'a', cache_control: {} }]));
});

test('events never exceed the safe size and every non-final part asks for READY', () => {
  const body = Array.from({ length: 500 }, (_, index) => `line ${index} ${'x'.repeat(60)}\n`).join('');
  const events = splitEvents(body, { limit: 5000 });
  assert.ok(events.length > 5);
  for (const event of events) assert.ok(event.length <= 5000, String(event.length));
  events.slice(0, -1).forEach((event, index) => assert.match(event, new RegExp(`^\\[context part ${index + 1}/${events.length} — reply with`)));
  assert.match(events.at(-1), new RegExp(`^\\[context part ${events.length}/${events.length} — final part\\]`));
  assert.ok(events.at(-1).endsWith(LATEST));
  assert.equal(events.map((event) => event.replace(/^\[context part[^\n]*\n/, '').replace(LATEST, '')).join(''), body);
  assert.deepEqual(splitEvents('short\n'), [`short\n${LATEST}`]);
  assert.ok(SAFE_EVENT_CHARS < 192_000);
});

test('token estimate grows with the request and has a floor for the provider baseline', () => {
  const small = estimateTokens({ messages: [{ role: 'user', content: 'x' }] });
  const large = estimateTokens({ messages: [{ role: 'user', content: 'x'.repeat(36_000) }] });
  assert.ok(small >= 5000 && large - small >= 9000);
  assert.ok(renderStatic({ system: 'S', tools: [] }, createRenderContext()).includes('<tools>\n\n</tools>'));
});

test('lean rules can be replaced from a JSON file and are validated', async () => {
  const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const { loadLeanRules, LEAN_RULES, leanText } = await import('../src/agy-render.mjs');
  assert.equal(loadLeanRules({}), LEAN_RULES);
  const dir = await mkdtemp(path.join(tmpdir(), 'lean-'));
  try {
    const file = path.join(dir, 'rules.json');
    await writeFile(file, JSON.stringify([{ label: 'noise', paragraph: '^NOISE ' }]));
    const rules = loadLeanRules({ CLAUDE_GEMINI_LEAN_FILTERS: file });
    const omitted = [];
    assert.equal(leanText('keep\n\nNOISE words\n\nkeep too', omitted, rules), 'keep\n\n[omitted by lean profile: noise]\n\nkeep too');
    assert.deepEqual(omitted.map((entry) => entry.label), ['noise']);
    for (const bad of ['{"label":"x"}', '[{"label":"x"}]', '[{"label":"x","paragraph":"("}]', 'not json']) {
      await writeFile(file, bad);
      assert.throws(() => loadLeanRules({ CLAUDE_GEMINI_LEAN_FILTERS: file }), { message: 'INVALID_LEAN_FILTERS' });
    }
    assert.throws(() => loadLeanRules({ CLAUDE_GEMINI_LEAN_FILTERS: path.join(dir, 'missing.json') }), { message: 'INVALID_LEAN_FILTERS' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('images, documents and unknown blocks render as placeholders and never leak base64', () => {
  const data = 'QUJD'.repeat(500);
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data } };
  const document = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } };
  const request = { messages: [
    { role: 'user', content: [image, { type: 'text', text: 'what is this?' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [image, document, { type: 'search_result' }] }] }] };
  const { text } = renderFull(request);
  assert.ok(!text.includes('QUJD'));
  assert.equal(text.split('this Gemini route does not receive images').length - 1, 2);
  assert.ok(text.includes('[document omitted:') && text.includes('[search_result block omitted]'));
  const same = { ...request, messages: request.messages.map((m) => ({ ...m, content: m.content.map((b) => b.type === 'image' ? { ...b, source: { ...b.source, data: 'Wlla' } } : b) })) };
  assert.equal(hashMessage(request.messages[0]), hashMessage(same.messages[0]));
});

test('unknown block types in messages render as placeholders', () => {
  const { text } = renderFull({ messages: [{ role: 'user', content: [{ type: 'search_result', content: [] }, { type: 'text', text: 'hi' }] },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'secret chain of thought' }, { type: 'text', text: 'ok' }] }] });
  assert.ok(text.includes('[search_result block omitted]') && text.includes('[thinking block omitted]'));
  assert.ok(!text.includes('secret chain of thought'));
});

test('compactSchema strips $schema and trims verbose nested property descriptions while keeping constraints', () => {
  const longDesc = 'First clear sentence. ' + 'Extra verbose explanation that repeats what the first sentence already covered. '.repeat(5);
  const tool = {
    name: 'Demo',
    description: 'Top description.\n\n\n\nStill kept intact.',
    input_schema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      additionalProperties: false,
      required: ['mode'],
      properties: {
        mode: { type: 'string', enum: ['fast', 'safe'], description: longDesc },
        code: { type: 'string', pattern: '^[A-Z]+$', description: 'Short.' },
      },
    },
  };
  const compacted = compactSchema(tool.input_schema);
  assert.equal(compacted.$schema, undefined);
  assert.equal(compacted.additionalProperties, false);
  assert.deepEqual(compacted.required, ['mode']);
  assert.deepEqual(compacted.properties.mode.enum, ['fast', 'safe']);
  assert.equal(compacted.properties.code.pattern, '^[A-Z]+$');
  assert.ok(compacted.properties.mode.description.length <= 200);
  assert.ok(compacted.properties.mode.description.startsWith('First clear sentence.'));
  assert.equal(compacted.properties.code.description, 'Short.');
  const leanOut = renderTool(tool, new Set(), { lean: true });
  const fullOut = renderTool(tool, new Set(), { lean: false });
  assert.ok(!leanOut.includes('$schema') && fullOut.includes('$schema'));
  assert.ok(leanOut.includes('Top description.\n\nStill kept intact.'));
  assert.ok(leanOut.length < fullOut.length);
});
