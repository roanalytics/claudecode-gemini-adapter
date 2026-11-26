import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AGY_ALIASES, createRoutedAgyTransport } from '../src/agy-model-routes.mjs';
import { runHarness } from '../src/harness.mjs';

const scratch = await mkdtemp(path.join(tmpdir(), 'claudecode-gemini-models-'));
const rows = [];
try {
  for (const [alias, expected] of Object.entries(AGY_ALIASES)) {
    const requests = [];
    const target = [];
    const routed = createRoutedAgyTransport({ invoke: async ({ args, stdin }) => {
      assert.equal(JSON.parse(stdin).event, 'user');
      const model = args[args.indexOf('--model') + 1];
      target.push(model);
      return [
        { event: 'init', conversation_id: 'fixture', init: { model, permission_mode: 'request-review' } },
        { event: 'result', result: { conversation_id: 'fixture', status: 'SUCCESS', num_turns: 1,
          response: '{"content":[{"type":"text","text":"AGY_ROUTE_OK"}]}',
          usage: { input_tokens: 29, output_tokens: 8 } } },
      ].map(JSON.stringify).join('\n');
    } });
    const infer = (request, signal) => {
      requests.push(request.model);
      return routed(request, signal);
    };
    const run = await runHarness({
      infer, agyAlias: alias, isolated: true, capture: true, cwd: scratch,
      signal: AbortSignal.timeout(20_000), args: [
        '-p', 'Return the verification token.', '--output-format', 'json', '--max-turns', '1',
        '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
        '--disable-slash-commands', '--no-session-persistence', '--setting-sources', '',
      ],
    });
    if (run.code !== 0 || !run.stdout.includes('AGY_ROUTE_OK')) {
      console.error(JSON.stringify({ alias, exit: run.code, stats: run.stats, requests, target }));
      throw Error('ROUTE_SMOKE_FAILED');
    }
    assert.deepEqual(requests, [expected]);
    assert.deepEqual(target, [expected]);
    rows.push({ alias, model: expected });
  }
  console.log(JSON.stringify({ status: 'pass', harness: 'real-claude-code', routes: rows, liveGoogle: false }));
} finally { await rm(scratch, { recursive: true, force: true }); }
