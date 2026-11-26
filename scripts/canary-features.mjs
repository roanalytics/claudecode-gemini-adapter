// Live feature canary: real Claude Code -> installed-style launcher -> persistent Gemini sessions, one scenario per Claude Code
// capability, synthetic data only. Run outside the macOS sandbox:
//   npm run canary:features [-- --only 3,8 --alias sonnet --skip-real-profile --offline]
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_LOG } from '../src/bridge-log.mjs';
import { root } from '../src/paths.mjs';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name) => { const at = argv.indexOf(`--${name}`); return at >= 0 ? argv[at + 1] : undefined; };
const only = value('only')?.split(',').map(Number);
const alias = value('alias') ?? 'sonnet';
const offline = flag('offline');
const launcher = path.join(root, 'bin/claude-gemini.mjs');
const base = await realpath(await mkdtemp(path.join(tmpdir(), 'claudecode-gemini-features-')));
const token = () => randomBytes(4).toString('hex').toUpperCase();

function logSince(startedAt) {
  if (!existsSync(DEFAULT_LOG)) return [];
  return readFileSync(DEFAULT_LOG, 'utf8').trim().split('\n').flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } })
    .filter((entry) => entry.ts >= startedAt);
}

// Runs the launcher with Claude Code headless and returns parsed stream-json plus bridge log facts.
async function claude(dir, prompt, { args = [], model = alias, timeout = 300_000, isolated = true, env = {} } = {}) {
  const startedAt = new Date().toISOString();
  const full = [`--gemini-model`, model, '-p', prompt, '--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions',
    ...(isolated ? ['--setting-sources', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'] : []), ...args];
  const child = spawn(process.execPath, [launcher, ...full], { cwd: dir, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
  const code = await new Promise((resolve) => child.once('close', resolve));
  clearTimeout(timer);
  const events = stdout.split('\n').flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
  const result = events.find((event) => event.type === 'result');
  const init = events.find((event) => event.type === 'system' && event.subtype === 'init');
  const toolUses = events.filter((event) => event.type === 'assistant').flatMap((event) => event.message?.content ?? []).filter((block) => block.type === 'tool_use');
  const log = logSince(startedAt);
  const requests = log.filter((entry) => entry.status !== undefined);
  return { code, stderr, events, result, text: typeof result?.result === 'string' ? result.result : '', tools: init?.tools ?? [], toolUses,
    sessions: { new: requests.filter((entry) => entry.meta?.session === 'new').length, reused: requests.filter((entry) => entry.meta?.session === 'reused').length },
    requests: requests.length, errors: requests.filter((entry) => entry.error).map((entry) => entry.error),
    maxEvent: Math.max(0, ...requests.flatMap((entry) => entry.meta?.events ?? [])), models: [...new Set(requests.map((entry) => entry.model).filter(Boolean))], sessionId: result?.session_id };
}
const has = (run, ...names) => names.some((name) => run.tools.includes(name));
const usedTool = (run, ...names) => run.toolUses.some((use) => names.includes(use.name));
const clean = (run) => run.code === 0 && !run.result?.is_error && run.errors.length === 0;
const NA = (reason) => ({ status: 'n/a', detail: reason });
// Own MCP config only: ignore the user's settings and MCP servers, load just the fixture server.
const MCP_ISOLATION = ['--setting-sources', '', '--strict-mcp-config', '--mcp-config'];
// A failed scenario whose tool does not exist in this Claude Code build is "n/a", not a failure.
const settle = (run, tools, ok, detail) => (!ok && tools.some((name) => !run.tools.includes(name))) ? [NA(`${tools.filter((name) => !run.tools.includes(name)).join(', ')} not available in this Claude Code`), run] : [verdict(ok, run, detail), run];
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' });

async function scratch(name, files = {}) {
  const dir = path.join(base, name);
  await mkdir(dir, { recursive: true });
  for (const [file, content] of Object.entries(files)) await writeFile(path.join(dir, file), content);
  return dir;
}
const verdict = (ok, run, detail = '') => ({ status: ok ? 'pass' : 'fail', detail: ok ? detail : `${detail} | exit ${run.code}, errors [${run.errors}], text: ${run.text.slice(0, 160)}` });

const scenarios = [
  ['Read a text file', async () => { const m = token(); const dir = await scratch('read', { 'a.txt': `${m}\nsecond\n` });
    const run = await claude(dir, 'Use the Read tool on a.txt and reply with only its first line.');
    return [verdict(clean(run) && run.text.includes(m), run), run]; }],
  ['Write a file', async () => { const m = token(); const dir = await scratch('write');
    const run = await claude(dir, `Use the Write tool to create out.txt containing exactly the single line ${m} . Then reply DONE.`);
    const ok = existsSync(path.join(dir, 'out.txt')) && readFileSync(path.join(dir, 'out.txt'), 'utf8').trim() === m;
    return [verdict(clean(run) && ok, run), run]; }],
  ['Edit a file', async () => { const dir = await scratch('edit', { 'e.txt': 'color: red\nsize: 10\n' });
    const run = await claude(dir, 'Use the Edit tool on e.txt to replace "red" with "blue". Then reply DONE.');
    const ok = readFileSync(path.join(dir, 'e.txt'), 'utf8') === 'color: blue\nsize: 10\n';
    return [verdict(clean(run) && ok, run), run]; }],
  ['Search (Glob/Grep/Bash)', async () => { const m = token(); const dir = await scratch('search', { 'one.txt': 'nothing\n', 'two.txt': `needle ${m}\n`, 'three.txt': 'hay\n' });
    const run = await claude(dir, 'Find which file in this directory contains the word "needle" (use Grep, Glob or Bash) and reply with only that file name.');
    return [verdict(clean(run) && run.text.includes('two.txt'), run), run]; }],
  ['Bash foreground', async () => { const m = token(); const dir = await scratch('bash');
    const run = await claude(dir, `Use the Bash tool to run: echo ${m} . Reply with only what it printed.`);
    return [verdict(clean(run) && usedTool(run, 'Bash') && run.text.includes(m), run), run]; }],
  ['Bash non-zero exit', async () => { const dir = await scratch('bashfail');
    const run = await claude(dir, 'Use the Bash tool to run: sh -c "exit 42" . Reply with only the exit code number.');
    return [verdict(clean(run) && /\b42\b/.test(run.text), run), run]; }],
  ['Bash in background', async () => {
    const dir = await scratch('bg'); const m = token();
    const run = await claude(dir, `Use the Bash tool with run_in_background true to run: sh -c "sleep 2; echo ${m}" . Then retrieve its output (BashOutput, TaskOutput or Monitor, or read the output file) and reply with only the printed token.`);
    return [verdict(clean(run) && run.text.includes(m), run), run]; }],
  ['Read a PNG (image tool result), then a follow-up turn', async () => {
    const dir = await scratch('png'); const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    await writeFile(path.join(dir, 'dot.png'), png); const m = token();
    const first = await claude(dir, `Use the Read tool on dot.png. Then reply with the words IMAGE_STEP_DONE and the token ${m}.`);
    if (!clean(first) || !first.text.includes(m)) return [verdict(false, first, 'first turn'), first];
    const second = await claude(dir, 'What token did I give you in the previous turn? Reply with only the token.', { args: ['--resume', first.sessionId] });
    return [verdict(clean(second) && second.text.includes(m), second, 'follow-up after the image'), second]; }],
  ['Read a large file (400 KB), event size guard', async () => { const m = token();
    const dir = await scratch('large', { 'big.txt': Array.from({ length: 8000 }, (_, i) => `row ${i} ${'x'.repeat(40)}`).join('\n') + `\nFINAL-${m}\n` });
    const run = await claude(dir, 'Use the Read tool with offset 7995 on big.txt (it is large) and reply with only the last line.', { timeout: 400_000 });
    return [verdict(clean(run) && run.maxEvent < 153_600 && run.text.includes(m), run, `max event ${run.maxEvent}`), run]; }],
  ['Deferred tool via ToolSearch (Notebook/Cron)', async () => {
    const dir = await scratch('nb', { 't.ipynb': JSON.stringify({ cells: [{ cell_type: 'code', execution_count: null, id: 'cell-1', metadata: {}, outputs: [], source: ["print('hello')"] }], metadata: {}, nbformat: 4, nbformat_minor: 5 }) });
    const probe = await claude(dir, 'Reply READY.', { timeout: 120_000 });
    if (!has(probe, 'NotebookEdit')) return [NA('NotebookEdit not available in this Claude Code'), probe];
    const run = await claude(dir, 'Use the NotebookEdit tool to replace the source of cell-1 in t.ipynb with: print("changed") . Then reply DONE.');
    const ok = readFileSync(path.join(dir, 't.ipynb'), 'utf8').includes('changed');
    return [verdict(clean(run) && ok, run), run]; }],
  ['Subagent (general-purpose) reads a file', async () => { const m = token(); const dir = await scratch('agent', { 'n.txt': `${m}\n` });
    const run = await claude(dir, 'Use the Agent tool with a general-purpose subagent to read n.txt, then reply with only the first line it returned.');
    return [verdict(clean(run) && usedTool(run, 'Agent', 'Task') && run.text.includes(m) && run.sessions.new >= 2, run, `new sessions ${run.sessions.new}`), run]; }],
  ['Two parallel subagents', async () => { const a = token(), b = token(); const dir = await scratch('agents', { 'a.txt': `${a}\n`, 'b.txt': `${b}\n` });
    const run = await claude(dir, 'In a single message launch two Agent subagents in parallel: one reads a.txt, the other reads b.txt. Reply with both first lines separated by a comma.', { timeout: 400_000 });
    return [verdict(clean(run) && run.text.includes(a) && run.text.includes(b), run), run]; }],
  ['WebFetch', async () => {
    if (offline) return [NA('--offline'), null];
    const dir = await scratch('web'); const run = await claude(dir, 'Use the WebFetch tool on https://example.com and reply with only the page title.');
    if (!has(run, 'WebFetch')) return [NA('WebFetch not available'), run];
    return [verdict(clean(run) && /example domain/i.test(run.text), run), run]; }],
  ['MCP server with 150 tools through Tool Search', async () => { const m = token(); const dir = await scratch('mcp');
    const config = path.join(dir, 'mcp.json');
    await writeFile(config, JSON.stringify({ mcpServers: { echo: { command: process.execPath, args: [path.join(root, 'test/fixtures/mcp-echo.mjs')] } } }));
    const run = await claude(dir, `Use the echo MCP tool (mcp__echo__echo; load it with ToolSearch first if needed) with text ${m} and reply with only its result.`,
      { args: [...MCP_ISOLATION, config], isolated: false });
    return [verdict(clean(run) && run.text.includes(`ECHO:${m}`), run), run]; }],
  ['Session resume remembers a token', async () => { const m = token(); const dir = await scratch('resume');
    const first = await claude(dir, `Remember this token: ${m}. Reply only OK.`);
    const second = await claude(dir, 'What was the token? Reply with only the token.', { args: ['--resume', first.sessionId] });
    return [verdict(clean(first) && clean(second) && second.text.includes(m), second), second]; }],
  ['Plan mode does not write files', async () => { const dir = await scratch('plan');
    const run = await claude(dir, 'Create a file named created.txt containing hello.', { args: ['--permission-mode', 'plan'] });
    return [verdict(run.code === 0 && run.errors.length === 0 && !existsSync(path.join(dir, 'created.txt')), run), run]; }],
  ['Long answer (about 1500 words)', async () => { const dir = await scratch('long');
    const run = await claude(dir, 'Write an essay of about 1500 words on the history of the printing press. No tools.', { timeout: 500_000 });
    const words = run.text.split(/\s+/).filter(Boolean).length;
    return [verdict(clean(run) && words > 900, run, `${words} words`), run]; }],
  ['Every alias works as the primary model', async () => {
    const dir = await scratch('aliases'); const checked = []; let last = null;
    for (const [name, model] of [['haiku', 'gemini-3.8-flash-low'], ['sonnet', 'gemini-4-neon-low'], ['opus', 'gemini-4-neon-high'], ['fable', 'gemini-4-neon-xhigh']]) {
      const m = token(); last = await claude(dir, `Reply with exactly ${m} and nothing else.`, { model: name, timeout: name === 'fable' ? 600_000 : 300_000 });
      checked.push(`${name}:${clean(last) && last.text.includes(m) && last.models.includes(model) ? 'ok' : 'FAIL'}`);
    }
    return [verdict(checked.every((entry) => entry.endsWith('ok')), last, checked.join(' ')), last]; }],
  ['Real Claude profile (hooks, memory, MCP) with Read and Bash', async () => {
    if (flag('skip-real-profile')) return [NA('--skip-real-profile'), null];
    const m = token(); const dir = await scratch('real', { 'notes.txt': `${m}\nsecond\n` });
    const run = await claude(dir, 'Use Read on notes.txt, then use Bash to run: echo done . Reply with the first line of the file only.', { isolated: false, timeout: 400_000 });
    return [verdict(clean(run) && run.text.includes(m), run, `max event ${run.maxEvent}, new sessions ${run.sessions.new}`), run]; }],
  ['WebSearch server tool is dropped without breaking the session', async () => {
    if (offline) return [NA('--offline'), null];
    const dir = await scratch('websearch');
    const run = await claude(dir, 'Try the WebSearch tool to find the capital of France. If you cannot search, say exactly SEARCH_UNAVAILABLE. Reply in one short line.');
    if (!has(run, 'WebSearch')) return [NA('WebSearch not available in this Claude Code'), run];
    return [verdict(clean(run) && run.text.trim().length > 0, run, `answer: ${run.text.slice(0, 60)}`), run]; }],
  ['Edit with replace_all', async () => { const m = token();
    const dir = await scratch('edit-all', { 'multi.txt': 'a: OLD_VAL\nb: keep\nc: OLD_VAL\nd: OLD_VAL\n' });
    const run = await claude(dir, `Read multi.txt, then use Edit with replace_all true to replace every OLD_VAL with ${m} . Reply DONE.`);
    const body = readFileSync(path.join(dir, 'multi.txt'), 'utf8');
    const count = body.split(m).length - 1;
    return [verdict(clean(run) && count === 3 && !body.includes('OLD_VAL') && body.includes('b: keep'), run, `replaced ${count}`), run]; }],
  ['NotebookEdit insert and delete', async () => { const m = token();
    const dir = await scratch('nb-ops', { 'nb.ipynb': JSON.stringify({ cells: [{ cell_type: 'code', execution_count: null, id: 'c1', metadata: {}, outputs: [], source: ['x = 1'] }], metadata: {}, nbformat: 4, nbformat_minor: 5 }) });
    const run = await claude(dir, `Load NotebookEdit if deferred, Read nb.ipynb, insert a markdown cell after c1 with content "# ${m}", then delete cell c1. Reply DONE.`);
    const raw = readFileSync(path.join(dir, 'nb.ipynb'), 'utf8');
    return settle(run, ['NotebookEdit'], clean(run) && raw.includes(m) && !raw.includes('x = 1')); }],
  ['TaskStop cancels a background Bash task', async () => { const dir = await scratch('taskstop');
    const run = await claude(dir, 'Use Bash with run_in_background true to run: sleep 30 . Immediately stop that background task using TaskStop (load it with ToolSearch first if needed), then reply STOPPED_OK.');
    return settle(run, ['TaskStop'], clean(run) && usedTool(run, 'TaskStop') && run.text.includes('STOPPED_OK')); }],
  ['Monitor streams events and exits cleanly', async () => { const m1 = token(), m2 = token(); const dir = await scratch('monitor');
    const run = await claude(dir, `Load Monitor if deferred and start a Monitor (timeout_ms 15000) with command: sh -c "echo ${m1}; sleep 0.3; echo ${m2}" . In headless mode nothing is delivered while you answer in text, so do not end your turn until both events have arrived: after starting the Monitor, call the Bash tool with sleep 4 and repeat while no event has arrived. Then reply with both tokens separated by a comma.`);
    return settle(run, ['Monitor'], clean(run) && usedTool(run, 'Monitor') && run.text.includes(m1) && run.text.includes(m2)); }],
  ['CronCreate, CronList and CronDelete session lifecycle', async () => { const dir = await scratch('cron');
    const run = await claude(dir, 'Load CronCreate, CronList and CronDelete if deferred. Create a one-shot session-only job (cron "57 23 31 12 *", recurring false, durable false, prompt "noop"), verify it appears in CronList, delete it with CronDelete, then confirm CronList is empty. Reply CRON_OK.');
    return settle(run, ['CronCreate', 'CronList', 'CronDelete'], clean(run) && usedTool(run, 'CronCreate') && usedTool(run, 'CronList') && usedTool(run, 'CronDelete') && run.text.includes('CRON_OK')); }],
  ['Explore subagent resumed via SendMessage', async () => { const m1 = token(), m2 = token(); const dir = await scratch('explore-resume', { 'secret.txt': `${m1}\n` });
    const run = await claude(dir, `Launch an Explore subagent using Agent to read secret.txt and return its first line. Run it in the foreground (not in the background) and do not end your turn until it has returned its result. Then resume that exact subagent using SendMessage (load SendMessage if deferred) asking it to reply with ${m2} . The reply is delivered asynchronously and never while you answer in text, so after SendMessage keep calling the Bash tool with sleep 4 until the subagent's reply has arrived; only then answer with both tokens separated by a comma.`, { timeout: 500_000 });
    return settle(run, ['SendMessage'], clean(run) && usedTool(run, 'Agent', 'Task') && usedTool(run, 'SendMessage') && run.text.includes(m1) && run.text.includes(m2)); }],
  ['EnterWorktree and ExitWorktree in a temporary git repo', async () => { const dir = await scratch('worktree', { 'README.md': 'init\n' });
    git(dir, 'init', '-q'); git(dir, 'config', 'user.email', 'canary@example.invalid'); git(dir, 'config', 'user.name', 'canary'); git(dir, 'add', 'README.md'); git(dir, 'commit', '-q', '-m', 'init');
    const run = await claude(dir, 'Explicitly create a worktree named canary-wt using EnterWorktree (load EnterWorktree and ExitWorktree if deferred), run pwd with Bash to confirm you are inside it, then immediately exit and remove it with ExitWorktree (action "remove"). Reply WORKTREE_OK.');
    return settle(run, ['EnterWorktree', 'ExitWorktree'], clean(run) && usedTool(run, 'EnterWorktree') && usedTool(run, 'ExitWorktree') && !existsSync(path.join(dir, '.claude/worktrees/canary-wt')) && run.text.includes('WORKTREE_OK')); }],
  ['MCP resources via ListMcpResourcesTool and ReadMcpResourceTool', async () => { const dir = await scratch('mcp-resources'); const config = path.join(dir, 'mcp.json');
    await writeFile(config, JSON.stringify({ mcpServers: { echo: { command: process.execPath, args: [path.join(root, 'test/fixtures/mcp-echo.mjs')] } } }));
    const run = await claude(dir, 'Load ListMcpResourcesTool and ReadMcpResourceTool if deferred. List resources for server "echo", read the resource "echo://note" from server "echo", and reply with only its text content.', { args: [...MCP_ISOLATION, config], isolated: false });
    return settle(run, ['ListMcpResourcesTool', 'ReadMcpResourceTool'], clean(run) && usedTool(run, 'ListMcpResourcesTool') && usedTool(run, 'ReadMcpResourceTool') && run.text.includes('RESOURCE_ECHO_OK')); }],
  ['Edit with quotes, backslashes and a template literal (JSON escaping regression)', async () => {
    const line = 'const s = `say "hi" ${name}\\n`;'; // contains double quotes, ${...} and a literal backslash-n
    const dir = await scratch('quoting', { 'q.js': 'PLACEHOLDER\n' });
    const run = await claude(dir, `Use the Edit tool on q.js to replace PLACEHOLDER with exactly this one line, character for character (it contains double quotes and a backslash followed by n, not a newline): ${line}\nThen reply DONE.`);
    const body = readFileSync(path.join(dir, 'q.js'), 'utf8');
    return [verdict(clean(run) && body === `${line}\n`, run, body === `${line}\n` ? '' : `file: ${JSON.stringify(body).slice(0, 120)}`), run]; }],
];

const rows = [];
try {
  for (const [index, [name, body]] of scenarios.entries()) {
    const number = index + 1;
    if (only && !only.includes(number)) continue;
    const started = Date.now();
    let outcome, run = null;
    try { [outcome, run] = await body(); }
    catch (error) { outcome = { status: 'fail', detail: `crashed: ${error?.message}` }; }
    const row = { n: number, name, ...outcome, seconds: Math.round((Date.now() - started) / 1000), requests: run?.requests ?? 0, newSessions: run?.sessions.new ?? 0, reusedTurns: run?.sessions.reused ?? 0, errors: run?.errors ?? [] };
    rows.push(row);
    console.error(`${String(number).padStart(2)} ${row.status.padEnd(4)} ${name} (${row.seconds}s, ${row.requests} req)${row.status === 'fail' ? ` — ${row.detail}` : row.detail ? ` — ${row.detail}` : ''}`);
  }
} finally { await rm(base, { recursive: true, force: true }); }
const report = { alias, node: process.versions.node, date: new Date().toISOString(),
  summary: { pass: rows.filter((r) => r.status === 'pass').length, fail: rows.filter((r) => r.status === 'fail').length, na: rows.filter((r) => r.status === 'n/a').length }, rows };
await writeFile(path.join(tmpdir(), 'claudecode-gemini-features-report.json'), JSON.stringify(report, null, 1));
console.log(JSON.stringify(report.summary));
process.exitCode = report.summary.fail ? 1 : 0;
