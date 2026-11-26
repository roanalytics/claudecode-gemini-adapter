# Troubleshooting

Start with the doctor:

```sh
claude-gemini --check
```

Then, for anything that happened during a session:

```sh
npm run log        # from the repository: follows ~/Library/Logs/claudecode-gemini-adapter/bridge.jsonl
```

## Startup errors

The launcher prints `claude-gemini: <explanation> [CODE]` and exits with status 1.

| Code | Cause | Fix |
|---|---|---|
| `AGY_NOT_FOUND` | Antigravity CLI is not installed or not in `~/.local/bin` / `PATH` | Install it ([guide](https://antigravity.google/docs/getting-started/)) or set `CLAUDE_GEMINI_AGY_BIN` |
| `CLAUDE_NOT_FOUND` | Claude Code is not installed or not found | Install it ([guide](https://docs.anthropic.com/en/docs/claude-code/overview)) or set `CLAUDE_GEMINI_CLAUDE_BIN` |
| `UNSUPPORTED_PLATFORM` | Not macOS, or `/usr/bin/sandbox-exec` is missing | Only macOS is supported |
| `AGY_PROFILE_UNSAFE` | Your Antigravity settings enable extra credits (`useG1Credits`), set a custom `modelProvider`, or `settings.json` is unreadable | Edit `~/.gemini/antigravity-cli/settings.json`: `useG1Credits` must be `false`, `modelProvider` empty, the file valid JSON |
| `INVALID_MODEL_OVERRIDE` | A `CLAUDE_GEMINI_MODEL_*` value is not `gemini-<name>` | Fix the variable; list valid ids with `agy models` |
| `INVALID_LEAN_FILTERS` | `CLAUDE_GEMINI_LEAN_FILTERS` is missing, not JSON, not an array, or has a rule without `label` and `paragraph`/`start`, or a bad regular expression | See [configuration](configuration.md#writing-your-own-rules) |
| `INVALID_GEMINI_TIMEOUT` | Timeout is not an integer from 10 to 3600 | Fix `--gemini-timeout` / `CLAUDE_GEMINI_TIMEOUT_S` |
| `INVALID_MAX_CONCURRENT` | `CLAUDE_GEMINI_MAX_CONCURRENT` is not an integer from 1 to 16 | Set an integer from 1 to 16, or unset it for the default (`4`) |
| `INVALID_MAX_SESSIONS` | `CLAUDE_GEMINI_MAX_SESSIONS` is not an integer between `maxConcurrent` and 32 | Set an integer `>= CLAUDE_GEMINI_MAX_CONCURRENT` and `<= 32`, or unset it |
| `INVALID_AGY_ALIAS` | `--gemini-model` is not `fable`, `opus`, `sonnet` or `haiku` | Use one of those |
| `BRIDGE_START_FAILED` | Unexpected startup failure | Run `claude-gemini --check` and read the failing line |

## Profile notes

`claude-gemini --check` and the launcher print `!` notes for Antigravity configuration that cannot weaken the adapter. They do not block you.

| Note | Meaning | Action |
|---|---|---|
| `AGY_PERMISSIONS_ALLOW` | Your Antigravity settings contain "always allow" entries (for example `command(ln)`, added when you pick "always allow" in Antigravity) | None. Inside the adapter, the per-session deny rules win and the sandbox blocks execution (verified live) |
| `AGY_ALWAYS_PROCEED` | `toolPermission` is `always-proceed` | None; the adapter overrides it with `strict` |
| `AGY_MCP_PRESENT` | `~/.gemini/config/mcp_config.json` is not empty | None; MCP servers are disabled inside the adapter. Configure MCP in Claude Code instead |
| `AGY_CUSTOMIZATIONS_PRESENT` | Global Antigravity rules, skills, `GEMINI.md` or `AGENTS.md` exist | None; the adapter's agent ignores them. They can add tokens to plain `agy`, not to this adapter |
| Routed models available (`!`) | A routed model id is not listed by `agy models` for your account | Override the route with `CLAUDE_GEMINI_MODEL_<ROLE>` |

## Errors during a session

Claude Code shows `API Error: <status> <CODE>`. Codes marked "final" are returned once and not retried.

| Code | Meaning | What to do |
|---|---|---|
| `AGY_TIMEOUT` (final) | Gemini did not answer within the turn timeout | Switch to `sonnet` or `haiku` with `/model`, or raise `--gemini-timeout` |
| `CONTEXT_TOO_LARGE` (final) | A request that cannot be split exceeded the safe size | Run `/clear` or start a new session |
| `AGY_QUOTA` | Antigravity reported a quota or rate limit | Wait and retry; Claude Code retries with backoff |
| `AGY_AUTH_REQUIRED` (final) | Antigravity is not signed in or its login expired | Run `agy` in a terminal and sign in again |
| `AGY_NATIVE_ACTION` (final) | Gemini tried to run an Antigravity tool instead of proposing one | Retry; this should be rare. If it repeats, report it with the log line |
| `AGY_INVALID_RESULT` (final) | The Antigravity stream violated the expected protocol (wrong model, turn counter, conversation) | Retry; check `agy --version` against the tested version |
| `AGY_EMPTY_RESULT` (final) | Gemini returned an empty answer even after a repair turn | Retry or switch model |
| `AGY_INFERENCE_FAILED` | The `agy` process failed or exited | Retry once; look at the log line |
| `AGY_MODEL_NOT_ROUTED` (final) | The model id is not one of the four routes | Use `/model` and pick a Gemini route |
| `INVALID_MODEL_TOOL_CALL`, `INVALID_MODEL_ENVELOPE`, `TOOL_CHOICE_VIOLATION` (final) | Gemini proposed an unknown tool, invalid input, or ignored `tool_choice` even after a repair turn | Retry or rephrase; try `sonnet` |
| `INVALID_MODEL_JSON` (final) | Gemini answered with a malformed JSON envelope twice, even after the lenient reader and a repair turn (code with many quotes is the usual cause) | Retry, ask for smaller edits, or try `sonnet` |
| `OUTPUT_BUDGET_EXCEEDED`, `MISSING_MEASURED_USAGE` (final) | The answer exceeded `max_tokens`, or Antigravity reported no usage | Retry |
| `INFERENCE_BUSY` | More concurrent requests than `CLAUDE_GEMINI_MAX_CONCURRENT` (default 4) and the queue timed out | Retry, reduce parallel subagents, or raise `CLAUDE_GEMINI_MAX_CONCURRENT` |
| `INFERENCE_ABORTED` | You interrupted the request | Nothing to fix |
| `INVALID_TOOLS`, `UNSUPPORTED_TOOL_RESULT`, `UNSUPPORTED_CONTENT`, `INVALID_MESSAGE`, `MISSING_TOOL_RESULT`, `THINKING_UNSUPPORTED`, `STOP_SEQUENCES_UNSUPPORTED`, `INVALID_SAMPLING` (final) | The request had a structure or option the bridge does not accept (unknown fields, unknown block types and unfamiliar schema keywords are tolerated, so these are real structural problems) | Report it with the log line; start a new session as a workaround |
| `UNAUTHORIZED`, `HOST_DENIED`, `BROWSER_ORIGIN_DENIED` | Something other than the launched Claude Code called the local endpoint | Do not call the bridge directly |

## Common situations

**It worked yesterday and now every request fails.** A session keeps the code it started with, and a conversation can carry content from an older version. Exit and start `claude-gemini` again; use a new session if the old history keeps failing.

**Claude Code says the model "isn't recognized".** `[claude-code:unrecognized_model]` is a harmless notice: Claude Code does not know Gemini ids, and assumes a 1M-token context. The adapter still verifies the exact model on every answer.

**Claude Code shows "API Usage Billing" or a dollar cost.** Both are Claude Code interface state for a custom endpoint. The cost is a local estimate with an unknown basis, not a charge from Anthropic or Google.

**The model keeps answering the greeting instead of my task.** Old versions truncated long messages silently. Update, then start a new session.

**First turn is slow.** The first turn carries your whole Claude Code context. See [performance](performance.md#where-the-remaining-cost-is).

**It works in my terminal but not from a script or cron.** Make sure `PATH` or the `CLAUDE_GEMINI_*_BIN` variables point at both programs and that the account is signed in for that user.

**I want to see exactly what was sent.** The log records sizes and ids, deliberately not content. To inspect content, use Claude Code's own transcript under `~/.claude/projects/`.

## Reporting a problem

Open an issue with: the output of `claude-gemini --check --json`, the relevant lines of `bridge.jsonl` (they contain no prompt text), Claude Code and Antigravity CLI versions, and the steps to reproduce. For security issues, follow [SECURITY.md](../SECURITY.md) instead.
