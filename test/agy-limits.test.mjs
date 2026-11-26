import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_MAX_CONCURRENT, DEFAULT_MAX_SESSIONS, resolveConcurrency } from '../src/agy-limits.mjs';
import { createLogger } from '../src/bridge-log.mjs';

test('resolveConcurrency returns defaults and scales maxSessions above custom maxConcurrent', () => {
  assert.deepEqual(resolveConcurrency({}), { maxConcurrent: DEFAULT_MAX_CONCURRENT, maxSessions: DEFAULT_MAX_SESSIONS });
  assert.deepEqual(resolveConcurrency({ CLAUDE_GEMINI_MAX_CONCURRENT: '  ' }), { maxConcurrent: 4, maxSessions: 6 });
  assert.deepEqual(resolveConcurrency({ CLAUDE_GEMINI_MAX_CONCURRENT: '8' }), { maxConcurrent: 8, maxSessions: 10 });
  assert.deepEqual(resolveConcurrency({ CLAUDE_GEMINI_MAX_CONCURRENT: '16' }), { maxConcurrent: 16, maxSessions: 18 });
  assert.deepEqual(resolveConcurrency({ CLAUDE_GEMINI_MAX_CONCURRENT: '6', CLAUDE_GEMINI_MAX_SESSIONS: '12' }), { maxConcurrent: 6, maxSessions: 12 });
  assert.deepEqual(resolveConcurrency({ CLAUDE_GEMINI_MAX_CONCURRENT: '6', CLAUDE_GEMINI_MAX_SESSIONS: '6' }), { maxConcurrent: 6, maxSessions: 6 });
});

test('resolveConcurrency rejects invalid or inconsistent concurrency settings', () => {
  for (const bad of ['0', '-1', '17', '2.5', 'abc']) {
    assert.throws(() => resolveConcurrency({ CLAUDE_GEMINI_MAX_CONCURRENT: bad }), /INVALID_MAX_CONCURRENT/);
  }
  for (const bad of ['0', '3', '33', '6.1', 'lots']) {
    assert.throws(() => resolveConcurrency({ CLAUDE_GEMINI_MAX_SESSIONS: bad }), /INVALID_MAX_SESSIONS/);
  }
  assert.throws(() => resolveConcurrency({ CLAUDE_GEMINI_MAX_CONCURRENT: '8', CLAUDE_GEMINI_MAX_SESSIONS: '6' }), /INVALID_MAX_SESSIONS/);
});

test('createLogger tags every line with process pid and rotates above maxBytes', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'claudecode-gemini-log-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'bridge.jsonl');
  const log = createLogger({ file, maxBytes: 120, enabled: true });
  log({ status: 200, id: 'a' });
  log({ status: 200, id: 'b', pad: 'x'.repeat(120) });
  log({ status: 200, id: 'c' });
  const lines = readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.ok(lines.length >= 1);
  for (const entry of lines) {
    assert.equal(entry.pid, process.pid);
    assert.equal(typeof entry.ts, 'string');
  }
  assert.ok(existsSync(`${file}.1`));
  const rotated = readFileSync(`${file}.1`, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(rotated[0].pid, process.pid);
  assert.equal(rotated[0].id, 'a');
});
