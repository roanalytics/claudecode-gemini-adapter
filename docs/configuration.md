# Configuration

Everything is configured with command-line flags and environment variables. There is no configuration file to edit. Put exports in your shell profile to make them permanent.

## Flags

| Flag | Default | Effect |
|---|---|---|
| `--gemini-model fable\|opus\|sonnet\|haiku` | `sonnet` | Route to start with |
| `--gemini-timeout <seconds>` | `600` | Per-turn Gemini timeout, an integer from 10 to 3600 |
| `--full-context` | off | Send every Claude Code memory/hook block (disables the lean profile) |
| `--check` | | Doctor: verify platform, binaries, sign-in, profile and routing, then exit (`0` ready, `1` problem) |
| `--json` | | With `--check`, print the doctor report as JSON |
| `--help` | | Flags, environment variables and log path |

Everything else is passed to Claude Code unchanged. A `--` is not needed.

## Environment variables

| Variable | Default | Effect |
|---|---|---|
| `CLAUDE_GEMINI_TIMEOUT_S` | `600` | Same as `--gemini-timeout` (the flag wins) |
| `CLAUDE_GEMINI_MAX_CONCURRENT` | `4` | Maximum simultaneous model requests per `claude-gemini` instance (`1`–`16`) |
| `CLAUDE_GEMINI_MAX_SESSIONS` | `6` (or `maxConcurrent + 2`, capped at `32`) | Maximum persistent `agy` processes kept in the pool per instance (`>= maxConcurrent` up to `32`) |
| `CLAUDE_GEMINI_SESSIONS` | on | `0` disables persistent sessions: every request starts a fresh Antigravity process with the full context |
| `CLAUDE_GEMINI_LOG` | on | `0` disables the request log |
| `CLAUDE_GEMINI_MODEL_FABLE` / `_OPUS` / `_SONNET` / `_HAIKU` | see below | Route a role to another `gemini-*` id |
| `CLAUDE_GEMINI_CLAUDE_BIN` | search | Absolute path to Claude Code |
| `CLAUDE_GEMINI_AGY_BIN` | search | Absolute path to the Antigravity CLI |
| `CLAUDE_GEMINI_DENY_READ` | none | Extra directories, separated by `:`, that the Gemini process may never read (`~/` is expanded; relative entries are ignored) |
| `CLAUDE_GEMINI_LEAN_FILTERS` | built in | Path to a JSON file that replaces the default lean-profile rules |

Binary search order when no override is set: `~/.local/bin/<name>`, then each `PATH` directory. An explicit override is never silently replaced: if the path is wrong the launcher says so.

## Models

Defaults:

| Role | Route |
|---|---|
| `fable` | `gemini-4-neon-xhigh` |
| `opus` | `gemini-4-neon-high` |
| `sonnet` | `gemini-4-neon-low` |
| `haiku` | `gemini-3.8-flash-low` |

Override one or more:

```sh
export CLAUDE_GEMINI_MODEL_SONNET=gemini-4-carbon-medium
export CLAUDE_GEMINI_MODEL_HAIKU=gemini-4-hydrogen-low
```

Rules:

- The value must match `gemini-<name>`. Anything else stops the launcher with `INVALID_MODEL_OVERRIDE`.
- Run `agy models` to see the ids your account offers. `claude-gemini --check` warns (`!`) when a routed id is not in that list.
- Model ids the router does not know are rejected (`AGY_MODEL_NOT_ROUTED`); there is no silent fallback. If Antigravity answers with a different model than requested, the answer is rejected.

## Lean profile

Claude Code resends its whole context every turn, and plugins add large blocks of their own. The lean profile removes blocks that match rules in [`config/lean-filters.json`](../config/lean-filters.json) before the text reaches Gemini. It also sends a repeated system paragraph only once per session and compacts tool schemas (`$schema` metadata is stripped and nested property descriptions above 200 characters are trimmed, while all structural constraints and full request/tool-call validation remain intact). Your `CLAUDE.md`, skills list and top-level tool descriptions are never filtered.

Default rules (known memory plugins; edit or replace them for your own setup):

| Label | Matches |
|---|---|
| `claude-mem session memory` | The claude-mem session-start dump, from `SessionStart:… ## Memory from Previous Sessions` up to the next `# Environment` heading |
| `engram first-action nudge` | The paragraph that tells the model to run ToolSearch for engram tools first |
| `engram follow-up nudge` | The paragraph that tells the model to call `mem_context` |
| `memory save reminder` | "MEMORY REMINDER: It's been over N minutes since your last save" |

Each omitted block is replaced by `[omitted by lean profile: <label>]`, so the model knows something was removed. Turn the whole profile off with `--full-context`.

### Writing your own rules

Set `CLAUDE_GEMINI_LEAN_FILTERS=/path/to/rules.json`. The file replaces the defaults and must be a JSON array of objects:

| Field | Required | Meaning |
|---|---|---|
| `label` | yes | Name shown in the placeholder and in the log |
| `paragraph` | one of `paragraph` / `start` | Regular expression; every paragraph (blocks separated by a blank line) that matches is replaced |
| `start` | one of `paragraph` / `start` | Regular expression marking where a removable range begins |
| `end` | no | With `start`: regular expression marking where the range ends (the end marker is kept). Without it the range runs to the end of the text |
| `minChars` | no | Only remove ranges or paragraphs at least this long |

Patterns use JavaScript syntax and the multiline flag, so `^` matches at any line start. Example that hides a noisy hook:

```json
[
  { "label": "ticket digest", "paragraph": "^Daily ticket digest:" },
  { "label": "team wiki dump", "start": "^## Wiki context", "end": "^## Task", "minChars": 2000 }
]
```

An invalid file stops the launcher with `INVALID_LEAN_FILTERS`. The log's `meta.omitted` shows, per label, how many characters each rule removed.

## Isolation settings

By default the Gemini process cannot read: the current directory, `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.azure`, `~/.kube`, `~/.docker`, `~/.config/gh`, `~/.netrc`, `~/.npmrc`, `~/.pypirc`, `~/.claude`, `~/.codex`, `~/Documents`, `~/Desktop`, `~/Downloads`, and any `.env*` file. Add more with `CLAUDE_GEMINI_DENY_READ`:

```sh
export CLAUDE_GEMINI_DENY_READ="$HOME/Projects:$HOME/Notes"
```

This is defense in depth: the model never has file tools in the first place ([security](security.md)).

## Concurrency and timeouts

| Setting | Value |
|---|---|
| Simultaneous model requests | `4` by default (`CLAUDE_GEMINI_MAX_CONCURRENT`, `1`–`16`) |
| Queue for extra requests | up to 32 requests, each waiting at most 120 s, then `429` |
| Persistent sessions | `6` by default (`CLAUDE_GEMINI_MAX_SESSIONS`, up to `32`, auto-scales to `maxConcurrent + 2` when unset); idle ones close after 20 minutes; least recently used are evicted first |
| Per-turn timeout | 600 s (`--gemini-timeout`); Claude Code's own API timeout is set to this plus 60 s |
| Largest event sent to Antigravity | 153,600 characters |

## Request log

Default path: `~/Library/Logs/claudecode-gemini-adapter/bridge.jsonl` (mode 0600; rotated at 5 MB to `bridge.jsonl.1`). One JSON object per line.

| Field | Meaning |
|---|---|
| `ts`, `pid`, `id` | Timestamp, `claude-gemini` launcher process ID (useful when running several terminals at once), and short request id |
| `model` | Gemini model that answered |
| `stream` | Whether Claude Code asked for streaming |
| `status` | HTTP status returned to Claude Code |
| `ms` | Total time in milliseconds |
| `usage` | `input_tokens` and `output_tokens` reported by Antigravity |
| `error` | Stable error code when the request failed ([troubleshooting](troubleshooting.md)) |
| `meta.session` | `new`, `reused` or `stateless` |
| `meta.events` | Size in characters of each event sent to Antigravity |
| `meta.parts` | Number of events (more than 1 means a split first turn) |
| `meta.omitted` | Characters removed per lean rule |
| `meta.ignoredFields` | Names of unknown request fields that were dropped (names only) |
| `meta.ignoredTools` | Names of server tools that were removed from the tool list |
| `meta.cacheRead` | Cached tokens Antigravity reported |
| `event` | `session_closed` / `session_retry` entries for session lifecycle |

`npm run log` (from the repository) follows the file. It never contains prompt text, file contents or credentials.
