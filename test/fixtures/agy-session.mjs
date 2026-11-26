// Synthetic long-lived `agy` stand-in: one NDJSON `user` event per line, one `result` per event.
// FIXTURE_MODE: hang (never answers) | badtool-once | badtool-always | empty-once | crash-after-first
import assert from 'node:assert/strict';
import { appendFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { agyArgs } from '../../src/agy-agent.mjs';

const args = process.argv.slice(2);
const model = args[args.indexOf('--model') + 1];
assert.deepEqual(args, agyArgs(model));
const mode = process.env.FIXTURE_MODE ?? '';
const id = `synthetic-session-${process.pid}`;
const emit = (event) => process.stdout.write(JSON.stringify(event) + '\n');
let outTotal = 0, turns = 0, bad = 0, empties = 0, broken = 0, readKnown = false;

for await (const line of createInterface({ input: process.stdin })) {
  const text = JSON.parse(line).message.content;
  turns++;
  appendFileSync(path.join(process.env.HOME, 'events.jsonl'), JSON.stringify({ pid: process.pid, turn: turns, chars: text.length,
    static: text.includes('<harness_system>'), delta: text.includes('<conversation_delta>'),
    part: /\[context part (\d+)\/(\d+)/.exec(text)?.slice(1, 3), lean: text.includes('[omitted by lean profile') }) + '\n');
  if (mode === 'hang') continue;
  if (turns === 1) emit({ event: 'init', conversation_id: id, init: { model, permission_mode: 'request-review', tools: [] } });
  emit({ event: 'step_update', step_update: { conversation_id: id, step_type: 'user_input', state: 'DONE' } });
  if (text.includes('<tool name="Read"')) readKnown = true;
  const waiting = /\[context part \d+\/\d+ — reply with/.test(text);
  let response;
  if (waiting) response = { content: [{ type: 'text', text: 'READY' }] };
  else if (mode === 'empty-once' && !empties++) response = '';
  else if (mode === 'brokenjson-always' || (mode === 'brokenjson-once' && !broken++)) response = '{"content":[{"type":"tool_use","name":"Read","input":{"file_path":';
  else if (mode === 'badtool-always' || (mode === 'badtool-once' && !bad++)) response = { content: [{ type: 'tool_use', name: 'NoSuchTool', input: {} }] };
  else if (text.includes('<tool_result')) {
    const results = [...text.matchAll(/<tool_result id="[^"]*" error="(?:true|false)">\n([\s\S]*?)\n<\/tool_result>/g)].map((match) => match[1]);
    writeFileSync(path.join(process.env.HOME, `result-${turns}.json`), JSON.stringify({ results }));
    response = { content: [{ type: 'text', text: 'BRIDGE_HARNESS_OK' }] };
  } else if (readKnown) response = { content: [{ type: 'tool_use', name: 'Read', input: { file_path: process.env.FIXTURE_FILE ?? '/fixture' } }] };
  else response = { content: [{ type: 'text', text: 'no tools' }] };
  emit({ event: 'step_update', step_update: { conversation_id: id, step_type: 'agent_response', state: 'DONE' } });
  emit({ event: 'result', result: { conversation_id: id, status: 'SUCCESS', num_turns: turns,
    response: typeof response === 'string' ? response : JSON.stringify(response), usage: { input_tokens: 100 + turns, output_tokens: (outTotal += 6), cache_read_tokens: turns * 10 } } });
  if (mode === 'crash-after-first' && turns === 1) process.exit(1);
}
