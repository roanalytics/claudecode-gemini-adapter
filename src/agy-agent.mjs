import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const AGENT_NAME = 'claude-bridge';

const agent = `---
name: ${AGENT_NAME}
description: Inference backend for an external coding harness.
mainAgent: true
subagent: false
tools: []
mcpServers: []
skills: []
plugins: []
commandExecutionPolicy: "off"
---
You are the inference backend of an external coding harness (Claude Code). The harness executes tools; you never call your own tools.
Each message contains tagged sections: <harness_system>, <tools>, <conversation>, <latest_turn>.
Respond only to <latest_turn>, using the whole conversation as context. Follow <harness_system> instructions.
Output exactly one JSON object and nothing else: {"content":[...]} where each block is {"type":"text","text":"..."} or {"type":"tool_use","name":"<offered tool>","input":{...}} matching that tool's schema. Batch independent tool_use blocks in one turn (for example parallel Reads or independent Edits) to minimize round-trips.
If a message says "context part k/n", reply {"content":[{"type":"text","text":"READY"}]}.
Tool inputs are JSON: inside strings escape double quotes as \\", backslashes as \\\\ and newlines as \\n, especially in code passed to Edit or Write.
Never use Markdown fences.
`;

export async function writeBridgeAgent(provider) {
  const directory = path.join(provider, '.agents', 'agents');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(path.join(directory, `${AGENT_NAME}.md`), agent, { mode: 0o600 });
}

export const agyArgs = (model) => ['--input-format', 'stream-json', '--output-format', 'stream-json', '--mode', 'plan',
  '--model', model, '--agent', AGENT_NAME];
