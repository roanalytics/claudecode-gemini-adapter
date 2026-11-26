# Claude Code compatibility

What works when Claude Code runs on Gemini through this adapter, verified against the real Claude Code and a signed-in Antigravity CLI. Run it yourself:

```sh
npm run canary:features                    # all scenarios, default route (sonnet)
npm run canary:features -- --only 8,14     # selected scenarios
npm run canary:features -- --alias haiku   # another primary route
npm run canary:features -- --offline       # skip scenarios that need the internet
npm run canary:features -- --skip-real-profile
```

Each scenario launches the real `claude-gemini` launcher with Claude Code in headless mode, inside its own temporary directory with synthetic files, and checks an observable effect (file contents, an exact token in the answer, the bridge log). The report is also written to `claudecode-gemini-features-report.json` in your temporary directory. Scenarios whose tool is missing in your Claude Code version report `n/a` instead of failing.

**Tested with:** Claude Code 2.1.332, Antigravity CLI 1.5.17 (27 models listed), macOS arm64, route `sonnet` (`gemini-4-neon-medium`) unless the row says otherwise. Result of the latest full run: **29 of 29 pass**. Multi-instance parallel stress canary (`npm run canary:stress`): **3 of 3 parallel instances pass** (9 concurrent agents, 3 MCP servers, 21 requests in 45 s wall time, 0 errors, 0 leaked temp dirs — see [testing](testing.md)).

## Matrix

| # | Capability | Result | Notes |
|---|---|---|---|
| 1 | `Read` a text file | Pass | |
| 2 | `Write` a file | Pass | Exact contents verified |
| 3 | `Edit` a file | Pass | Exact replacement verified |
| 4 | Search (Glob, Grep or Bash `grep`) | Pass | |
| 5 | `Bash`, foreground | Pass | |
| 6 | `Bash` with a non-zero exit code | Pass | The exit code is reported correctly |
| 7 | `Bash` in the background, then retrieving the output | Pass | |
| 8 | `Read` of a PNG, then a follow-up turn with `--resume` | Pass | The image is not forwarded to Gemini (see limits); the conversation stays healthy |
| 9 | `Read` of a 400 KB file | Pass | Largest event sent: 47,838 characters, under the 153,600 guard |
| 10 | Deferred tool through Tool Search (`NotebookEdit`) | Pass | Notebook cell changed as requested |
| 11 | Subagent (general-purpose) | Pass | Parent and subagent use separate persistent sessions |
| 12 | Two subagents in parallel | Pass | No queue timeouts |
| 13 | `WebFetch` | Pass | |
| 14 | MCP server with 150 tools through Tool Search | Pass | Tool loaded on demand, called, answer returned |
| 15 | Session resume (`--resume`) remembers earlier turns | Pass | |
| 16 | Plan mode | Pass | No files written. Claude Code sends an extra `safeguards` field in this mode; the adapter ignores it |
| 17 | Long answer (about 2,000 words) | Pass | |
| 18 | All four roles as primary (`haiku`, `sonnet`, `opus`, `fable`) | Pass | Exact token returned and the exact Gemini model confirmed in the log |
| 19 | Real Claude profile: hooks, memory plugins, MCP, large `CLAUDE.md` | Pass | First event 153,334 characters (under the guard); one new session |
| 20 | `WebSearch` server tool | Pass | Dropped without breaking the session; the model says search is unavailable |
| 21 | `Edit` with `replace_all` | Pass | All three occurrences replaced, the other line untouched |
| 22 | `NotebookEdit` insert and delete | Pass | Verified in the notebook file |
| 23 | `TaskStop` cancels a background `Bash` task | Pass | |
| 24 | `Monitor` streams events | Pass | See the note on asynchronous results below |
| 25 | `CronCreate`, `CronList`, `CronDelete` | Pass | One-shot, session-only job created, listed and deleted |
| 26 | `Explore` subagent resumed with `SendMessage` | Pass | See the note on asynchronous results below |
| 27 | `EnterWorktree` and `ExitWorktree` | Pass | Temporary git repository; the worktree is removed |
| 28 | MCP resources (`ListMcpResourcesTool`, `ReadMcpResourceTool`) | Pass | Fixture server exposes one resource |
| 29 | `Edit` with double quotes, backslashes and a template literal | Pass | Regression for malformed JSON in code strings; the exact line is written to disk |

## What does not work, and what is different

| Area | Behavior |
|---|---|
| Images and PDFs | Claude Code can read them, but this route does not forward them to Gemini. The model sees a placeholder and tells you it cannot see the file. Everything else in the conversation continues normally |
| `WebSearch` | Runs on Anthropic's servers and cannot work here. The tool is removed from what the model sees; use `WebFetch` instead |
| Extended thinking, Anthropic prompt caching | Not used; answers are returned whole, not token by token |
| `haiku` on exact edits | Fast and fine for reading and shell steps, but in a two-file write task it ordered two lines wrongly in two of two runs. Use `sonnet` when exact edits matter |
| `fable` speed | Often 20–60 s per turn; it spends thousands of reasoning tokens even on trivial steps |
| Asynchronous results in headless mode (`Monitor` events, replies to `SendMessage`) | Claude Code delivers them between turns, and a headless run ends as soon as the model answers in text. The model must keep itself in the turn by calling a tool (for example `sleep` in `Bash`). In the canary the first attempt of both scenarios ended with "waiting for the event" until the prompt told the model to keep polling; interactive sessions are not affected |
| Gemini-side tools | Disabled by design; only Claude Code executes tools ([security](security.md)) |
| Claude Code versions newer than tested | Unknown request fields, unknown content block types, server tools and unfamiliar JSON Schema keywords are tolerated and recorded in the request log (`meta.ignoredFields`, `meta.ignoredTools`) instead of failing |

## Reading a failure

If a scenario fails on your machine, the console line shows the exit code, the bridge error codes seen and the first words of the answer. Check the request log (`npm run log`) and [troubleshooting](troubleshooting.md), then open an issue with the report JSON and `claude-gemini --check --json`.
