import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { agyArgs } from '../../src/agy-agent.mjs';

const args = process.argv.slice(2);
const model = args[args.indexOf('--model') + 1];
assert.deepEqual(args, agyArgs(model));
for (const key of ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'ANTHROPIC_API_KEY', 'AGY_ADC_AUTH', 'GOOGLE_CLOUD_ACCESS_TOKEN']) {
  assert.equal(process.env[key], undefined);
}

let stdin = '';
for await (const chunk of process.stdin) stdin += chunk;
const input = JSON.parse(stdin);
assert.equal(input.event, 'user');
const text = input.message.content;
const results = [...text.matchAll(/<tool_result id="[^"]*" error="(?:true|false)">\n([\s\S]*?)\n<\/tool_result>/g)].map((match) => match[1]);
const content = results.length ? [{ type: 'text', text: 'BRIDGE_HARNESS_OK' }]
  : [{ type: 'tool_use', name: 'Read', input: { file_path: process.env.FIXTURE_FILE } }];
assert.ok(results.length || text.includes('<tool name="Read">'));
await writeFile(path.join(process.env.HOME, `turn-${results.length}.json`), JSON.stringify({
  toolResultPresent: results.length > 0, toolResult: results[0],
}));

const emit = (event) => process.stdout.write(JSON.stringify(event) + '\n');
const id = 'synthetic-agy-conversation';
emit({ event: 'init', conversation_id: id, init: { model, permission_mode: 'request-review', tools: [] } });
emit({ event: 'step_update', step_update: { conversation_id: id, step_type: 'user_input', state: 'DONE' } });
emit({ event: 'result', result: { conversation_id: id, status: 'SUCCESS', num_turns: 1,
  response: JSON.stringify({ content }), usage: { input_tokens: 17, output_tokens: 6 } } });
