import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { AGY_ALIASES, createRoutedAgyTransport } from '../src/agy-model-routes.mjs';
import { checkAgyProfile } from '../src/agy-profile.mjs';
import { resolveBinary } from '../src/binaries.mjs';
import { runHarness } from '../src/harness.mjs';
import { BridgeError } from '../src/protocol.mjs';
import { createLedgerTask } from './primary-ledger.mjs';
import { createAgyInvoker, writeBridgeAgent } from '../src/agy-process.mjs';

const args = process.argv.slice(2);
const long = args[0] === '--long';
if (long) args.shift();
const alias = args[0] ?? 'sonnet';
if (args.length > 1 || !Object.hasOwn(AGY_ALIASES, alias) || process.platform !== 'darwin') process.exit(2);
const model = AGY_ALIASES[alias];
const home = homedir();
const agy = resolveBinary('agy', 'CLAUDE_GEMINI_AGY_BIN');
const marker = 'PRIMARY-' + randomBytes(8).toString('hex');
const root = await realpath(await mkdtemp(path.join(tmpdir(), 'claudecode-gemini-primary-')));
const workspace = path.join(root, 'claude');
const provider = path.join(root, 'provider');
const ledger = long ? createLedgerTask(workspace) : null;
const goalReads = ledger?.files.length ?? 1;
const turnLimit = goalReads + 1;
const fixture = ledger?.files[0].path ?? path.join(workspace, 'probe.txt');
const live = createAgyInvoker({ home, workspace, provider, agy, turnLimit, timeoutMs: 45_000, printTimeout: '35s' });
const { invoke, diagnostics: safeDiagnostics, guard, env } = live;
const usage = [];
let bridgeStats = null, stage = 'PRECHECK', seenResult = false;
let replays = 0;
try {
  checkAgyProfile(home);
  await mkdir(workspace, { mode: 0o700 });
  await mkdir(provider, { mode: 0o700 });
  await writeBridgeAgent(provider);
  for (const file of ledger?.files ?? [{ path: fixture, line: marker }]) {
    await writeFile(file.path, file.line + '\n', { mode: 0o600, flag: 'wx' });
  }
  const denyProbe = spawnSync('/usr/bin/sandbox-exec', ['-p', guard, process.execPath, '-e',
    'try{require("node:fs").readFileSync(process.argv[1]);process.exit(1)}catch(e){process.exit(["EACCES","EPERM"].includes(e.code)?0:2)}', fixture],
  { cwd: provider, env, timeout: 5_000, stdio: 'ignore' });
  if (denyProbe.status !== 0) throw Error('PROVIDER_READ_BOUNDARY_UNPROVEN');

  const routed = createRoutedAgyTransport({ invoke });
  let started = false;
  const infer = async (request, signal) => {
    if (request.model !== model) throw new BridgeError('CANARY_WRONG_MODEL');
    if (ledger) {
      const step = usage.length;
      if (live.calls !== step || step >= turnLimit) throw new BridgeError('CANARY_CALL_LIMIT', 400);
      if (step > 0) {
        if (!ledger.validReplay(step - 1, request.messages)) throw new BridgeError('CANARY_READ_REPLAY_MISSING', 400);
        replays++;
      }
      const generated = await routed(request, signal);
      if (!(generated.usage.input_tokens > 0 && generated.usage.output_tokens > 0)) throw new BridgeError('CANARY_USAGE_MISSING', 400);
      if (step < goalReads) {
        if (!ledger.validCall(step, generated.content)) throw new BridgeError('CANARY_UNSAFE_TOOL', 400);
      } else if (generated.content.length !== 1 || generated.content[0]?.type !== 'text' ||
        !ledger.validReport(generated.content[0].text)) throw new BridgeError('CANARY_FINAL_MISMATCH', 400);
      usage.push(generated.usage);
      return generated;
    }
    const parts = request.messages.flatMap(m => Array.isArray(m.content) ? m.content : []);
    if (!started) started = true;
    else {
      if (seenResult || usage.length !== 1) throw new BridgeError('CANARY_CALL_LIMIT');
      const call = parts.find(b => b.type === 'tool_use' && b.name === 'Read' && b.input?.file_path === fixture);
      const result = parts.find(b => b.type === 'tool_result' && b.tool_use_id === call?.id);
      const content = typeof result?.content === 'string' ? result.content : result?.content?.map(p => p.text ?? '').join('');
      if (!call || !result || result.is_error || !content?.includes(marker)) throw new BridgeError('CANARY_READ_REPLAY_MISSING');
      seenResult = true;
    }
    const generated = await routed(request, signal);
    if (!seenResult) {
      const only = generated.content[0];
      if (generated.content.length !== 1 || only?.type !== 'tool_use' || only.name !== 'Read' ||
        only.input?.file_path !== fixture || Object.keys(only.input).length !== 1) throw new BridgeError('CANARY_UNSAFE_TOOL');
    } else if (generated.content.length !== 1 || generated.content[0]?.type !== 'text' ||
      generated.content[0].text.trim() !== marker) throw new BridgeError('CANARY_FINAL_MISMATCH');
    usage.push(generated.usage);
    return generated;
  };

  stage = 'CLAUDE_RUN';
  const run = await runHarness({
    infer, agyAlias: alias, isolated: true, capture: true, cwd: workspace,
    signal: AbortSignal.timeout(long ? 360_000 : 100_000),
    args: [
      '-p', ledger?.prompt ?? 'Use Read exactly once on ' + fixture + '. Then reply with only the line read from the file.',
      '--system-prompt', long ? 'Use only the offered Read tool. Return the requested reconciliation.' :
        'For this synthetic test, call Read with only file_path, then reply with only its result line.',
      '--output-format', 'json', '--max-turns', String(turnLimit + 1), '--tools', 'Read', '--allowedTools', 'Read',
      '--permission-mode', 'dontAsk', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      '--disable-slash-commands', '--no-session-persistence', '--setting-sources', '',
    ],
  });
  bridgeStats = run.stats;
  const result = JSON.parse(run.stdout);
  const answerOK = ledger ? ledger.validReport(result.result) && replays === goalReads : result.result?.trim() === marker && seenResult;
  if (run.code !== 0 || result.is_error || !answerOK || run.stats.requests !== turnLimit ||
    run.stats.toolCalls !== goalReads || live.calls !== turnLimit || usage.length !== turnLimit) throw Error('CANARY_PROOF_INCOMPLETE');
  console.log(JSON.stringify({
    status: 'pass', mode: 'primary', alias, model, liveGoogle: true, liveClaude: false,
    modelRequests: live.calls, toolCalls: goalReads, toolResultReplayed: true, providerReadDenied: true, usage,
    ...(long ? { task: 'ledger', entries: 96, verifiedReplays: replays } : {}),
  }));
} catch (error) {
  const known = /^(PROVIDER_READ_BOUNDARY_UNPROVEN|CANARY_PROOF_INCOMPLETE|AGY_PROFILE_UNSAFE|AGY_MCP_PRESENT|AGY_CUSTOMIZATIONS_PRESENT)$/;
  console.log(JSON.stringify({ status: 'failed', stage, alias, model, agyAttempts: live.calls,
    reason: known.test(error?.message) ? error.message : 'CANARY_FAILED', diagnostics: safeDiagnostics,
    ...(long ? { task: 'ledger', acceptedResponses: usage.length, toolCalls: bridgeStats?.toolCalls ?? 0, verifiedReplays: replays } : {}),
    ...(bridgeStats ? { rejected: bridgeStats.rejected } : {}) }));
  process.exitCode = 1;
} finally { await rm(root, { recursive: true, force: true }); }
