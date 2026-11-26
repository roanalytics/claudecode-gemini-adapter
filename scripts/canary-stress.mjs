// Multi-instance parallel stress canary: launches N independent `claude-gemini` instances simultaneously, each running
// parallel subagents, an MCP server (150+ tools via Tool Search), Read, Edit (with quotes) and Bash. Verifies zero
// cross-instance contamination, distinct bridge PIDs in the shared log, persistent session reuse, zero bridge errors,
// and clean temporary-directory cleanup. Run outside the macOS sandbox:
//   npm run canary:stress [-- --instances 3 --alias sonnet --timeout 420]
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_LOG } from '../src/bridge-log.mjs';
import { root } from '../src/paths.mjs';

const argv = process.argv.slice(2);
const value = (name) => { const at = argv.indexOf(`--${name}`); return at >= 0 ? argv[at + 1] : undefined; };
const instances = Number(value('instances') ?? '3');
if (!Number.isInteger(instances) || instances < 2 || instances > 6) {
  console.error('--instances must be an integer between 2 and 6');
  process.exit(1);
}
const alias = value('alias') ?? 'sonnet';
const timeoutSec = Number(value('timeout') ?? '420');
if (!Number.isInteger(timeoutSec) || timeoutSec < 60 || timeoutSec > 1800) {
  console.error('--timeout must be an integer between 60 and 1800 (seconds)');
  process.exit(1);
}
const maxConcurrent = value('max-concurrent');
const maxSessions = value('max-sessions');

const launcher = path.join(root, 'bin/claude-gemini.mjs');
const mcpFixture = path.join(root, 'test/fixtures/mcp-echo.mjs');
const tmpRoot = await realpath(tmpdir());
const base = await realpath(await mkdtemp(path.join(tmpRoot, 'claudecode-gemini-stress-')));
const token = (prefix) => `${prefix}_${randomBytes(3).toString('hex').toUpperCase()}`;

function snapshotTempDirs() {
  return new Set(readdirSync(tmpRoot).filter((name) => name.startsWith('claudecode-gemini-live-') || name.startsWith('claudecode-gemini-harness-')));
}

function logForPid(pid, startedAt) {
  if (!existsSync(DEFAULT_LOG)) return [];
  return readFileSync(DEFAULT_LOG, 'utf8').trim().split('\n')
    .flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } })
    .filter((entry) => entry.pid === pid && entry.ts >= startedAt);
}

async function prepareWorker(index) {
  const dir = path.join(base, `worker-${index}`);
  await mkdir(dir, { recursive: true });
  const tokens = {
    read: token(`W${index}R`),
    subA: token(`W${index}A`),
    subB: token(`W${index}B`),
    edit: token(`W${index}E`),
    mcp: token(`W${index}M`),
    bash: token(`W${index}S`),
  };
  const editedLine = `const label = "worker-${index} ${tokens.edit}";`;
  await writeFile(path.join(dir, 'input.txt'), `${tokens.read}\n`);
  await writeFile(path.join(dir, 'sub-a.txt'), `${tokens.subA}\n`);
  await writeFile(path.join(dir, 'sub-b.txt'), `${tokens.subB}\n`);
  await writeFile(path.join(dir, 'target.js'), 'const label = "OLD";\n');
  const mcpConfig = path.join(dir, 'mcp.json');
  await writeFile(mcpConfig, JSON.stringify({ mcpServers: { echo: { command: process.execPath, args: [mcpFixture] } } }));
  const prompt = [
    `Complete all of the following steps in this workspace:`,
    `1. In parallel, use Read on input.txt AND launch two general-purpose Agent subagents in parallel: one reads sub-a.txt and returns its first line, the other reads sub-b.txt and returns its first line.`,
    `2. Use Edit on target.js to replace 'const label = "OLD";' with exactly: ${editedLine}`,
    `3. Use Bash to run: echo ${tokens.bash}`,
    `4. Use the MCP tool mcp__echo__echo (load it with ToolSearch first if deferred) with text ${tokens.mcp}.`,
    `After every step succeeds, reply with one single line containing all five values separated by spaces: the first line of input.txt, the first line of sub-a.txt, the first line of sub-b.txt, the Bash output, and the exact MCP echo output.`,
  ].join('\n');
  return { index, dir, mcpConfig, tokens, editedLine, prompt };
}

function runWorker(worker) {
  return new Promise((resolve) => {
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    const env = {
      ...process.env,
      ...(maxConcurrent ? { CLAUDE_GEMINI_MAX_CONCURRENT: maxConcurrent } : {}),
      ...(maxSessions ? { CLAUDE_GEMINI_MAX_SESSIONS: maxSessions } : {}),
    };
    const args = [
      launcher,
      '--gemini-model', alias,
      '-p', worker.prompt,
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', 'bypassPermissions',
      '--setting-sources', '',
      '--strict-mcp-config',
      '--mcp-config', worker.mcpConfig,
    ];
    const child = spawn(process.execPath, args, { cwd: worker.dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const pid = child.pid;
    let stdout = '', stderr = '', timedOut = false;
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutSec * 1000);
    child.once('close', (code) => {
      clearTimeout(timer);
      const seconds = Math.round((Date.now() - startedMs) / 1000);
      const events = stdout.split('\n').flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
      const result = events.find((event) => event.type === 'result');
      const text = typeof result?.result === 'string' ? result.result : '';
      const toolUses = events.filter((event) => event.type === 'assistant')
        .flatMap((event) => event.message?.content ?? [])
        .filter((block) => block.type === 'tool_use')
        .map((block) => block.name);
      const targetBody = existsSync(path.join(worker.dir, 'target.js')) ? readFileSync(path.join(worker.dir, 'target.js'), 'utf8') : '';
      const log = logForPid(pid, startedAt);
      const requests = log.filter((entry) => entry.status !== undefined);
      const errors = requests.filter((entry) => entry.error).map((entry) => entry.error);
      resolve({
        index: worker.index, pid, code, timedOut, seconds, text, targetBody,
        isError: result?.is_error === true,
        toolUses: [...new Set(toolUses)],
        requests: requests.length,
        newSessions: requests.filter((entry) => entry.meta?.session === 'new').length,
        reusedTurns: requests.filter((entry) => entry.meta?.session === 'reused').length,
        maxEvent: Math.max(0, ...requests.flatMap((entry) => entry.meta?.events ?? [])),
        errors,
        stderr: stderr.trim().slice(-400),
      });
    });
  });
}

const beforeDirs = snapshotTempDirs();
const startedAll = Date.now();
let workers = [];
let results = [];
try {
  workers = await Promise.all(Array.from({ length: instances }, (_, i) => prepareWorker(i + 1)));
  console.error(`Starting ${instances} parallel claude-gemini instances (alias=${alias}, timeout=${timeoutSec}s)...`);
  results = await Promise.all(workers.map(runWorker));
} finally {
  await rm(base, { recursive: true, force: true });
}
const wallSeconds = Math.round((Date.now() - startedAll) / 1000);
const leakedDirs = [...snapshotTempDirs()].filter((name) => !beforeDirs.has(name));

const allTokensByWorker = new Map(workers.map((w) => [w.index, Object.values(w.tokens)]));
const evaluated = results.map((res) => {
  const worker = workers.find((w) => w.index === res.index);
  const expected = [worker.tokens.read, worker.tokens.subA, worker.tokens.subB, worker.tokens.bash, `ECHO:${worker.tokens.mcp}`];
  const missingTokens = expected.filter((t) => !res.text.includes(t));
  const foreignTokens = [...allTokensByWorker.entries()]
    .filter(([otherIndex]) => otherIndex !== res.index)
    .flatMap(([, list]) => list)
    .filter((t) => res.text.includes(t) || res.targetBody.includes(t));
  const editOk = res.targetBody === `${worker.editedLine}\n`;
  const usedSubagent = res.toolUses.includes('Agent') || res.toolUses.includes('Task');
  const checks = {
    exitClean: res.code === 0 && !res.timedOut && !res.isError,
    noBridgeErrors: res.errors.length === 0,
    allTokensPresent: missingTokens.length === 0,
    noCrossContamination: foreignTokens.length === 0,
    editExact: editOk,
    subagentUsed: usedSubagent,
    multiSession: res.newSessions >= 2,
    deltaReused: res.reusedTurns >= 1,
    pidLogged: res.requests > 0,
  };
  const pass = Object.values(checks).every(Boolean);
  return {
    instance: res.index, pid: res.pid, status: pass ? 'pass' : 'fail', seconds: res.seconds,
    requests: res.requests, newSessions: res.newSessions, reusedTurns: res.reusedTurns,
    maxEvent: res.maxEvent, errors: res.errors, toolUses: res.toolUses,
    checks, missingTokens, foreignTokens,
    ...(pass ? {} : { textPreview: res.text.slice(0, 200), targetBody: res.targetBody.slice(0, 120), stderr: res.stderr }),
  };
});

const distinctPids = new Set(evaluated.map((row) => row.pid).filter(Boolean)).size;
const globalChecks = {
  distinctPids: distinctPids === instances,
  noLeakedTempDirs: leakedDirs.length === 0,
};
const passed = evaluated.filter((row) => row.status === 'pass').length;
const failed = evaluated.length - passed + (globalChecks.distinctPids ? 0 : 1) + (globalChecks.noLeakedTempDirs ? 0 : 1);

for (const row of evaluated) {
  const failedChecks = Object.entries(row.checks).filter(([, ok]) => !ok).map(([name]) => name);
  console.error(
    `worker-${row.instance} (pid ${row.pid}) ${row.status.padEnd(4)} ${row.seconds}s, ${row.requests} req, `
    + `${row.newSessions} new / ${row.reusedTurns} reused, maxEvent ${row.maxEvent}`
    + (failedChecks.length ? ` — failed: [${failedChecks.join(', ')}] errors: [${row.errors.join(', ')}]` : ''),
  );
}
console.error(`global: wall ${wallSeconds}s, distinctPids ${distinctPids}/${instances}, leakedTempDirs ${leakedDirs.length}`);

const report = {
  date: new Date().toISOString(),
  node: process.versions.node,
  alias,
  instances,
  wallSeconds,
  globalChecks,
  leakedDirs,
  summary: { pass: passed, fail: failed, totalRequests: evaluated.reduce((sum, r) => sum + r.requests, 0) },
  workers: evaluated,
};
await writeFile(path.join(tmpdir(), 'claudecode-gemini-stress-report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report.summary));
process.exitCode = failed ? 1 : 0;
