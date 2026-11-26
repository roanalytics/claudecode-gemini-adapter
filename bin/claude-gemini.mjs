#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { access, mkdtemp, realpath, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { AGY_ALIASES, createRoutedAgyTransport, resolveAliases } from '../src/agy-model-routes.mjs';
import { resolveConcurrency } from '../src/agy-limits.mjs';
import { inspectAgyProfile } from '../src/agy-profile.mjs';
import { createAgyInvoker, parseDenyRead, writeBridgeAgent } from '../src/agy-process.mjs';
import { createSessionPool } from '../src/agy-session-pool.mjs';
import { estimateTokens, loadLeanRules } from '../src/agy-render.mjs';
import { resolveBinary } from '../src/binaries.mjs';
import { createLogger, DEFAULT_LOG } from '../src/bridge-log.mjs';
import { runHarness } from '../src/harness.mjs';

const MESSAGES = {
  AGY_NOT_FOUND: 'Antigravity CLI (agy) was not found. Install it (https://antigravity.google/docs/getting-started/), sign in by running `agy`, or set CLAUDE_GEMINI_AGY_BIN to its path.',
  CLAUDE_NOT_FOUND: 'Claude Code was not found. Install it (npm install -g @anthropic-ai/claude-code, see https://docs.anthropic.com/en/docs/claude-code/overview) or set CLAUDE_GEMINI_CLAUDE_BIN to its path.',
  UNSUPPORTED_PLATFORM: 'This tool needs macOS with /usr/bin/sandbox-exec; other platforms are not supported.',
  AGY_PROFILE_UNSAFE: 'Your Antigravity settings could spend extra credits or change the provider (details above). Fix ~/.gemini/antigravity-cli/settings.json: useG1Credits must be false and modelProvider empty.',
  INVALID_MODEL_OVERRIDE: 'A CLAUDE_GEMINI_MODEL_* variable is not a valid Gemini model id (expected gemini-<name>). Run `agy models` to list ids.',
  INVALID_LEAN_FILTERS: 'CLAUDE_GEMINI_LEAN_FILTERS must point to a JSON array of rules (see docs/configuration.md).',
  INVALID_GEMINI_TIMEOUT: '--gemini-timeout / CLAUDE_GEMINI_TIMEOUT_S must be an integer between 10 and 3600 (seconds).',
  INVALID_MAX_CONCURRENT: 'CLAUDE_GEMINI_MAX_CONCURRENT must be an integer between 1 and 16.',
  INVALID_MAX_SESSIONS: 'CLAUDE_GEMINI_MAX_SESSIONS must be an integer at least CLAUDE_GEMINI_MAX_CONCURRENT and at most 32.',
  INVALID_AGY_ALIAS: '--gemini-model must be one of fable, opus, sonnet or haiku.',
};

const ENV_HELP = [
  ['CLAUDE_GEMINI_TIMEOUT_S', 'per-turn timeout in seconds (default 600)'],
  ['CLAUDE_GEMINI_MAX_CONCURRENT', 'max simultaneous model requests per instance, 1-16 (default 4)'],
  ['CLAUDE_GEMINI_MAX_SESSIONS', 'max persistent agy sessions per instance, >= concurrent..32 (default 6)'],
  ['CLAUDE_GEMINI_SESSIONS=0', 'disable persistent sessions (stateless fallback)'],
  ['CLAUDE_GEMINI_LOG=0', 'disable the request log'],
  ['CLAUDE_GEMINI_MODEL_FABLE|OPUS|SONNET|HAIKU', 'route a Claude role to another gemini-* model id'],
  ['CLAUDE_GEMINI_CLAUDE_BIN / CLAUDE_GEMINI_AGY_BIN', 'explicit path to Claude Code / Antigravity CLI'],
  ['CLAUDE_GEMINI_DENY_READ', 'extra directories (":"-separated) the Gemini process may never read'],
  ['CLAUDE_GEMINI_LEAN_FILTERS', 'JSON file replacing the default lean-profile rules'],
];

function doctor({ json }) {
  const items = [];
  const add = (status, title, detail = '') => items.push({ status, title, detail });
  const home = homedir();
  const sandbox = process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec');
  add(sandbox ? 'ok' : 'fail', 'macOS with sandbox-exec', sandbox ? process.platform : MESSAGES.UNSUPPORTED_PLATFORM);
  const major = Number(process.versions.node.split('.')[0]);
  add(major >= 22 ? 'ok' : 'fail', 'Node.js 22 or newer', process.versions.node);
  let claude, agy;
  try {
    claude = resolveBinary('claude', 'CLAUDE_GEMINI_CLAUDE_BIN');
    let version = '';
    try { version = execFileSync(claude, ['--version'], { timeout: 10_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch {}
    add('ok', 'Claude Code found', `${claude}${version ? ` (${version})` : ''}`);
  } catch (error) { add('fail', 'Claude Code found', MESSAGES[error.message] ?? error.message); }
  try { agy = resolveBinary('agy', 'CLAUDE_GEMINI_AGY_BIN'); add('ok', 'Antigravity CLI (agy) found', agy); }
  catch (error) { add('fail', 'Antigravity CLI (agy) found', MESSAGES[error.message] ?? error.message); }
  let aliases = AGY_ALIASES;
  try { aliases = resolveAliases(process.env); } catch (error) { add('fail', 'Model routing', MESSAGES[error.message] ?? error.message); }
  if (agy) {
    try {
      const listing = execFileSync(agy, ['models'], { timeout: 30_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      const ids = listing.split('\n').map((line) => line.split('\t')[0].trim()).filter((id) => /^[a-z0-9][a-z0-9.-]+$/.test(id));
      if (!ids.length) add('fail', 'Antigravity signed in', 'agy models returned no models. Run `agy` once to sign in.');
      else {
        add('ok', 'Antigravity signed in', `${ids.length} models available`);
        const missing = Object.entries(aliases).filter(([, model]) => !ids.includes(model));
        if (missing.length) add('warn', 'Routed models available', `not listed by agy models: ${missing.map(([alias, model]) => `${alias}=${model}`).join(', ')}`);
      }
    } catch (error) {
      const detail = String(error.stderr ?? error.message).split('\n').find((line) => line.trim()) ?? 'agy models failed';
      add('fail', 'Antigravity signed in', `${detail.trim()} (run \`agy\` once to sign in)`);
    }
  }
  const profile = inspectAgyProfile(home);
  for (const entry of profile.errors) add('fail', `Antigravity profile (${entry.code})`, entry.detail);
  for (const entry of profile.warnings) add('warn', `Antigravity profile (${entry.code})`, entry.detail);
  if (!profile.errors.length && !profile.warnings.length) add('ok', 'Antigravity profile', 'no conflicting settings');
  add('ok', 'Model routing', Object.entries(aliases).map(([alias, model]) => `${alias}=${model}`).join(' '));
  try {
    const limits = resolveConcurrency(process.env);
    add('ok', 'Concurrency', `maxConcurrent=${limits.maxConcurrent} maxSessions=${limits.maxSessions}`);
  } catch (error) { add('fail', 'Concurrency', MESSAGES[error.message] ?? error.message); }
  add('ok', 'Request log', process.env.CLAUDE_GEMINI_LOG === '0' ? 'disabled' : DEFAULT_LOG);
  const failed = items.some((item) => item.status === 'fail');
  if (json) console.log(JSON.stringify({ status: failed ? 'fail' : 'ok', items }, null, 2));
  else {
    const marks = { ok: '✓', fail: '✗', warn: '!' };
    for (const item of items) console.log(`${marks[item.status]} ${item.title}${item.detail ? ` — ${item.detail}` : ''}`);
    console.log(failed ? '\nNot ready: fix the ✗ items above.' : '\nReady. Run: claude-gemini');
  }
  return failed ? 1 : 0;
}

try {
  const rawArgs = process.argv.slice(2);
  const separator = rawArgs.indexOf('--');
  const options = [];
  const claudeArgs = separator < 0 ? [] : rawArgs.slice(separator + 1);
  const leading = separator < 0 ? rawArgs : rawArgs.slice(0, separator);
  for (let i = 0; i < leading.length; i++) {
    const arg = leading[i];
    if (arg === '--gemini-model' || arg === '--gemini-timeout') options.push(arg, leading[++i]);
    else if (arg.startsWith('--gemini-model=') || arg.startsWith('--gemini-timeout=')
      || ['--check', '--json', '--help', '--full-context'].includes(arg)) options.push(arg);
    else claudeArgs.push(arg);
  }
  const { values } = parseArgs({ args: options, options: {
    check: { type: 'boolean' }, json: { type: 'boolean' }, help: { type: 'boolean' }, 'full-context': { type: 'boolean' },
    'gemini-model': { type: 'string', default: 'sonnet' },
    'gemini-timeout': { type: 'string', default: process.env.CLAUDE_GEMINI_TIMEOUT_S ?? '600' },
  } });
  if (values.help) {
    console.log('Usage: claude-gemini [--gemini-model fable|opus|sonnet|haiku] [--gemini-timeout seconds] [--full-context] [Claude Code arguments]');
    console.log('       claude-gemini --check [--json]     verify the installation');
    console.log('Runs Claude Code with Gemini models through your own Antigravity CLI login. Claude Code executes the tools.');
    console.log('\nOptions:');
    console.log('  --gemini-model     role to start with (default sonnet = gemini-4-neon-low)');
    console.log('  --gemini-timeout   per-turn Gemini timeout in seconds (default 600)');
    console.log('  --full-context     send every Claude Code memory/hook block instead of the lean profile');
    console.log('  --check [--json]   doctor: platform, binaries, sign-in, profile, model routing');
    console.log('\nEnvironment:');
    for (const [name, text] of ENV_HELP) console.log(`  ${name.padEnd(48)} ${text}`);
    console.log(`\nRequest log: ${DEFAULT_LOG}`);
    console.log('Docs: https://github.com/roanalytics/claudecode-gemini-adapter#readme');
    process.exit(0);
  }
  if (values.check) process.exit(doctor({ json: values.json }));
  const alias = values['gemini-model'];
  if (!Object.hasOwn(AGY_ALIASES, alias)) throw Error('INVALID_AGY_ALIAS');
  const timeoutSeconds = Number(values['gemini-timeout']);
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 10 || timeoutSeconds > 3600) throw Error('INVALID_GEMINI_TIMEOUT');
  const aliases = resolveAliases(process.env);
  const { maxConcurrent, maxSessions } = resolveConcurrency(process.env);
  const rules = loadLeanRules(process.env);
  if (process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec')) throw Error('UNSUPPORTED_PLATFORM');
  const home = homedir();
  const agy = resolveBinary('agy', 'CLAUDE_GEMINI_AGY_BIN');
  const claude = resolveBinary('claude', 'CLAUDE_GEMINI_CLAUDE_BIN');
  await access(agy);
  const profile = inspectAgyProfile(home);
  if (profile.errors.length) {
    for (const entry of profile.errors) console.error(`claude-gemini: ${entry.code}: ${entry.detail}`);
    throw Error(profile.errors[0].code);
  }
  for (const entry of profile.warnings) console.error(`claude-gemini: note: ${entry.detail}`);
  const provider = await realpath(await mkdtemp(path.join(tmpdir(), 'claudecode-gemini-live-')));
  const log = createLogger();
  const lean = !values['full-context'];
  let pool;
  try {
    await writeBridgeAgent(provider);
    const live = createAgyInvoker({ home, workspace: process.cwd(), provider, agy, timeoutMs: timeoutSeconds * 1000,
      denyRead: parseDenyRead(process.env.CLAUDE_GEMINI_DENY_READ, home) });
    if (process.env.CLAUDE_GEMINI_SESSIONS !== '0') {
      pool = createSessionPool({ spawnSession: live.spawnSession, maxSessions, turnTimeoutMs: timeoutSeconds * 1000, log, rules });
    }
    const controller = new AbortController();
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => controller.abort());
    const result = await runHarness({ infer: createRoutedAgyTransport({ invoke: live.invoke, pool, lean, rules, aliases }),
      args: claudeArgs, timeoutSeconds, executable: claude, aliases,
      signal: controller.signal, agyAlias: alias, maxConcurrent,
      bridgeOptions: { queueTimeoutMs: 120_000, countTokens: estimateTokens, log } });
    process.exitCode = result.code ?? 1;
  } finally { pool?.close(); await rm(provider, { recursive: true, force: true }); }
} catch (error) {
  const code = /^[A-Z_]+$/.test(error.message) ? error.message : 'BRIDGE_START_FAILED';
  console.error(`claude-gemini: ${MESSAGES[code] ?? 'Could not start. Run `claude-gemini --check`.'} [${code}]`);
  process.exitCode = 1;
}
