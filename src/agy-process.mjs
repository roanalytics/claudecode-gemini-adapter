import { execFile as execFileDefault, spawn as spawnDefault } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';

export { writeBridgeAgent } from './agy-agent.mjs';

const QUOTA = /RESOURCE_EXHAUSTED|rate limit|quota exceeded|\b429\b/i;
const NOISE = /operation not permitted|readonly database|recordTrajectoryAnalytics|summary store|GeminiDir|token source|ListExperiments/;

// Last glog error lines, minus known sandbox noise. Never contains prompt text.
export function stderrTail(stderr = '') {
  return String(stderr).split('\n').filter((line) => /^E\d{4} /.test(line) && !NOISE.test(line)).join('\n').slice(-800);
}

// Locations a sandboxed provider process may never read, in addition to the current workspace.
export const DEFAULT_DENY_READ = ['.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker', '.config/gh', '.netrc', '.npmrc',
  '.pypirc', '.claude', '.codex', 'Documents', 'Desktop', 'Downloads'];

// CLAUDE_GEMINI_DENY_READ: absolute paths (or ~/...) separated by ':'. Anything else is ignored.
export function parseDenyRead(value = '', home = homedir()) {
  return String(value).split(':').map((entry) => entry.trim()).filter(Boolean)
    .map((entry) => entry === '~' ? home : entry.startsWith('~/') ? path.join(home, entry.slice(2)) : entry)
    .filter((entry) => path.isAbsolute(entry));
}

export function createAgyInvoker({ home = homedir(), workspace, provider, agy = path.join(home, '.local/bin/agy'), denyRead = [],
  turnLimit = Infinity, timeoutMs = 600_000, printTimeout = '0s', execFile = execFileDefault, spawn = spawnDefault } = {}) {
  const quote = JSON.stringify;
  const guard = [
    '(version 1)',
    '(allow default)',
    '(deny file-read* ' + [workspace, ...DEFAULT_DENY_READ.map((entry) => path.join(home, entry)), ...denyRead]
      .map(p => '(subpath ' + quote(p) + ')').join(' ') + ' (regex #"/[.]env[^/]*(/|$)"))',
    '(deny file-write*)',
    '(allow file-write* (subpath ' + quote(provider) + '))',
  ].join('\n');
  const env = { HOME: home, TMPDIR: provider, PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', TERM: 'dumb' };
  const settings = JSON.stringify({
    useG1Credits: false, modelProvider: '', allowNonWorkspaceAccess: false, toolPermission: 'strict',
    permissions: { deny: ['read_file(*)', 'write_file(*)', 'read_url(*)', 'execute_url(*)', 'command(*)', 'mcp(*)'] },
  });
  const sandbox = guard + '\n(deny process-exec)\n(allow process-exec (literal ' + quote(agy) + '))' +
    '\n(allow process-exec (literal "/usr/bin/security"))';
  const fixed = ['--sandbox', '--disable-slash-commands', '--settings', settings, '--print-timeout', printTimeout];
  const diagnostics = [];
  let calls = 0;
  const record = (entry) => { diagnostics.push(entry); if (diagnostics.length > 50) diagnostics.shift(); };
  const invoke = ({ args, stdin, signal }) => new Promise((resolve, reject) => {
    if (calls >= turnLimit) { reject(Error('CANARY_CALL_LIMIT')); return; }
    calls++;
    const expectedModel = args[args.indexOf('--model') + 1];
    const child = execFile('/usr/bin/sandbox-exec', ['-p', sandbox, agy, ...args, ...fixed],
    { cwd: provider, env, signal, timeout: timeoutMs, maxBuffer: 8_000_000, killSignal: 'SIGKILL' }, (error, stdout, stderr) => {
      const parsed = String(stdout ?? '').trim().split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
      const init = parsed.find(e => e?.event === 'init')?.init;
      const result = parsed.filter(e => e?.event === 'result').at(-1)?.result;
      let structured = false;
      try { structured = Array.isArray(JSON.parse(result?.response).content); } catch {}
      const diagnostic = (result?.error ?? '') + ' ' + stderrTail(stderr);
      record({
        exit: typeof error?.code === 'number' ? error.code : error ? 'failed' : 0,
        init: Boolean(init), exactModel: init?.model === expectedModel,
        permission: ['strict', 'request-review', 'always-proceed'].includes(init?.permission_mode) ? init.permission_mode : null,
        status: ['SUCCESS', 'ERROR'].includes(result?.status) ? result.status : null,
        turns: Number.isSafeInteger(result?.num_turns) ? result.num_turns : null,
        structured, authenticationRequired: /authentication (required|failed)|sign in|not logged/i.test(diagnostic),
        quotaLimited: QUOTA.test(diagnostic),
        nativeAction: parsed.some(e => e?.step_update?.step_type === 'tool' ||
          e?.step_update?.tool_name || e?.step_update?.subagent_info),
      });
      if (error) {
        reject(Object.assign(Error('AGY_PROCESS_FAILED'), { stderrTail: stderrTail(stderr),
          timedOut: error.killed === true && error.signal === 'SIGKILL' && !signal?.aborted }));
      } else resolve(stdout);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(stdin);
  });
  // Long-lived process for the session pool: one NDJSON `user` event per turn on stdin.
  const spawnSession = (args) => {
    calls++;
    return spawn('/usr/bin/sandbox-exec', ['-p', sandbox, agy, ...args, ...fixed], { cwd: provider, env, stdio: ['pipe', 'pipe', 'pipe'] });
  };
  return { invoke, spawnSession, diagnostics, guard, env, get calls() { return calls; } };
}
