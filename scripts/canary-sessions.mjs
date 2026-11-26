// Live canary: real Claude Code -> bridge -> persistent official agy sessions (Gemini), multi-tool task, synthetic data only.
// Run outside the macOS sandbox: npm run canary:sessions [haiku|sonnet|opus|fable]
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { checkAgyProfile } from '../src/agy-profile.mjs';
import { resolveBinary } from '../src/binaries.mjs';
import { AGY_ALIASES, createRoutedAgyTransport } from '../src/agy-model-routes.mjs';
import { createAgyInvoker, writeBridgeAgent } from '../src/agy-process.mjs';
import { createSessionPool } from '../src/agy-session-pool.mjs';
import { runHarness } from '../src/harness.mjs';

const alias = process.argv[2] ?? 'sonnet';
if (process.argv.length > 3 || !Object.hasOwn(AGY_ALIASES, alias) || process.platform !== 'darwin') process.exit(2);
const home = homedir();
const root = await realpath(await mkdtemp(path.join(tmpdir(), 'claudecode-gemini-sessions-')));
const workspace = path.join(root, 'claude');
const provider = path.join(root, 'provider');
const markers = ['a', 'b', 'c'].map((name) => ({ name, text: `SESSIONS-${name.toUpperCase()}-${randomBytes(4).toString('hex')}` }));
const requests = [];
let pool, report;
try {
  checkAgyProfile(home);
  await mkdir(workspace, { mode: 0o700 });
  await mkdir(provider, { mode: 0o700 });
  await writeBridgeAgent(provider);
  for (const marker of markers) await writeFile(path.join(workspace, `${marker.name}.txt`), marker.text + '\n', { mode: 0o600 });
  const live = createAgyInvoker({ home, workspace, provider, agy: resolveBinary('agy', 'CLAUDE_GEMINI_AGY_BIN') });
  const probe = spawnSync('/usr/bin/sandbox-exec', ['-p', live.guard, process.execPath, '-e',
    'try{require("node:fs").readFileSync(process.argv[1]);process.exit(1)}catch(e){process.exit(["EACCES","EPERM"].includes(e.code)?0:2)}',
    path.join(workspace, 'a.txt')], { cwd: provider, env: live.env, timeout: 5_000, stdio: 'ignore' });
  if (probe.status !== 0) throw Error('PROVIDER_READ_BOUNDARY_UNPROVEN');
  pool = createSessionPool({ spawnSession: live.spawnSession });
  const routed = createRoutedAgyTransport({ invoke: live.invoke, pool });
  const infer = async (request, signal) => {
    const started = Date.now();
    const out = await routed(request, signal);
    requests.push({ session: out.meta.session, ms: Date.now() - started, events: out.meta.events, usage: out.usage, cacheRead: out.meta.cacheRead,
      blocks: out.content.map((block) => block.type === 'tool_use' ? block.name : 'text') });
    return out;
  };
  const prompt = `Use the Read tool on a.txt and on b.txt in the current directory. Then use the Write tool to create summary.txt containing exactly two lines: the line from a.txt, then the line from b.txt. Then use the Bash tool to run: wc -l summary.txt . Finally reply with only the line count number.`;
  const run = await runHarness({ infer, agyAlias: alias, isolated: true, capture: true, cwd: workspace, maxConcurrent: 4, signal: AbortSignal.timeout(600_000),
    args: ['-p', prompt, '--output-format', 'json', '--max-turns', '12', '--tools', 'Read,Write,Bash', '--allowedTools', 'Read,Write,Bash',
      '--permission-mode', 'dontAsk', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--disable-slash-commands', '--no-session-persistence', '--setting-sources', ''] });
  const summary = await readFile(path.join(workspace, 'summary.txt'), 'utf8').catch(() => '');
  const answer = (() => { try { return JSON.parse(run.stdout).result; } catch { return null; } })();
  const reused = requests.filter((request) => request.session === 'reused');
  const checks = {
    exit: run.code === 0,
    summary: summary === `${markers[0].text}\n${markers[1].text}\n`,
    answer: typeof answer === 'string' && /\b2\b/.test(answer),
    enoughTurns: requests.length >= 4,
    oneNewSession: requests.filter((request) => request.session === 'new').length === 1 && requests[0]?.session === 'new',
    deltaSized: reused.every((request) => request.events.every((chars) => chars < 20_000)),
    noTruncation: requests.every((request) => request.events.every((chars) => chars < 153_600)),
    reusedFast: reused.length > 0 && reused.map((request) => request.ms).sort((a, b) => a - b)[Math.floor(reused.length / 2)] <= 8_000,
  };
  report = { status: Object.values(checks).every(Boolean) ? 'pass' : 'failed', alias, model: AGY_ALIASES[alias], checks, requests, stats: run.stats,
    ...(checks.summary ? {} : { summaryActual: summary.slice(0, 300), expected: `${markers[0].text}\n${markers[1].text}\n` }),
    ...(run.code === 0 ? {} : { stderr: run.stderr.slice(-800), stdout: run.stdout.slice(-800) }) };
} catch (error) {
  report = { status: 'failed', alias, reason: /^[A-Z_]+$/.test(error?.message) ? error.message : 'CANARY_FAILED', requests };
} finally {
  pool?.close();
  await rm(root, { recursive: true, force: true });
}
console.log(JSON.stringify(report, null, 1));
if (report.status !== 'pass') process.exitCode = 1;
