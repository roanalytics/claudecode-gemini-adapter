# Usage

`claude-gemini` is Claude Code with Gemini behind it. Anything you do in Claude Code works the same way; this page covers what is different and how to get good results.

## Starting a session

| Goal | Command |
|---|---|
| Interactive session | `claude-gemini` |
| Start with another route | `claude-gemini --gemini-model fable` (`fable`, `opus`, `sonnet` or `haiku`) |
| One headless prompt | `claude-gemini -p "Explain this repository"` |
| Machine-readable result | `claude-gemini -p "Reply with OK" --output-format json` |
| Streaming JSON events | `claude-gemini -p "..." --output-format stream-json --verbose` |
| Longer per-turn timeout | `claude-gemini --gemini-timeout 900` |
| Verify the installation | `claude-gemini --check` |

Arguments that the adapter does not recognise (`-p`, `--permission-mode`, `--allowedTools`, `--resume`, ...) are passed straight to Claude Code. The adapter's own flags are listed in [configuration](configuration.md).

## Choosing a model

Claude Code's four model roles are mapped to Gemini routes:

| Role | Route | Typical turn | Use it for |
|---|---|---|---|
| `sonnet` (default) | `gemini-4-neon-low` | 2–8 s | Everyday coding, tool loops, subagents |
| `opus` | `gemini-4-neon-high` | 5–20 s | Planning and review |
| `fable` | `gemini-4-neon-xhigh` | 20–60 s | Hardest problems; spends thousands of reasoning tokens even for simple steps |
| `haiku` | `gemini-3.8-flash-low` | 1–5 s | Quick, narrow tasks and Claude Code's background requests |

Switch with `/model` inside a session. Replace any route with an environment variable ([configuration](configuration.md#models)). List the ids your account can use with `agy models`.

Guidance from measurements:

- Prefer `sonnet`. `fable` took 39 s and about 3,700 thinking tokens just to propose reading one file.
- `haiku` is fast and fine for reading and shell steps, but in a two-file write task it put two lines in the wrong order in two of two runs. Prefer `sonnet` whenever exact edits matter.
- Subagents launched by Claude Code use the route Claude assigns them; under a `fable` parent the built-in general-purpose subagents run on the `sonnet` route.

## Tools, permissions and MCP

Claude Code executes `Read`, `Write`, `Edit`, `Glob`, `Grep`, `Bash`, `WebFetch`, `Agent` and every other tool exactly as usual, under your normal permission rules. Gemini only **proposes** tool calls; the adapter checks each proposal against the schema Claude offered before handing it over.

- **Permissions:** unchanged. Use `--permission-mode`, `/permissions` and your settings as you normally would. Be careful with `bypassPermissions` on code you do not trust: the model's proposals can be influenced by file contents.
- **MCP servers:** configure them in Claude Code, not in Antigravity. With Claude's Tool Search the schemas load on demand, so even servers with hundreds of tools stay cheap. A test with 150 tools works ([compatibility](claude-code-compatibility.md)).
- **Skills, hooks, slash commands, output styles:** keep working. Hook output appears in the conversation like any other context.

## Subagents

Ask for them as usual:

```sh
claude-gemini -p "Launch two general-purpose subagents in parallel, one per directory, and summarize both"
```

Each subagent gets its own persistent Gemini session. Up to four requests run at once by default; extra requests wait in a short queue instead of failing. You can also open multiple independent `claude-gemini` terminals in parallel — each uses its own ephemeral loopback port, token and temporary sandbox directory. To raise per-instance limits for heavy subagent swarms, set `CLAUDE_GEMINI_MAX_CONCURRENT` and `CLAUDE_GEMINI_MAX_SESSIONS` ([configuration](configuration.md#concurrency-and-timeouts)).

## Sessions and resuming

```sh
SESSION_ID=$(uuidgen)
claude-gemini -p "Remember the token BLUE-42" --session-id "$SESSION_ID"
claude-gemini -p "What was the token?" --resume "$SESSION_ID"
```

Resume works because Claude Code stores the conversation; on the next turn the adapter rebuilds the context for Gemini. Do not combine with `--no-session-persistence`.

## Large contexts and long sessions

- The first turn of a conversation carries the whole context (Claude's instructions, tool schemas, your global `CLAUDE.md`, hooks). With a heavy profile that can be 200 KB, sent in two parts. Every later turn sends only what is new.
- A very large `CLAUDE.md`, many memory plugins or many always-loaded MCP servers make that first turn slower and more expensive. Trim them if first-turn cost matters.
- The lean profile (on by default) removes known noise from memory plugins; `--full-context` turns it off ([configuration](configuration.md#lean-profile)).
- **Do not run `/compact` on a session that is already huge.** The summary request is as large as the history. Use `/clear` or start a new session.
- Images and PDFs read by Claude Code are not forwarded to Gemini; the model sees a placeholder.

## Seeing what happened

```sh
npm run log        # from the repository: follows ~/Library/Logs/claudecode-gemini-adapter/bridge.jsonl
```

One JSON line per request: model, whether the session was new or reused, event sizes in characters, token usage, error code. Prompts and file contents are never written ([configuration](configuration.md#request-log)).

## Good habits

1. Run `claude-gemini --check` after upgrading Claude Code or the Antigravity CLI.
2. Restart sessions after updating the adapter.
3. Keep `sonnet` for edits, `haiku` for quick questions, `fable` only when needed.
4. When something fails, read the error code; [troubleshooting](troubleshooting.md) lists every one.
