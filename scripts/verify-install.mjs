// Clean-install verification: copies the working tree to a path with spaces and accents, then checks that the copy
// parses, passes its tests, reports problems readably under different HOME/PATH layouts, and (when Claude Code and
// the Antigravity CLI are installed) answers a real prompt through an installed `claude-gemini` command.
// Run outside the macOS sandbox: npm run verify:install [-- --skip-tests] [-- --offline]
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBinary } from '../src/binaries.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const skipTests = process.argv.includes('--skip-tests');
const offline = process.argv.includes('--offline');
const results = [];
const record = (name, status, detail = '') => { results.push({ name, status, detail }); console.error(`${{ pass: '✓', fail: '✗', skipped: '-' }[status]} ${name}${detail ? ` — ${detail}` : ''}`); };
const check = (name, ok, detail) => record(name, ok ? 'pass' : 'fail', detail);
const tryResolve = (name, env) => { try { return resolveBinary(name, env); } catch { return null; } };
const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'claudecode-gemini install ñ-')));
const copy = path.join(base, 'adapter copy');
const stackTrace = (text) => /\n\s+at .*\(|node:internal|ERR_MODULE_NOT_FOUND/.test(text);

function doctor(env) {
  const run = spawnSync(process.execPath, [path.join(copy, 'bin/claude-gemini.mjs'), '--check', '--json'],
    { env, encoding: 'utf8', timeout: 120_000, cwd: base });
  let report = null;
  try { report = JSON.parse(run.stdout); } catch {}
  return { run, report, item: (title) => report?.items.find((entry) => entry.title.startsWith(title)) };
}

try {
  // 1. copy tracked and new, non-ignored files
  const listed = execFileSync('git', ['-C', repo, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' })
    .split('\0').filter((file) => file && existsSync(path.join(repo, file)));
  for (const file of listed) {
    mkdirSync(path.dirname(path.join(copy, file)), { recursive: true });
    cpSync(path.join(repo, file), path.join(copy, file));
  }
  check('copied working tree to a path with spaces and accents', listed.length > 20 && existsSync(path.join(copy, 'bin/claude-gemini.mjs')), `${listed.length} files`);
  check('no local-only directories were copied', !['.auth', '.atl', 'node_modules'].some((entry) => existsSync(path.join(copy, entry))));

  // 2. syntax and tests
  const sources = listed.filter((file) => file.endsWith('.mjs'));
  const broken = sources.filter((file) => spawnSync(process.execPath, ['--check', path.join(copy, file)]).status !== 0);
  check('every .mjs parses', broken.length === 0, broken.join(', '));
  const testScript = JSON.parse(readFileSync(path.join(copy, 'package.json'), 'utf8')).scripts.test;
  if (skipTests) record('unit tests in the copy', 'skipped', '--skip-tests');
  else {
    const tests = spawnSync('npm', ['test', '--silent'], { cwd: copy, encoding: 'utf8', timeout: 600_000 });
    check('unit tests pass inside the copy', tests.status === 0, tests.status === 0 ? '' : (tests.stdout + tests.stderr).split('\n').filter((line) => /fail|✖/.test(line)).slice(0, 3).join(' | '));
  }

  // 3. doctor under different layouts
  const home = homedir();
  const claudeBin = tryResolve('claude', 'CLAUDE_GEMINI_CLAUDE_BIN');
  const agyBin = tryResolve('agy', 'CLAUDE_GEMINI_AGY_BIN');
  const minimal = { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' };
  const a = doctor({ ...minimal, HOME: home });
  check('doctor (real HOME, minimal PATH) returns JSON without a stack trace', a.report !== null && !stackTrace(a.run.stderr));
  record('  claude/agy found with PATH=/usr/bin:/bin', 'skipped', `claude ${a.item('Claude Code')?.status}, agy ${a.item('Antigravity CLI')?.status}`);
  if (claudeBin && agyBin) {
    const b = doctor({ ...minimal, HOME: home, CLAUDE_GEMINI_CLAUDE_BIN: claudeBin, CLAUDE_GEMINI_AGY_BIN: agyBin });
    check('doctor with explicit CLAUDE_GEMINI_*_BIN overrides', b.item('Claude Code')?.status === 'ok' && b.item('Antigravity CLI')?.status === 'ok');
    const e = doctor({ ...minimal, HOME: home, CLAUDE_GEMINI_CLAUDE_BIN: claudeBin, CLAUDE_GEMINI_AGY_BIN: path.join(base, 'missing agy') });
    check('doctor with a bad override fails readably', e.run.status === 1 && e.item('Antigravity CLI')?.status === 'fail' && /was not found/.test(e.item('Antigravity CLI')?.detail ?? ''));
  } else record('doctor with explicit overrides', 'skipped', 'Claude Code or Antigravity CLI not installed here');
  const emptyHome = path.join(base, 'empty home');
  mkdirSync(emptyHome);
  const c = doctor({ ...minimal, HOME: emptyHome });
  check('doctor on a machine with nothing installed explains each missing piece', c.run.status === 1 && c.item('Claude Code')?.status === 'fail'
    && c.item('Antigravity CLI')?.status === 'fail' && /not found/.test(c.item('Claude Code')?.detail) && !stackTrace(c.run.stderr));
  // synthetic install: fake binaries in a directory with spaces/accents, always-allow entries, MCP servers present
  const synthetic = path.join(base, 'synthetic home');
  const fakeBin = path.join(base, 'fake bin ñ');
  mkdirSync(path.join(synthetic, '.gemini/antigravity-cli'), { recursive: true });
  mkdirSync(path.join(synthetic, '.gemini/config'), { recursive: true });
  mkdirSync(fakeBin);
  writeFileSync(path.join(synthetic, '.gemini/antigravity-cli/settings.json'), JSON.stringify({ permissions: { allow: ['command(ln)'] } }));
  writeFileSync(path.join(synthetic, '.gemini/config/mcp_config.json'), '{"mcpServers":{"demo":{}}}');
  writeFileSync(path.join(fakeBin, 'agy'), '#!/bin/sh\nif [ "$1" = "models" ]; then printf "Fetching available models...\\ngemini-4-neon-medium\\tNeon\\n"; fi\n');
  writeFileSync(path.join(fakeBin, 'claude'), '#!/bin/sh\necho "9.9.9 (fake)"\n');
  chmodSync(path.join(fakeBin, 'agy'), 0o755);
  chmodSync(path.join(fakeBin, 'claude'), 0o755);
  const d = doctor({ ...minimal, PATH: `${fakeBin}:/usr/bin:/bin`, HOME: synthetic });
  const titles = d.report?.items.map((entry) => `${entry.status}:${entry.title}`) ?? [];
  check('doctor on a synthetic install: warnings for always-allow, MCP and missing models, exit 0',
    d.run.status === 0 && titles.some((t) => t.startsWith('warn:Antigravity profile (AGY_PERMISSIONS_ALLOW)'))
    && titles.some((t) => t.startsWith('warn:Antigravity profile (AGY_MCP_PRESENT)')) && titles.some((t) => t.startsWith('warn:Routed models available')),
    titles.join(' | '));

  // 4. real prompt through an installed command, in a directory with spaces and accents
  if (offline) record('real prompt through an installed claude-gemini', 'skipped', '--offline');
  else if (!claudeBin || !agyBin) record('real prompt through an installed claude-gemini', 'skipped', 'Claude Code or Antigravity CLI not installed here');
  else {
    const installDir = path.join(base, 'install bin');
    const work = path.join(base, 'trabajo ñ');
    mkdirSync(installDir);
    mkdirSync(work);
    symlinkSync(path.join(copy, 'bin/claude-gemini.mjs'), path.join(installDir, 'claude-gemini'));
    const marker = `INSTALL-OK-${Math.random().toString(16).slice(2, 10)}`;
    writeFileSync(path.join(work, 'notes.txt'), `${marker}\nsecond line\n`);
    const run = spawnSync(path.join(installDir, 'claude-gemini'), ['-p', 'Read notes.txt and reply with only its first line', '--output-format', 'json',
      '--permission-mode', 'bypassPermissions'], { cwd: work, encoding: 'utf8', timeout: 400_000, env: { ...process.env, PATH: `${installDir}:${process.env.PATH}` } });
    let answer = null;
    try { answer = JSON.parse(run.stdout.slice(run.stdout.indexOf('{"'))).result; } catch {}
    check('installed claude-gemini answers a real prompt from a path with spaces and accents', typeof answer === 'string' && answer.includes(marker),
      answer === null ? `exit ${run.status}: ${(run.stderr || run.stdout).slice(-300)}` : '');
  }

  // 5. oldest supported Node, when available
  const candidates = [];
  const nvm = path.join(home, '.nvm/versions/node');
  if (existsSync(nvm)) for (const version of readdirSync(nvm)) if (version.startsWith('v22.')) candidates.push(path.join(nvm, version, 'bin/node'));
  candidates.push('/opt/homebrew/opt/node@22/bin/node');
  const runnable = candidates.find((candidate) => existsSync(candidate) && spawnSync(candidate, ['--version'], { encoding: 'utf8' }).status === 0);
  const files = testScript.split(/\s+/).filter((word) => word.startsWith('test/'));
  const testArgs = ['--test', '--test-concurrency=1', ...files];
  if (runnable) {
    const run = spawnSync(runnable, testArgs, { cwd: copy, encoding: 'utf8', timeout: 600_000 });
    check(`unit tests on Node 22 (${runnable})`, run.status === 0);
  } else if (offline) record('unit tests on Node 22', 'skipped', 'no runnable local Node 22 and --offline');
  else {
    // `npx node@22` downloads a Node 22 binary into the npm cache; nothing is installed globally.
    const run = spawnSync('npx', ['-y', 'node@22', ...testArgs], { cwd: copy, encoding: 'utf8', timeout: 900_000 });
    if (run.status === 0) check('unit tests on Node 22 (via npx node@22)', true);
    else if (/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|network/i.test(run.stderr)) record('unit tests on Node 22', 'skipped', 'could not download Node 22');
    else check('unit tests on Node 22 (via npx node@22)', false, (run.stdout + run.stderr).split('\n').filter((line) => /✖|fail|Error/.test(line)).slice(0, 3).join(' | '));
  }
} catch (error) {
  record('verification crashed', 'fail', String(error?.message ?? error));
} finally {
  rmSync(base, { recursive: true, force: true });
}
const failed = results.filter((entry) => entry.status === 'fail');
console.log(JSON.stringify({ status: failed.length ? 'fail' : 'pass', passed: results.filter((entry) => entry.status === 'pass').length,
  failed: failed.length, skipped: results.filter((entry) => entry.status === 'skipped').length, results }, null, 1));
process.exitCode = failed.length ? 1 : 0;
