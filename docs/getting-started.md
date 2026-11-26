# Getting started

This guide takes you from nothing to a working `claude-gemini` session. Budget about ten minutes, most of it installing the two programs the adapter connects.

## 1. Check the basics

```sh
sw_vers -productName      # macOS
node --version            # v22 or newer
```

Linux and Windows are not supported: isolation relies on macOS `sandbox-exec`.

## 2. Install Claude Code

Follow the [official instructions](https://docs.anthropic.com/en/docs/claude-code/overview) (for example `npm install -g @anthropic-ai/claude-code`), then confirm:

```sh
claude --version
```

You do **not** need to sign in to an Anthropic account to run Claude Code through this adapter; it talks to a local endpoint instead of Anthropic's API.

## 3. Install the Antigravity CLI and sign in

Install the CLI from [Google's guide](https://antigravity.google/docs/getting-started/#download-and-install), then start it once and complete the sign-in:

```sh
agy
```

Confirm that your account can list models:

```sh
agy models
```

You should see ids such as `gemini-4-neon-low`. The adapter reuses this login through the official CLI's own credential helper; it never reads or copies credentials.

## 4. Install the adapter

```sh
git clone https://github.com/roanalytics/claudecode-gemini-adapter.git
cd claudecode-gemini-adapter
npm link
```

`npm link` creates a global `claude-gemini` command that points at this checkout, so keep the folder in place. Without npm's global bin directory on your `PATH`, use a symlink instead:

```sh
mkdir -p ~/.local/bin
ln -sfn "$PWD/bin/claude-gemini.mjs" ~/.local/bin/claude-gemini
```

There is nothing else to install: the adapter has no runtime dependencies.

## 5. Verify

```sh
claude-gemini --check
```

Expected output on a healthy machine:

```text
✓ macOS with sandbox-exec — darwin
✓ Node.js 22 or newer — 22.x.x
✓ Claude Code found — /path/to/claude (2.1.x (Claude Code))
✓ Antigravity CLI (agy) found — /path/to/agy
✓ Antigravity signed in — 27 models available
✓ Antigravity profile — no conflicting settings
✓ Model routing — fable=gemini-4-neon-xhigh opus=gemini-4-neon-high sonnet=gemini-4-neon-low haiku=gemini-3.8-flash-low
✓ Request log — ~/Library/Logs/claudecode-gemini-adapter/bridge.jsonl

Ready. Run: claude-gemini
```

Each line is one requirement:

| Mark | Meaning |
|---|---|
| `✓` | Fine |
| `!` | A note that does not block you (for example Antigravity "always allow" entries or global customizations; see [troubleshooting](troubleshooting.md#profile-notes)) |
| `✗` | Blocks the adapter; the text after the dash says how to fix it |

Use `claude-gemini --check --json` for machine-readable output.

### Programs installed in unusual places

The adapter looks for `claude` and `agy` in `~/.local/bin`, then in every directory of your `PATH` (this covers npm global, Homebrew and nvm installs when your shell has them on `PATH`). If yours live elsewhere, say so explicitly:

```sh
export CLAUDE_GEMINI_CLAUDE_BIN="/full/path/to/claude"
export CLAUDE_GEMINI_AGY_BIN="/full/path/to/agy"
```

## 6. First run

```sh
claude-gemini
```

Ask something that needs a tool, for example "Read README.md and summarize it in two lines". You should see Claude Code ask for or use its `Read` tool as usual, with Gemini writing the answer. A warning such as `[claude-code:unrecognized_model]` is expected and harmless: Claude Code does not know Gemini model ids.

For a one-shot check without the interactive UI:

```sh
claude-gemini -p "Reply with OK" --output-format json
```

## Updating

```sh
cd claudecode-gemini-adapter
git pull
claude-gemini --check
```

A session that was already running keeps the old code. Exit it and start `claude-gemini` again.

## Uninstalling

```sh
npm unlink -g claudecode-gemini-adapter      # or: rm ~/.local/bin/claude-gemini
rm -rf ~/Library/Logs/claudecode-gemini-adapter
```

Then delete the cloned folder. The adapter writes nothing else outside temporary directories, which it removes on exit.

## Next steps

- [Usage](usage.md): headless runs, subagents, MCP, sessions, model tips
- [Configuration](configuration.md): flags and environment variables
- [Troubleshooting](troubleshooting.md): error codes and fixes
