import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { createBridge } from './bridge.mjs';
import { resolveBinary } from './binaries.mjs';
import { root } from './paths.mjs';
import { AGY_ALIASES, claudeAgyModelPins } from './agy-model-routes.mjs';

export async function runHarness({ infer, args = [], cwd = process.cwd(), isolated = false, allowImages = false, maxConcurrent = 1,
  executable = resolveBinary('claude', 'CLAUDE_GEMINI_CLAUDE_BIN'), signal, capture = false, agyAlias, timeoutSeconds = 600,
  bridgeOptions = {}, aliases = AGY_ALIASES } = {}) {
  if (agyAlias !== undefined && (typeof agyAlias !== 'string' || !Object.hasOwn(AGY_ALIASES, agyAlias))) {
    throw Error('INVALID_AGY_ALIAS');
  }
  const pins = agyAlias === undefined ? {} : claudeAgyModelPins(aliases);
  const scratch = await mkdtemp(path.join(tmpdir(), 'claudecode-gemini-harness-'));
  const token = randomBytes(32).toString('hex');
  const bridge = await createBridge({ infer, token, allowImages, maxConcurrent, ...bridgeOptions });
  const apiTimeout = String((timeoutSeconds + 60) * 1000);
  try {
    const settings = path.join(scratch, 'settings.json');
    const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: isolated ? path.join(scratch, 'home') : homedir(),
      TERM: process.env.TERM ?? 'dumb', LANG: 'en_US.UTF-8', CLAUDE_GEMINI_ADAPTER_KEY: token,
      ANTHROPIC_BASE_URL: bridge.url, ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1',
      DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_PROMPT_CACHING: '1',
      CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: '1', MAX_THINKING_TOKENS: '0', API_TIMEOUT_MS: apiTimeout, ...pins };
    if (isolated) {
      await mkdir(env.HOME, { mode: 0o700 });
      env.CLAUDE_CONFIG_DIR = path.join(env.HOME, '.claude');
    }
    // Only the helper's path is persisted; the capability stays in the child's environment.
    await writeFile(settings, JSON.stringify({ apiKeyHelper: `${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(root, 'bin/token-helper.mjs'))}`,
      env: { ANTHROPIC_BASE_URL: bridge.url, ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '',
        DISABLE_PROMPT_CACHING: '1', MAX_THINKING_TOKENS: '0', API_TIMEOUT_MS: apiTimeout,
        CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', ...pins } }), { mode: 0o600 });
    const result = await new Promise((resolve, reject) => {
      const child = spawn(executable, [...args, '--settings', settings, '--model', agyAlias ?? 'gemini-bridge'], {
        cwd, env, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      });
      let stdout = '';
      let stderr = '';
      let escalation;
      const abort = () => { child.kill('SIGTERM'); escalation = setTimeout(() => child.kill('SIGKILL'), 1000); };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      child.stdout?.on('data', (chunk) => { if (stdout.length < 1_000_000) stdout += chunk; });
      child.stderr?.on('data', (chunk) => { if (stderr.length < 100_000) stderr += chunk; });
      child.once('error', reject);
      child.once('close', (code, childSignal) => {
        clearTimeout(escalation);
        signal?.removeEventListener('abort', abort);
        resolve({ code, signal: childSignal, stdout, stderr, stats: { ...bridge.stats } });
      });
    });
    return result;
  } finally { await bridge.close(); await rm(scratch, { recursive: true, force: true }); }
}
