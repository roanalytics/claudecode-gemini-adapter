import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export const DEFAULT_LOG = path.join(homedir(), 'Library/Logs/claudecode-gemini-adapter/bridge.jsonl');

// One JSON line per bridge request or session event. Never receives prompt text.
export function createLogger({ file = DEFAULT_LOG, maxBytes = 5_000_000, enabled = process.env.CLAUDE_GEMINI_LOG !== '0' } = {}) {
  if (!enabled) return () => {};
  let ready = false;
  return (entry) => {
    try {
      if (!ready) { mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); ready = true; }
      try { if (statSync(file).size > maxBytes) renameSync(file, `${file}.1`); } catch {}
      appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, ...entry }) + '\n', { mode: 0o600 });
    } catch {}
  };
}
