# Performance and measurements

All numbers were measured against the official Antigravity CLI on 2026-11-25/26 (macOS, Claude Code 2.1.332, Antigravity CLI 1.5.17) with synthetic prompts. They are observations on one account and machine, not guarantees, prices or quota statements.

## Summary

| | Before the persistent-session design | Now |
|---|---|---|
| Bytes sent on follow-up turns | about 230 KB (about 57,000 tokens) every turn | 325–503 characters in a live tool loop |
| Follow-up turn latency (Neon Medium) | 12–40 s, or an error | 2.8–4.1 s |
| Antigravity baseline per call | 12,929 input tokens | 5,097 input tokens |
| A failure that cannot succeed | up to 10 retries (about 19 minutes) | 1 request, readable code |
| Messages above Antigravity's size limit | silently truncated, newest content lost | split below the limit, never truncated |

## What was measured

| Question | Result |
|---|---|
| Why did sessions fail with an invalid result? | `--print-timeout` expiry makes `agy` exit 0 with `status: SUCCESS`, an empty `response` and `finished_reason: "print_timeout"`. A naive adapter parses the empty string and reports an invalid result; Claude Code then retries the identical request. The adapter detects the timeout, uses its own configurable timeout and reports `AGY_TIMEOUT` once |
| Antigravity message size limit | One `user` event is intact at 191,250 characters and truncated at 194,687, with the truncation notice injected into the text. The newest content is lost. The adapter caps events at 153,600 (80% of the limit) |
| Real Claude Code request size | About 230 KB per turn on a heavy profile: system 7 KB, tool schemas 36 KB, global `CLAUDE.md` 108 KB, memory and hook messages 62 KB |
| Baseline of the default agent vs the dedicated agent | 12,929 vs 5,097 input tokens for "Di OK" on Neon Medium |
| Persistent stream-json session | One process accepts several `user` events; `num_turns` counts 1, 2, 3; `cache_read_tokens` accumulates. Neon Medium: 9.9 s, 4.3 s, 3.2 s. Flash Low: 5.1 s, 2.1 s, 2.3 s |
| `--json-schema` | `num_turns` rises by 4 per event, `response` is duplicated, Flash Low took 15 s per turn instead of 2 s, and input tokens grew from 15,990 to 50,521 over three turns instead of 5,250 to 9,636. Rejected |
| `--effort` | Conflicts with model ids that already carry an effort level (`--model gemini-4-neon-xhigh --effort low` is an error), so effort is chosen by choosing the model id |
| Model speed for one simple tool proposal | Neon XHigh 39 s and 3,758 thinking tokens; Neon Low 6 s; Flash Low 4.7 s |
| Live canary, Neon Medium, four requests (two reads, a write, a shell command) | 7.9 s first request (15,435-character first event), then 10.9 s, 3.8 s, 2.8 s with 441, 503 and 325-character events; input tokens 8,918 to 16,656; exact file output |
| Live canary, Flash Low | 5.0 s, then 2.4 s, 2.1 s, 1.5 s with the same event sizes; the written file had its two lines swapped in two of two runs (model quality, not transport) |
| Heavy real profile (large global `CLAUDE.md`, memory plugins, MCP servers) | First turn split into two events of 153,351 and 47,372 characters; a follow-up event of 380 characters in 4.1 s; the lean profile removed about 2.4 KB |
| Heavy profile with a subagent | Two sessions (parent and subagent); follow-ups of 14,588 and 1,100 characters; no errors |
| Lean tool-schema compaction | Stripping `$schema` and trimming nested property descriptions above 200 chars cut an isolated Claude Code first event from 48,721 to 44,278 characters (~4.5 KB saved) with zero schema errors |
| Quality & efficiency benchmark (build a 3-module DAG planner + recursive-descent filter compiler + transitive closure from scratch; 16 hidden edge-case checks) | `claude-sonnet-5-5`: 61.3 s, 5 round-trips, 16/16, $0.19 · `claude-opus-5-5`: 143.8 s, 5 round-trips, 47 tests, $0.62 · `gemini-4-neon-low`: **118.4 s**, 6 round-trips, **16/16**, 14.1k out · `gemini-4-neon-medium`: 211.2 s, 9 round-trips, **16/16**, 25.1k out · `gemini-4-neon-high`: 274.3 s, 8 round-trips, **16/16** (31 tests), 34.5k out · `gemini-3.8-flash-high`: failed turn 1 (`AGY_INVALID_RESULT`) |

Claude Code retry behavior is documented in [architecture](architecture.md#error-handling).

## Where the remaining cost is

- **The first turn of each conversation** carries the full context, so a heavy profile (very large `CLAUDE.md`, many always-on plugins, many MCP servers) makes it slower. Trimming those has the biggest effect, and it helps plain Claude Code too.
- **Reasoning effort.** The `fable` route spends thousands of thinking tokens even on trivial steps.
- **Background requests.** Claude Code issues small requests (titles, summaries) with different system prompts; each opens its own short-lived session. The `haiku` route keeps them cheap.

## Reproduce

All of these need your signed-in Antigravity CLI and must run outside restrictive sandboxes (they use the network and the macOS keychain helper).

```sh
npm run bench:live        # truncation limit, session latency, agent overhead (synthetic data)
npm run canary:primary    # two live turns with one real Claude Read
npm run canary:sessions   # real Claude Code, persistent live session, multiple tools
npm run canary:features   # the full feature matrix (see claude-code-compatibility.md)
```

Offline checks that need no account: `npm test`, `npm run smoke`, `npm run smoke:sessions`, `npm run smoke:errors`, `npm run smoke:models`.
