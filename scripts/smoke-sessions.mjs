// Real Claude Code + bridge + session pool with a synthetic long-lived agy process.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSessionPool } from '../src/agy-session-pool.mjs';
import { createAgyTransport } from '../src/agy-transport.mjs';
import { runHarness } from '../src/harness.mjs';
import { root } from '../src/paths.mjs';

const scratch = await mkdtemp(path.join(tmpdir(), 'claudecode-gemini-sessions-'));
let pool;
try {
  const file = path.join(scratch, 'fixture.txt');
  await writeFile(file, 'A synthetic fixture, not user data.\n');
  let spawned = 0;
  pool = createSessionPool({ spawnSession: (args) => {
    spawned++;
    return spawn(process.execPath, [path.join(root, 'test/fixtures/agy-session.mjs'), ...args],
      { env: { HOME: scratch, FIXTURE_FILE: file }, stdio: ['pipe', 'pipe', 'pipe'] });
  } });
  const infer = createAgyTransport({ model: 'gemini-4-neon-medium', pool });
  const result = await runHarness({ infer, isolated: true, capture: true, cwd: scratch, signal: AbortSignal.timeout(90_000),
    args: ['-p', 'Read the fixture file, then return the requested confirmation.', '--output-format', 'json', '--max-turns', '3',
      '--tools', 'Read', '--allowedTools', 'Read', '--permission-mode', 'dontAsk', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      '--disable-slash-commands', '--no-session-persistence', '--setting-sources', ''] });
  if (result.code !== 0) {
    console.error(JSON.stringify({ stage: 'claude-harness', code: result.code, stats: result.stats, diagnostic: result.stdout.slice(-2000), stderr: result.stderr.slice(-1000) }));
    process.exitCode = 1;
  } else {
    assert.ok(result.stdout.includes('BRIDGE_HARNESS_OK'));
    assert.ok(result.stats.requests >= 2);
    assert.equal(result.stats.toolCalls, 1);
    assert.equal(spawned, 1, 'one persistent session serves every turn');
    const events = (await readFile(path.join(scratch, 'events.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.ok(events[0].static && !events[0].delta);
    assert.ok(events.slice(1).every((event) => event.delta && !event.static && event.chars < events[0].chars));
    console.log(JSON.stringify({ status: 'pass', harness: 'real-claude-code', provider: 'simulated-persistent-agy', modelRequests: result.stats.requests,
      sessionsSpawned: spawned, eventChars: events.map((event) => event.chars), liveGoogle: false }));
  }
} finally { pool?.close(); await rm(scratch, { recursive: true, force: true }); }
