import assert from 'node:assert/strict';
import test from 'node:test';
import { extractEnvelope as extract, looseJsonParse } from '../src/agy-envelope.mjs';

// Tests below read the blocks; empty and invalid answers are asserted through the full result.
const extractEnvelope = (text, tools) => { const result = extract(text, tools); return result.content ?? (result.empty ? null : result); };

const tools = ['Read', 'Bash'];
const read = { type: 'tool_use', name: 'Read', input: { file_path: '/x' } };

test('clean envelopes pass through unchanged', () => {
  assert.deepEqual(extractEnvelope('{"content":[{"type":"text","text":"hi"}]}\n', tools), [{ type: 'text', text: 'hi' }]);
  assert.deepEqual(extractEnvelope(JSON.stringify({ content: [read] }), tools), [read]);
});

test('Markdown fences and leading prose around the envelope are removed', () => {
  assert.deepEqual(extractEnvelope('```json\n{"content":[{"type":"text","text":"a"}]}\n```', tools), [{ type: 'text', text: 'a' }]);
  const mixed = '```json\n{"name":"Read","arguments":{"file_path":"/old"}}\n```\n{"content":[{"type":"text","text":"final"}]}';
  assert.deepEqual(extractEnvelope(mixed, tools), [{ type: 'text', text: 'final' }]);
  assert.deepEqual(extractEnvelope('I will read it.\n{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"/x"}}]}', tools), [read]);
});

test('duplicated envelopes resolve to the last valid one', () => {
  const one = '{"content":[{"type":"text","text":"same"}]}';
  assert.deepEqual(extractEnvelope(`${one}\n${one}\nThe task is complete.`, tools), [{ type: 'text', text: 'same' }]);
});

test('common tool-call variants normalize to tool_use only for offered tools', () => {
  for (const text of ['{"tool_call":{"name":"Read","arguments":{"file_path":"/x"}}}', '{"name":"Read","arguments":{"file_path":"/x"}}',
    '{"tool":"Read","arguments":{"file_path":"/x"}}', '{"content":[{"name":"Read","arguments":{"file_path":"/x"}}]}']) {
    assert.deepEqual(extractEnvelope(text, tools), [read], text);
  }
  assert.deepEqual(extractEnvelope('{"name":"Nope","arguments":{}}', tools), [{ type: 'text', text: '{"name":"Nope","arguments":{}}' }]);
});

test('braces inside strings do not break extraction', () => {
  const text = 'noise {"content":[{"type":"text","text":"a } b { c"}]}';
  assert.deepEqual(extractEnvelope(text, tools), [{ type: 'text', text: 'a } b { c' }]);
});

test('plain text and unrelated JSON become a text block; empty output is null', () => {
  assert.deepEqual(extractEnvelope('just words', tools), [{ type: 'text', text: 'just words' }]);
  assert.deepEqual(extractEnvelope('{"entries":96}', tools), [{ type: 'text', text: '{"entries":96}' }]);
  assert.equal(extractEnvelope('   \n', tools), null);
  assert.equal(extractEnvelope('', tools), null);
});

test('unescaped double quotes and raw newlines inside code strings are repaired (the Edit regression)', () => {
  const broken = '{"content":[{"type":"tool_use","name":"Edit","input":{"file_path":"/tmp/n.ipynb","old_string":"x = 1","new_string":"Load NotebookEdit if deferred, insert a cell with content "# ${m}", then delete cell c1. Reply DONE."}}]}';
  const result = extract(broken, ['Edit']);
  assert.equal(result.content[0].name, 'Edit');
  assert.equal(result.content[0].input.new_string, 'Load NotebookEdit if deferred, insert a cell with content "# ${m}", then delete cell c1. Reply DONE.');
  const multiline = '{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"a.js","content":"const s = "hi";\nconst t = obj["k"];\n"}}]}';
  const written = extract(multiline, ['Write']).content[0].input.content;
  assert.equal(written, 'const s = "hi";\nconst t = obj["k"];\n');
});

test('invalid escapes, trailing commas and fenced broken JSON are repaired', () => {
  const text = '```json\n{"content":[{"type":"tool_use","name":"Bash","input":{"command":"echo \\\'a\\\' \\$HOME",}},],}\n```';
  assert.equal(extract(text, ['Bash']).content[0].input.command, "echo 'a' $HOME");
  assert.deepEqual(looseJsonParse('{"a":[1,2,],"b":"x\ty"}'), { a: [1, 2], b: 'x\ty' });
  assert.deepEqual(looseJsonParse('{"a":"k: "v", more","b":[true,null]}'), { a: 'k: "v", more', b: [true, null] });
  assert.equal(looseJsonParse('{"a": '), undefined);
});

test('valid JSON is never altered by the lenient reader', () => {
  const value = { content: [{ type: 'text', text: 'He said \\"hi\\" \\\\ and\nleft' }], n: [1, -2.5e3, true, null] };
  assert.deepEqual(looseJsonParse(JSON.stringify(value)), value);
});

test('an irreparable envelope is reported as invalid JSON with context, never returned as text', () => {
  const result = extract('{"content":[{"type":"tool_use","name":"Read","input":{"file_path":', ['Read']);
  assert.equal(result.content, undefined);
  assert.ok(result.invalidJson.message.length > 0);
  assert.equal(typeof result.invalidJson.near, 'string');
  assert.ok(extract('Here is my plan:\n{"content": [broken', ['Read']).invalidJson);
});

test('a parsed object that is not an envelope stays plain text', () => {
  assert.deepEqual(extract('{"content":"just a string"}', ['Read']).content, [{ type: 'text', text: '{"content":"just a string"}' }]);
  assert.equal(extract('', []).empty, true);
});
