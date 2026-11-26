// Real Claude Code against a bridge whose provider always fails: deterministic failures must cost exactly one request.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runHarness } from '../src/harness.mjs';
import { BridgeError, deterministic, validateRequest } from '../src/protocol.mjs';

const scratch = await mkdtemp(path.join(tmpdir(), 'claudecode-gemini-errors-'));
const cases = {
  'AGY_TIMEOUT (502, deterministic)': () => { throw deterministic('AGY_TIMEOUT'); },
  'INVALID_MODEL_TOOL_CALL (502, retry false)': () => { throw new BridgeError('INVALID_MODEL_TOOL_CALL', 502, { retry: false }); },
  'request validation (INVALID_TOOLS, 502, retry false)': () => validateRequest({ model: 'm', max_tokens: 1, messages: [{ role: 'user', content: 'x' }], tools: 'broken' }),
};
const report = {};
try {
  for (const [name, fail] of Object.entries(cases)) {
    const result = await runHarness({ infer: async () => fail(), isolated: true, capture: true, cwd: scratch, signal: AbortSignal.timeout(90_000),
      args: ['-p', 'Say hi.', '--output-format', 'json', '--max-turns', '1', '--tools', 'Read', '--permission-mode', 'dontAsk',
        '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--disable-slash-commands', '--no-session-persistence', '--setting-sources', ''] });
    report[name] = { requests: result.stats.requests, exit: result.code, visible: /AGY_TIMEOUT|INVALID_MODEL_TOOL_CALL|INVALID_TOOLS/.test(result.stdout + result.stderr) };
    assert.equal(result.stats.requests, 1, `${name}: Claude Code retried (${result.stats.requests} requests)`);
    assert.notEqual(result.code, 0);
    assert.ok(report[name].visible, `${name}: error code not visible to the user`);
  }
  console.log(JSON.stringify({ status: 'pass', harness: 'real-claude-code', cases: report }));
} catch (error) {
  console.error(JSON.stringify({ status: 'failed', message: error.message, cases: report }));
  process.exitCode = 1;
} finally { await rm(scratch, { recursive: true, force: true }); }
