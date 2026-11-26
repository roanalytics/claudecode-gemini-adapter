// Real Claude Code against the bridge with a simulated one-shot agy process (no account needed).
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAgyTransport } from '../src/agy-transport.mjs';
import { runHarness } from '../src/harness.mjs';
import { root } from '../src/paths.mjs';

assert.equal(process.argv.length, 2);
const scratch = await mkdtemp(path.join(tmpdir(), 'claudecode-gemini-smoke-'));
try {
  const file = path.join(scratch, 'fixture.txt');
  await writeFile(file, 'A synthetic fixture, not user data.\n');
  const infer = createAgyTransport({ model: 'gemini-4-neon-medium', invoke: ({ args, stdin, signal }) => new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [path.join(root, 'test/fixtures/agy.mjs'), ...args], {
      cwd: scratch, env: { HOME: scratch, FIXTURE_FILE: file }, signal, timeout: 10_000, maxBuffer: 1_000_000,
    }, (error, stdout) => error ? reject(error) : resolve(stdout));
    child.stdin.on('error', () => {});
    child.stdin.end(stdin);
  }) });
  const result = await runHarness({ infer, isolated: true, capture: true, cwd: scratch,
    signal: AbortSignal.timeout(90_000), args: ['-p', 'Read the fixture file, then return the requested confirmation.',
      '--output-format', 'json', '--max-turns', '3', '--tools', 'Read', '--allowedTools', 'Read',
      '--permission-mode', 'dontAsk', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      '--disable-slash-commands', '--no-session-persistence', '--setting-sources', ''] });
  if (result.code !== 0) {
    console.error(JSON.stringify({ stage: 'claude-harness', code: result.code, signal: result.signal,
      stats: result.stats, diagnostic: result.stdout.slice(-2000), stderr: result.stderr.slice(-1000) }));
    process.exitCode = 1;
  } else {
    assert.ok(result.stdout.includes('BRIDGE_HARNESS_OK'));
    assert.ok(result.stats.requests >= 2);
    assert.equal(result.stats.toolCalls, 1);
    const replay = JSON.parse(await readFile(path.join(scratch, 'turn-1.json'), 'utf8'));
    assert.equal(replay.toolResultPresent, true);
    assert.ok(JSON.stringify(replay.toolResult).includes('A synthetic fixture'));
    console.log(JSON.stringify({ status: 'pass', harness: 'real-claude-code', provider: 'simulated-agy-process',
      modelRequests: result.stats.requests, toolCalls: result.stats.toolCalls, toolResultReplayed: true, liveGoogle: false }));
  }
} finally { await rm(scratch, { recursive: true, force: true }); }
