# Research notes: Gemini as the model behind Claude Code

How the approach was validated. For day-to-day documentation start at the [README](../../README.md); measurements of the current design are in [performance](../performance.md).

**Scope of testing:** macOS arm64; Claude Code 2.1.332; Antigravity CLI (`agy`) 1.5.17; November 2026. Results come from one account and one machine.

## The idea

An [Anthropic-compatible local endpoint](https://docs.ollama.com/integrations/claude-code) shows the boundary that makes this possible: Claude Code stays in charge of tools while the model behind it changes. Antigravity exposes a **headless agent**, not an Anthropic Messages server, so this project supplies the missing interface:

1. A launcher points Claude Code at a per-run loopback endpoint. The local credential is neither a Google token nor an Anthropic credential.
2. The bridge accepts a validated Messages request and passes the conversation and the offered tool schemas, as text, to a sandboxed Antigravity subprocess.
3. The provider proposes text or a tool call; the protocol layer validates it; **Claude executes the tool** and returns the result on the next turn.

## What was established

| Path tested | Result | What it shows |
|---|---|---|
| Standalone `agy -p`, existing sign-in | Single turn answered; six lean-profile trials succeeded | Live headless inference without Claude Code |
| Claude Code → adapter → simulated `agy` | Two model requests; one real `Read` executed by Claude and replayed | The tool loop and routing work without an Anthropic subscription |
| Claude Code → adapter → authenticated Gemini (short canary) | Two live turns, one real `Read`, exact replay, provider read denial proven | Gemini is the primary model behind Claude's tool loop |
| Same, long ledger task | Seven live turns, six reads, exact reconciliation of 96 randomized signed entries | Multi-document work completes with the expected result |
| Interactive session | Normal UI, `/model` switching, `/context`, slash commands and a live MCP call worked | The normal Claude Code experience is preserved |
| Subagents and resume | A general-purpose subagent completed; a second process resumed a session and recalled a random token | Gemini serves parent, subagent and resumed sessions |
| Complex harness canary | Ten tool calls (`Write`, `Edit`, `Read`, `Glob`, `Bash`, two parallel `Agent` calls), exact file side effects | Claude owns orchestration and side effects; Gemini supplies inference |
| All four roles as primary, plus role separation | Each role answered; a top-route parent launched two medium-route children | All four routes work, and role pins assign subagents automatically |
| Standalone `agy acp` | Two PNGs identified; sessions reloaded after restart | Antigravity itself supports vision and session loading (not used by this adapter's route) |

The current design's live results (persistent sessions, feature matrix) are in [performance](../performance.md) and [Claude Code compatibility](../claude-code-compatibility.md).

## Model routes and why

Roles use Claude Code's [per-role model pins](https://code.claude.com/docs/en/model-config), scoped to the child session. `agy models` listed every routed id at test time. Unknown ids and provider-side substitutions are rejected.

| Role | Gemini id | Basis |
|---|---|---|
| Fable | `gemini-4-neon-xhigh` | [Fable 5.2](https://artificialanalysis.ai/models/claude-fable-5-2) scored 62 at High and 65 at Max on the Artificial Analysis Intelligence Index; [Neon](https://artificialanalysis.ai/models/gemini-4-neon) scored 62 at Xhigh |
| Opus | `gemini-4-neon-high` | [Opus 5.5](https://artificialanalysis.ai/models/claude-opus-5-5) scored 59 at Max; Neon High scored 60 |
| Sonnet | `gemini-4-neon-medium` | [Sonnet 5.5](https://artificialanalysis.ai/models/claude-sonnet-5-5) scored 55 at Max; Neon Medium scored 55. [Carbon Medium](https://artificialanalysis.ai/models/gemini-4-carbon) scored 58 but took about 26 minutes per index task against 8.7 for Neon Medium |
| Haiku | `gemini-3.8-flash-low` | Chosen on measured speed (about 2 s per follow-up turn, no reasoning tokens). The earlier choice, `gemini-4-hydrogen-low` ([Hydrogen](https://artificialanalysis.ai/models/gemini-4-hydrogen) scored 27 at Low against 25 for [Haiku 5.5](https://artificialanalysis.ai/models/claude-haiku-5-5) at Medium), remains available through `CLAUDE_GEMINI_MODEL_HAIKU` |

These are role assignments, not quality guarantees. Benchmark minutes are not local latency, and scores do not establish image accuracy, long-task reliability or quota behavior. Argon models were not used because the [Antigravity model catalog](https://antigravity.google/docs/models/) scheduled their removal for November 30, 2026.

## Antigravity baseline context

A blank custom agent on Neon Low in plan mode used **4,876 input tokens** against 12,147 for the default agent (six fresh trials; the dedicated `claude-bridge` agent measured 5,097 on Neon Medium). The CLI still advertised about 60 tools in its `init` event even with `tools: []`, so the profile is not a tool-free runtime; the isolation comes from denied permissions and the sandbox. The CLI rejected an explicit `--mode default`; the adapter pins `plan`.

## Authentication and isolation findings

- An earlier prototype built on the retired Gemini CLI hit startup problems (root-ownership warnings, `EPERM` on registry and trust paths) and, after browser sign-in, rejection by the service for individual accounts before inference. It was retired and is kept in git history under the tag `legacy-gemini-cli`.
- The official Antigravity CLI signs in normally. Its native credential helper must be allowed to run inside the sandbox: permitting only the exact `agy` executable and `/usr/bin/security` restored authentication without reading, copying or exporting credential values, while workspace and sensitive-path reads, native tools, unrelated executables and out-of-scratch writes stay denied.
- Google's [headless guide](https://antigravity.google/docs/cli/headless/) describes reusing a cached sign-in. A [forum clarification](https://discuss.ai.google.dev/t/clarification-on-consumer-plan-policy-for-invoking-official-agy-via-local-subprocess/189905/2) distinguishes direct scripts and CI from embedding the signed-in CLI behind another coding agent. AI Studio and Gemini Enterprise are separate integration paths and were not tested here.

## Limits

- Images and documents are not forwarded to Gemini on the primary route.
- No Anthropic prompt caching, extended thinking or native provider streaming; answers are returned whole.
- Quality, latency and quota behavior depend on your account, model and load.
- Only Claude Code 2.1.332 and Antigravity CLI 1.5.17 were tested; newer versions may change behavior. `claude-gemini --check` shows what you run.
