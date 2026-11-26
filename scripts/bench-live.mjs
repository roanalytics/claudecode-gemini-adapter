// Live measurements against the official agy CLI. Synthetic text only; never reads user transcripts.
// Run outside the macOS sandbox (network + keychain): npm run bench:live
import { mkdtemp, realpath, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { AGENT_NAME, writeBridgeAgent } from '../src/agy-agent.mjs';
import { createAgyInvoker } from '../src/agy-process.mjs';
import { resolveBinary } from '../src/binaries.mjs';
import { root } from '../src/paths.mjs';

const provider = await realpath(await mkdtemp(path.join(tmpdir(), 'bench-agy-')));
await writeBridgeAgent(provider);
const live = createAgyInvoker({ workspace: path.join(provider, 'ws'), provider, timeoutMs: 300_000, agy: resolveBinary('agy', 'CLAUDE_GEMINI_AGY_BIN') });
const filler = await readFile(path.join(root, 'src/protocol.mjs'), 'utf8');
const base = ['--input-format', 'stream-json', '--output-format', 'stream-json', '--mode', 'plan'];
const resultOf = (stdout) => stdout.trim().split('\n').map((line) => JSON.parse(line)).find((event) => event.event === 'result').result;
const once = async (model, content, extra = []) => {
  const started = Date.now();
  const result = resultOf(await live.invoke({ args: [...base, '--model', model, ...extra], stdin: JSON.stringify({ event: 'user', message: { content } }) + '\n' }));
  return { seconds: (Date.now() - started) / 1000, usage: result.usage, response: result.response, finished: result.finished_reason };
};

async function truncation() {
  let lo = 150_000, hi = 260_000;
  const keeps = async (size) => {
    const marker = `OMEGA-END-${size}`;
    let body = '';
    for (let i = 0; body.length < size - 600; i++) body += `\n[CHUNK ${i}]\n${filler}`;
    const prompt = `${body.slice(0, size - 600)}\nThe final secret word is ${marker}.\nReply with only the final secret word.`;
    const run = await once('gemini-3.8-flash-low', prompt);
    return { size: prompt.length, kept: run.response.includes(marker) };
  };
  if (!(await keeps(lo)).kept) return { error: 'floor already truncated', lo };
  while (hi - lo > 4_000) {
    const mid = Math.floor((lo + hi) / 2);
    if ((await keeps(mid)).kept) lo = mid; else hi = mid;
  }
  return { intactChars: lo, truncatedChars: hi };
}

async function session() {
  const args = [...base, '--model', 'gemini-4-neon-medium', '--agent', AGENT_NAME];
  const child = live.spawnSession(args);
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const turn = async (content) => {
    const started = Date.now();
    child.stdin.write(JSON.stringify({ event: 'user', message: { content } }) + '\n');
    for (;;) {
      const { value, done } = await lines.next();
      if (done) throw Error('SESSION_ENDED');
      let event; try { event = JSON.parse(value); } catch { continue; }
      if (event.event === 'result') return { seconds: (Date.now() - started) / 1000, usage: event.result.usage, turns: event.result.num_turns,
        conversation: event.result.conversation_id, response: event.result.response.slice(0, 160) };
    }
  };
  const tools = '<tools>\n<tool name="Read">\nRead a file\ninput_schema: {"type":"object","properties":{"file_path":{"type":"string"}},"required":["file_path"]}\n</tool>\n</tools>';
  const results = [];
  results.push(await turn(`${tools}\n<conversation>\n<message role="user">\nRead /tmp/a.txt\n</message>\n</conversation>\n<latest_turn>Respond with the JSON envelope only.</latest_turn>`));
  results.push(await turn('<conversation_delta>\n<message role="user">\n<tool_result id="t1" error="false">\nhello\n</tool_result>\n</message>\n</conversation_delta>\n<latest_turn>Respond with a text block quoting the file content.</latest_turn>'));
  results.push(await turn('<conversation_delta>\n<message role="user">\nNow read /tmp/b.txt\n</message>\n</conversation_delta>\n<latest_turn>Respond with the JSON envelope only.</latest_turn>'));
  child.stdin.end();
  return results;
}

const out = { truncation: await truncation(), session: await session() };
const hello = [await once('gemini-4-neon-medium', 'Di OK'), await once('gemini-4-neon-medium', 'Di OK', ['--agent', AGENT_NAME])];
out.overhead = { defaultAgentInputTokens: hello[0].usage.input_tokens, bridgeAgentInputTokens: hello[1].usage.input_tokens };
console.log(JSON.stringify(out, null, 1));
await rm(provider, { recursive: true, force: true });
