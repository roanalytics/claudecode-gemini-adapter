# Security

This page describes what the adapter protects, how, and what it cannot protect. To report a vulnerability see [SECURITY.md](../SECURITY.md).

## Model of trust

| Party | Trust | Why |
|---|---|---|
| You and Claude Code | Trusted | Claude Code executes tools under your permission settings |
| The adapter | Trusted, small | Local code you can read: about 2,000 lines, no runtime dependencies |
| Gemini via Antigravity | **Untrusted proposer** | It can only return text or *proposed* tool calls; it never executes anything |
| Files, repositories, web pages Claude reads | Untrusted content | They can try to steer the model (prompt injection) |

The core guarantee: **Claude Code is the only tool executor.** Gemini's proposals are checked against the schemas Claude offered, then handed to Claude Code, which applies its normal permission prompts.

## Layers

1. **No native tools.** Every Antigravity process runs the `claude-bridge` agent with `tools: []`, no MCP servers, skills or plugins, in `plan` mode with `toolPermission: strict`.
2. **Per-session settings.** Each process receives `--settings` that sets `useG1Credits: false`, `modelProvider: ""`, `allowNonWorkspaceAccess: false`, `toolPermission: strict` and deny rules for `read_file`, `write_file`, `read_url`, `execute_url`, `command` and `mcp`. Deny rules win over any "always allow" entry in your Antigravity settings (verified live).
3. **macOS sandbox** (`sandbox-exec`). The process:
   - can execute only the `agy` binary and `/usr/bin/security` (Antigravity's native credential helper);
   - can write only inside its own temporary scratch directory;
   - cannot read the current directory, common credential locations (`~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.azure`, `~/.kube`, `~/.docker`, `~/.config/gh`, `~/.netrc`, `~/.npmrc`, `~/.pypirc`), Claude Code and Codex configuration, `~/Documents`, `~/Desktop`, `~/Downloads`, any `.env*` file, or extra paths from `CLAUDE_GEMINI_DENY_READ`.
   Network access stays allowed because `agy` must reach Google.
4. **Detection after the fact.** A stream that reports a native tool or subagent step is rejected (`AGY_NATIVE_ACTION`). This is a tripwire, not isolation; layers 1–3 are the isolation.
5. **Tool-call validation.** Names, JSON Schema types, required fields, `pattern`, `enum`, bounds and `tool_choice` are enforced before a proposal reaches Claude Code.
6. **Loopback only.** The bridge listens on `127.0.0.1` on an ephemeral port. Requests need a random 32-byte per-run token (delivered through Claude Code's `apiKeyHelper`, never written to the settings file), a matching `Host` header and no browser `Origin`.

## Credentials

The adapter never reads, copies, logs or exports Google credentials. `agy` authenticates through the credential helper it already uses; the sandbox only permits that helper to run. There is no `.env`, API key or Anthropic login anywhere in the flow. The adapter does read the non-secret Antigravity settings files to warn about risky configuration (`claude-gemini --check`).

Settings that touch billing or identity (`useG1Credits` enabled, a custom `modelProvider`) stop the launcher. "Always allow" entries, `always-proceed`, MCP servers and global customizations only produce notes, because the per-session settings, the tool-less agent and the sandbox neutralize them.

## What is logged

`~/Library/Logs/claudecode-gemini-adapter/bridge.jsonl` (mode 0600, rotated at 5 MB) holds timestamps, model, status, durations, token counts, event sizes and error codes. It never holds prompts, answers, file contents or credentials. Error responses to Claude Code carry stable codes and fixed hints, never provider text. Stderr from `agy` is reduced to filtered error lines and kept in memory only.

## What the adapter cannot protect

- **Data leaves your machine for Google.** Whatever Claude Code puts in the conversation (file contents it read, command output) is sent to Gemini through your Antigravity account and is subject to Google's terms and data handling.
- **Prompt injection still exists.** A malicious file can influence what Gemini proposes. Claude Code's permission prompts are your defense; avoid `bypassPermissions` on untrusted repositories.
- **`sandbox-exec` is deprecated by Apple.** It works today and is what the Antigravity CLI's own sandbox mode relies on, but it is not a hardened virtual machine.
- **Local malware** running as your user can read the per-run token from the process environment of Claude Code while a session runs.
- **Account terms.** Using a signed-in CLI behind another coding agent may be restricted by the provider's terms; see the notice in the [README](../README.md).

## Reviewing the isolation yourself

- Sandbox profile: `src/agy-process.mjs` (`createAgyInvoker`, `DEFAULT_DENY_READ`).
- Agent definition: `src/agy-agent.mjs`.
- Provider checks: `npm test` includes tests that assert the generated sandbox rules, and `npm run canary:primary` proves a protected file cannot be read by the provider.
