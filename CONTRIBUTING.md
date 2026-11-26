# Contributing

Thanks for helping. This is a small, dependency-free Node.js project (ES modules, Node 22 or newer, macOS).

## Setup

```sh
git clone https://github.com/roanalytics/claudecode-gemini-adapter.git
cd claudecode-gemini-adapter
npm test                 # unit tests, no account needed
```

There is nothing to `npm install`: the package has no dependencies.

## Layout

| Path | Contents |
|---|---|
| `bin/claude-gemini.mjs` | Launcher and doctor |
| `src/` | The adapter; see [architecture](docs/architecture.md) for a file-by-file map |
| `config/lean-filters.json` | Default lean-profile rules |
| `test/` | Unit tests (`node:test`) and synthetic fixtures (`test/fixtures`: a fake `agy`, a fake persistent `agy`, a fake MCP server) |
| `scripts/` | Smoke tests, live canaries, benchmark, clean-install verification |
| `docs/` | Documentation |

## Checks

| Command | Needs | What it proves |
|---|---|---|
| `npm test` | nothing (needs a loopback socket) | Unit tests |
| `npm run smoke`, `smoke:sessions`, `smoke:errors`, `smoke:models` | Claude Code installed | Real Claude Code against simulated providers: tool loop, persistent sessions, one request per failure, role routing |
| `npm run verify:install` | Claude Code; Antigravity CLI for the live part | Clean copy in a path with spaces and accents: syntax, tests, doctor under different layouts, a real prompt, Node 22 |
| `npm run canary:primary`, `canary:sessions`, `canary:features`, `canary:stress`, `bench:live` | Claude Code and a signed-in Antigravity CLI | Live behavior, 29-feature matrix, multi-instance parallel stress test, and benchmarks against Gemini |

See [docs/testing.md](docs/testing.md) for the complete replicable regression guide and checklist. Run live checks outside restrictive sandboxes: they need the network and the keychain helper. Before opening a pull request run `npm test`, `npm run smoke:sessions` and `npm run smoke:errors`; if you touched session handling, rendering, validation or isolation, also run `npm run canary:sessions`.

## Rules of thumb

- **Tests with every change.** Behavior changes need a unit test; protocol or session changes usually need a fixture scenario too.
- **Synthetic data only.** Never put real prompts, paths, tokens or transcripts in tests, fixtures or logs. Tests use temporary directories and fake binaries.
- **No runtime dependencies.** Prefer Node's standard library.
- **No machine-specific paths.** Use `homedir()`, `resolveBinary()` and temporary directories.
- **Fail closed, say why.** Error codes are part of the interface: add a hint in `src/bridge.mjs` and a row in [troubleshooting](docs/troubleshooting.md) for any new code that users can see.
- **Never read credentials.** The adapter must not open credential stores or print tokens.
- **Keep isolation changes conservative.** Any change to the sandbox profile, agent definition or session settings needs a note in the pull request explaining why it cannot weaken isolation.
- **Measure before optimizing.** Add the measurement to [performance](docs/performance.md).

## Common changes

**Add a lean rule.** Edit `config/lean-filters.json` (format in [configuration](docs/configuration.md#writing-your-own-rules)) and add a case to `test/agy-render.test.mjs` with synthetic text. Rules must never remove user-authored instructions such as `CLAUDE.md`.

**Change a default model route.** Edit `AGY_ALIASES` in `src/agy-model-routes.mjs`, update `test/agy-model-routes.test.mjs`, the tables in the README and [configuration](docs/configuration.md#models), and run `npm run smoke:models`.

**Handle a new Claude Code content block.** Accept it in `validateRequest` only if it is safe to represent, render a placeholder in `src/agy-render.mjs`, and add a test in `test/bridge.test.mjs` and `test/agy-render.test.mjs`.

## Pull requests

Keep them focused, describe the problem and how you verified it, and list the commands you ran. By contributing you agree that your work is released under the MIT license.
