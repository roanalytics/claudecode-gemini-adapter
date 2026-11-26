# Changelog

## 0.2.0 — 2026-11-26

First public release under the name **claudecode-gemini-adapter** (previously an internal prototype). The command stays `claude-gemini`.

### Added
- **Persistent sessions.** One sandboxed Antigravity process per Claude conversation or subagent; after the first turn only new messages are sent.
- **`claude-bridge` agent** with no tools, MCP servers, skills or plugins: Antigravity's own baseline drops from 12,929 to 5,097 input tokens per call.
- **Lean profile** (`config/lean-filters.json`, `--full-context`, `CLAUDE_GEMINI_LEAN_FILTERS`) and per-session de-duplication of repeated system paragraphs.
- **Doctor** (`claude-gemini --check [--json]`): platform, Node, Claude Code, Antigravity CLI, sign-in, profile, model routing, log path.
- **Portability:** binary discovery (`~/.local/bin`, `PATH`, `CLAUDE_GEMINI_CLAUDE_BIN` / `CLAUDE_GEMINI_AGY_BIN`), generic sandbox deny list plus `CLAUDE_GEMINI_DENY_READ`, route overrides (`CLAUDE_GEMINI_MODEL_*`), readable startup errors.
- **Request log** (`~/Library/Logs/claudecode-gemini-adapter/bridge.jsonl`, no prompt text, tagged with `pid` for multi-instance debugging), request queue, configurable concurrency (`CLAUDE_GEMINI_MAX_CONCURRENT`, `CLAUDE_GEMINI_MAX_SESSIONS`), local `count_tokens` estimate, `--gemini-timeout`.
- Live canaries and checks: `canary:sessions`, `canary:features`, `canary:stress` (multi-instance parallel stress test), `smoke:sessions`, `smoke:errors`, `bench:live`, `verify:install`; fixtures for a persistent fake `agy` and an MCP server with 150 tools.
- Documentation set: getting started, usage, configuration, architecture, security, performance, compatibility, testing & regression, troubleshooting, contributing.

### Changed
- **Failures that cannot succeed return once.** They use HTTP 502 with `x-should-retry: false` because Claude Code retries 400/401/403/404/422 regardless of the header (400 cost 4 requests, 401/403 cost 9).
- The Antigravity timeout is detected (`AGY_TIMEOUT`) instead of surfacing as an invalid result; the per-turn timeout defaults to 600 s and Claude Code's API timeout follows it.
- Messages are rendered as tagged text and capped at 153,600 characters; larger first turns are split. Antigravity silently truncates above about 192,000.
- `sonnet` routes to `gemini-4-neon-low` (matched 16/16 quality on the 3-module benchmark at 1.8× the speed of `neon-medium`) and `haiku` routes to `gemini-3.8-flash-low` (about 2 s per follow-up turn).
- Antigravity settings that cannot weaken isolation ("always allow" entries, `always-proceed`, MCP servers, global customizations) are notes, not errors. Only billing/identity settings (`useG1Credits`, `modelProvider`) stop the launcher.
- Answers are parsed tolerantly (fences, noise, duplicates, common tool-call shapes); invalid or empty answers get one repair turn.

### Fixed
- A Gemini answer with unescaped quotes in code (for example in an `Edit` input) used to be shown as raw JSON and nothing ran. A lenient JSON reader now repairs the usual mistakes, one repair turn follows if that fails, and a broken envelope is never displayed as text (`INVALID_MODEL_JSON` after a second failure).
- Token usage in persistent sessions was inflated because Antigravity reports output and cache-read tokens as session running totals; per-request usage is now computed from the differences.
- Claude Code's plan mode failed with `UNSUPPORTED_REQUEST_FIELD` (it sends a `safeguards` field). Unknown request fields, unknown content blocks, server tools (web search) and unfamiliar JSON Schema keywords are now tolerated and recorded in the log instead of failing every request.
- Images and documents returned by tools (for example Claude's `Read` on a PNG) no longer poison the rest of the conversation: they are accepted and rendered as placeholders.
- Requests with more than 128 tools that are not deferred are accepted.
- Request validation errors no longer trigger retry storms.

### Removed
- The prototype adapter built on the retired Gemini CLI (`runtime/`, login helper, legacy transport and vision code) and the MCP delegation experiment. They remain in git history under the tag `legacy-gemini-cli`.

## 0.1.0

Initial prototype: Anthropic Messages endpoint in front of a one-shot Antigravity subprocess per request.
