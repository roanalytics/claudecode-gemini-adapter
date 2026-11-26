import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgyInvoker, parseDenyRead, writeBridgeAgent } from '../src/agy-process.mjs';

const model = 'gemini-4-neon-medium';
const output = [
  { event: 'init', conversation_id: 'live', init: { model, permission_mode: 'strict' } },
  { event: 'result', result: { conversation_id: 'live', status: 'SUCCESS', num_turns: 1,
    response: '{"content":[{"type":"text","text":"OK"}]}', usage: { input_tokens: 10, output_tokens: 2 } } },
].map(JSON.stringify).join('\n');

test('live agy uses an allowlisted environment and permits only agy and its native credential helper', async () => {
  let observed;
  const execFile = (command, args, options, callback) => {
    observed = { command, args, options };
    callback(null, output, '');
    return { stdin: { on() {}, end() {} } };
  };
  const live = createAgyInvoker({ home: '/home/test', workspace: '/home/test/work', provider: '/tmp/provider',
    agy: '/home/test/.local/bin/agy', execFile, turnLimit: 1 });
  assert.equal(await live.invoke({ args: ['--model', model], stdin: '{}\n' }), output);
  assert.equal(observed.command, '/usr/bin/sandbox-exec');
  assert.equal(observed.args[0], '-p');
  assert.match(observed.args[1], /\(deny process-exec\)/);
  assert.match(observed.args[1], /\(allow process-exec \(literal "\/home\/test\/\.local\/bin\/agy"\)\)/);
  assert.match(observed.args[1], /\(allow process-exec \(literal "\/usr\/bin\/security"\)\)/);
  assert.match(observed.args[1], /\(deny file-read\*[\s\S]*\(subpath "\/home\/test\/work"\)/);
  assert.deepEqual(observed.options.env, { HOME: '/home/test', TMPDIR: '/tmp/provider', PATH: '/usr/bin:/bin',
    LANG: 'en_US.UTF-8', TERM: 'dumb' });
  assert.equal(observed.options.cwd, '/tmp/provider');
  assert.equal(live.calls, 1);
  await assert.rejects(live.invoke({ args: [], stdin: '' }), /CANARY_CALL_LIMIT/);
});

test('defaults avoid the CLI print timeout, bound diagnostics and keep sandbox noise out of the quota flag', async () => {
  const seen = [];
  const execFile = (command, args, options, callback) => {
    seen.push({ args, options });
    callback(null, output, 'E1125 12:00:00.000000 1 quota_manager.go:68] doRefreshQuota\nE1125 12:00:00.000000 1 x.go:1] operation not permitted\n');
    return { stdin: { on() {}, end() {} } };
  };
  const live = createAgyInvoker({ home: '/home/test', workspace: '/w', provider: '/tmp/p', agy: '/home/test/.local/bin/agy', execFile });
  for (let i = 0; i < 60; i++) await live.invoke({ args: ['--model', model], stdin: '{}\n' });
  assert.equal(live.diagnostics.length, 50);
  assert.equal(live.diagnostics.at(-1).quotaLimited, false);
  assert.equal(seen[0].args.at(-1), '0s');
  assert.equal(seen[0].args.at(-2), '--print-timeout');
  assert.equal(seen[0].options.timeout, 600_000);
  assert.equal(seen[0].options.maxBuffer, 8_000_000);
});

test('process failures expose only a filtered stderr tail and a timeout flag', async () => {
  const execFile = (command, args, options, callback) => {
    callback(Object.assign(Error('x'), { killed: true, signal: 'SIGKILL' }), '', 'E1125 12:00:00.000000 1 a.go:1] RESOURCE_EXHAUSTED\nE1125 12:00:00.000000 1 b.go:1] readonly database\n');
    return { stdin: { on() {}, end() {} } };
  };
  const live = createAgyInvoker({ home: '/home/test', workspace: '/w', provider: '/tmp/p', execFile });
  await assert.rejects(live.invoke({ args: ['--model', model], stdin: '{}\n' }), (error) =>
    error.message === 'AGY_PROCESS_FAILED' && error.timedOut === true && /RESOURCE_EXHAUSTED/.test(error.stderrTail) && !/readonly/.test(error.stderrTail));
  assert.equal(live.diagnostics.at(-1).quotaLimited, true);
});

test('spawnSession launches a sandboxed long-lived process with the same fixed flags', () => {
  let observed;
  const spawn = (command, args, options) => { observed = { command, args, options }; return {}; };
  const live = createAgyInvoker({ home: '/home/test', workspace: '/w', provider: '/tmp/p', agy: '/home/test/.local/bin/agy', spawn });
  live.spawnSession(['--model', model]);
  assert.equal(observed.command, '/usr/bin/sandbox-exec');
  assert.ok(observed.args.includes('--sandbox') && observed.args.includes('--disable-slash-commands'));
  assert.equal(observed.args[observed.args.indexOf('--print-timeout') + 1], '0s');
  assert.equal(observed.options.cwd, '/tmp/p');
  assert.deepEqual(observed.options.stdio, ['pipe', 'pipe', 'pipe']);
  assert.equal(live.calls, 1);
});

test('the bridge agent has no tools, MCP servers, skills or plugins', async () => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const dir = await mkdtemp((await import('node:path')).join(tmpdir(), 'agent-'));
  await writeBridgeAgent(dir);
  const text = await readFile(`${dir}/.agents/agents/claude-bridge.md`, 'utf8');
  for (const line of ['name: claude-bridge', 'mainAgent: true', 'tools: []', 'mcpServers: []', 'skills: []', 'plugins: []', 'commandExecutionPolicy: "off"']) {
    assert.ok(text.includes(line), line);
  }
  await rm(dir, { recursive: true, force: true });
});

test('sandbox denies generic credential locations and user extras, and nothing personal', () => {
  const live = createAgyInvoker({ home: '/home/test', workspace: '/home/test/work', provider: '/tmp/p', denyRead: ['/data/private'] });
  for (const entry of ['/home/test/work', '/home/test/.ssh', '/home/test/.aws', '/home/test/.config/gh', '/home/test/.claude', '/home/test/Documents', '/data/private']) {
    assert.ok(live.guard.includes(`(subpath "${entry}")`), entry);
  }
  assert.ok(live.guard.includes('[.]env'));
  assert.ok(!/Workspace|\.config\/ro/.test(live.guard));
});

test('CLAUDE_GEMINI_DENY_READ keeps only absolute paths and expands ~', () => {
  assert.deepEqual(parseDenyRead('~/code:/srv/x::relative/path: /opt/y ', '/home/test'), ['/home/test/code', '/srv/x', '/opt/y']);
  assert.deepEqual(parseDenyRead('', '/home/test'), []);
  assert.deepEqual(parseDenyRead(undefined, '/home/test'), []);
});
