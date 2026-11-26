# Security policy

## Reporting a vulnerability

Please report security problems **privately**, not in a public issue. Use GitHub's "Report a vulnerability" button on the repository's Security tab (private vulnerability reporting). Include:

- what you found and why it matters,
- steps to reproduce, with the output of `claude-gemini --check --json`,
- affected versions.

You should get an acknowledgement within a few days. Fixes are released as a new version with a note in the [changelog](CHANGELOG.md), crediting you if you wish.

## Scope

In scope: the isolation of the Antigravity subprocess (sandbox profile, agent definition, per-session settings), the local loopback endpoint and its authentication, handling of tool calls proposed by the model, and anything that could expose credentials or file contents through the adapter or its log.

Out of scope: vulnerabilities in Claude Code, the Antigravity CLI or Gemini themselves (report those to their vendors), prompt injection that merely changes what the model proposes while Claude Code's permission prompts remain in effect, and use that violates your account's terms.

The design and its limits are described in [docs/security.md](docs/security.md).
