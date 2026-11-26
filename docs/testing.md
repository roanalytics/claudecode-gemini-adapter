# Testing and regression guide

Every test in this repository is automated, uses synthetic temporary workspaces, and is safe to run on any macOS machine with your own installation. Run the relevant tier after modifying the adapter, upgrading Claude Code, upgrading the Antigravity CLI (`agy`), or upgrading Node.js.

## Test pyramid

| Tier | Command | Needs | Typical runtime | What it validates |
|---|---|---|---|---|
| 1. Unit tests | `npm test` | Node 22+, loopback socket | ~3 s | Bridge HTTP/SSE protocol, JSON envelope parser & lenient repair, message rendering & lean rules, session pool (deltas, eviction, repair, per-turn usage), model routing, profile inspection, binary discovery, concurrency limits, PID logger (101 tests) |
| 2. Smoke tests | `npm run smoke` `smoke:sessions` `smoke:errors` `smoke:models` | Real Claude Code (no Google account) | ~15–20 s total | Real Claude Code against simulated `agy` fixtures: tool loop, persistent delta reuse, 1-request failure policy (`x-should-retry: false`), and all 4 role routes |
| 3. Install portability | `npm run verify:install` | Claude Code (`agy` optional for live step) | ~40–60 s | Clean copy into a temporary path with spaces and accents, syntax check on every `.mjs`, unit tests, doctor under different `PATH`/override/profile layouts, live prompt, Node 22 check |
| 4. Session canary | `npm run canary:sessions` | Real Claude Code + signed-in `agy` | ~25–40 s | Multi-turn persistent session against Gemini: exact model verification, delta size drop, `cacheRead` and per-turn `output_tokens` deltas |
| 5. Feature matrix (29 scenarios) | `npm run canary:features` | Real Claude Code + signed-in `agy` | ~5–10 min | End-to-end Claude Code capabilities: Read/Write/Edit/`replace_all`, Bash fg/bg/exit/TaskStop, Monitor, Cron, NotebookEdit, subagents + SendMessage, worktrees, MCP tools & resources, plan mode, `--resume`, PNG handling, 400 KB guard, all 4 aliases, quoting regression |
| 6. Parallel stress test | `npm run canary:stress` | Real Claude Code + signed-in `agy` | ~45–90 s | Multiple independent `claude-gemini` instances at the same time, each running parallel subagents, an MCP server (150+ tools), Read, Edit (with quotes) and Bash; checks zero cross-contamination, distinct PIDs in the shared log, delta reuse, zero bridge errors and zero leaked temp directories |
| 7. Provider & latency checks | `npm run canary:primary`, `npm run bench:live` | Signed-in `agy` | ~1–3 min | Direct Antigravity CLI contract (flags, isolation, event sizes) and live latency / token baseline measurements |

## When to run which suite

| Trigger | Recommended commands |
|---|---|
| Small code change or PR | `npm test && npm run smoke && npm run smoke:sessions && npm run smoke:errors && npm run smoke:models` |
| Changed session pool, JSON envelope repair, rendering, sandbox or validation | Above + `npm run canary:sessions` + targeted `npm run canary:features -- --only ...` |
| Upgraded Claude Code (`claude --version` changed) | `claude-gemini --check` + `npm run smoke:sessions && npm run smoke:errors` + `npm run canary:features` |
| Upgraded Antigravity CLI (`agy --version` changed) | `claude-gemini --check` + `npm run canary:primary` + `npm run canary:sessions` + `npm run canary:stress` |
| Pre-release / full regression sweep | All tiers in order (see [Full regression checklist](#full-regression-checklist)) |

## Running each suite

### 1. Unit tests (offline)

```sh
npm test
```

Runs `node --test --test-concurrency=1` across all files in `test/`. No network access or Google account is required, only permission to bind a loopback socket on `127.0.0.1`.

### 2. Smoke tests (real Claude Code, simulated Gemini)

```sh
npm run smoke
npm run smoke:sessions
npm run smoke:errors
npm run smoke:models
```

Each script launches the real `claude` CLI in an isolated temporary `HOME` against synthetic fixtures (`test/fixtures/agy-session.mjs`, etc.):

- `smoke`: full `Read` tool round-trip without calling Google.
- `smoke:sessions`: confirms a single persistent session is reused across turns and the second event shrinks to a small delta (e.g. `10090 -> 345` chars).
- `smoke:errors`: confirms deterministic errors (`AGY_TIMEOUT`, `INVALID_MODEL_TOOL_CALL`, `INVALID_TOOLS`) return HTTP `502` with `x-should-retry: false` and cost exactly **1 request** (no retry storm).
- `smoke:models`: confirms `fable`, `opus`, `sonnet` and `haiku` route to their exact Gemini model IDs.

### 3. Clean-install portability check

```sh
npm run verify:install
```

Copies the repository into a fresh temporary path containing spaces and accents, checks syntax on every `.mjs` file, runs unit tests, exercises `claude-gemini --check` under missing binaries, explicit overrides and conflicting Antigravity settings, runs a live prompt if signed in, and verifies Node 22 compatibility.

### 4. Live session canary

```sh
npm run canary:sessions                  # default route (sonnet)
node scripts/canary-sessions.mjs haiku   # test another route
```

Verifies multi-turn tool execution against live Gemini with persistent sessions, checking that follow-up events stay tiny, `output_tokens` and `cacheRead` report per-turn deltas, and no native Antigravity tools are invoked.

### 5. Live 29-scenario Claude Code feature matrix

```sh
npm run canary:features                        # all 29 scenarios on sonnet
npm run canary:features -- --only 12,14,29     # run selected scenario numbers
npm run canary:features -- --alias haiku       # test another primary route
npm run canary:features -- --offline           # skip WebFetch and WebSearch
npm run canary:features -- --skip-real-profile # skip scenario 19 (user's own Claude profile)
```

Writes a structured JSON report to `$TMPDIR/claudecode-gemini-features-report.json` and exits `0` only if `fail === 0`. Scenarios whose tool does not exist in your Claude Code build report `n/a` rather than failing. See [claude-code-compatibility.md](claude-code-compatibility.md) for the complete 29-item matrix.

### 6. Live multi-instance parallel stress test

```sh
npm run canary:stress                                       # 3 parallel instances on sonnet
npm run canary:stress -- --instances 4 --alias sonnet       # 4 parallel instances (2–6 allowed)
npm run canary:stress -- --max-concurrent 6 --max-sessions 10
npm run canary:stress -- --timeout 600
```

Launches `N` independent `claude-gemini` processes at the exact same instant, each in its own temporary workspace with its own unique random tokens and its own MCP fixture server (`test/fixtures/mcp-echo.mjs`, 151 tools). Simultaneously, every instance runs:

1. `Read` on `input.txt` in parallel with **two general-purpose `Agent` subagents** (`sub-a.txt` and `sub-b.txt`).
2. `Edit` on `target.js` replacing a line with a quoted string (regression for JSON escaping under load).
3. `Bash` echoing a unique token.
4. `ToolSearch` + MCP tool call (`mcp__echo__echo`).

Assertions checked per worker and globally:

| Check | What it proves |
|---|---|
| `exitClean` | Exit code `0`, no timeout, `is_error !== true` |
| `noBridgeErrors` | Zero bridge error codes (`429`, `502`, `INVALID_MODEL_JSON`, `AGY_TIMEOUT`, `AGY_NATIVE_ACTION`) |
| `allTokensPresent` | All 5 unique tokens (Read, 2 subagents, Bash, MCP `ECHO:`) returned accurately |
| `noCrossContamination` | None of the other instances' tokens appear in this instance's reply or files |
| `editExact` | Exact quoted line written to `target.js` on disk |
| `subagentUsed` | `Agent`/`Task` tool actually executed |
| `multiSession` | At least 2 new persistent sessions created (parent + subagents isolated) |
| `deltaReused` | At least 1 reused delta turn inside the persistent session |
| `pidLogged` & `distinctPids` | Every instance logged requests under its own distinct `pid` in `bridge.jsonl` |
| `noLeakedTempDirs` | No new `claudecode-gemini-live-*` or `claudecode-gemini-harness-*` temp dirs left behind |

Writes a structured JSON report to `$TMPDIR/claudecode-gemini-stress-report.json`.

**Measured baseline (2026-11-26, Claude Code 2.1.332, Antigravity CLI 1.5.17, `sonnet`, 3 instances = 9 concurrent agents + 3 MCP servers):**

| Instance | Wall time | Requests | New / reused sessions | Max event | Errors | Result |
|---|---:|---:|---|---:|---:|---|
| `worker-1` | 45 s | 7 | 3 new / 4 reused | 51,605 chars | 0 | Pass |
| `worker-2` | 41 s | 7 | 3 new / 4 reused | 51,605 chars | 0 | Pass |
| `worker-3` | 43 s | 7 | 3 new / 4 reused | 51,605 chars | 0 | Pass |
| **Total** | **45 s wall** | **21 req** | **3/3 distinct PIDs** | **0 leaked temp dirs** | **0** | **3/3 pass** |

## Full regression checklist

Run from the repository root outside restrictive sandboxes (live suites need network access and the macOS Keychain helper used by `agy`):

```sh
claude-gemini --check
npm test
npm run smoke && npm run smoke:sessions && npm run smoke:errors && npm run smoke:models
npm run canary:sessions
npm run canary:stress
npm run canary:features
npm run verify:install
```

## Debugging failures with the shared log

When multiple instances run concurrently, every line in `~/Library/Logs/claudecode-gemini-adapter/bridge.jsonl` includes `"pid"` (the `claude-gemini` launcher PID). Filter a single instance:

```sh
node -e '
const fs = require("fs");
const pid = Number(process.argv[1]);
for (const line of fs.readFileSync(process.env.HOME + "/Library/Logs/claudecode-gemini-adapter/bridge.jsonl", "utf8").trim().split("\n")) {
  const e = JSON.parse(line);
  if (!pid || e.pid === pid) console.log(line);
}
' <PID>
```

Check the JSON reports written by live suites:

- `$TMPDIR/claudecode-gemini-features-report.json`
- `$TMPDIR/claudecode-gemini-stress-report.json`

## Adding new regression tests

- **Protocol, parser, renderer or pool bugs:** add a deterministic unit test under `test/` (using `test/fixtures/agy-session.mjs` when persistent session behavior is involved) so `npm test` catches regressions in under 3 seconds.
- **Claude Code capability regressions:** add a numbered scenario to `scripts/canary-features.mjs` with synthetic temp files and update the matrix in [claude-code-compatibility.md](claude-code-compatibility.md).
- **Concurrency or multi-instance issues:** extend `scripts/canary-stress.mjs` or test higher `--instances` / `--max-concurrent` values.
- **Never** commit real transcripts, user paths, credentials or non-synthetic repository references in tests or fixtures.
