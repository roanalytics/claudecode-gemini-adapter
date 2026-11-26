import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const CODES = { agy: 'AGY_NOT_FOUND', claude: 'CLAUDE_NOT_FOUND' };

// An explicit environment override must be valid; otherwise ~/.local/bin and every PATH entry are searched.
export function resolveBinary(name, envVar, { env = process.env, home = homedir() } = {}) {
  const explicit = env[envVar];
  const candidates = explicit ? [explicit] : [path.join(home, '.local/bin', name),
    ...(env.PATH ?? '').split(':').filter(Boolean).map((directory) => path.join(directory, name))];
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return realpathSync(candidate);
    } catch {}
  }
  throw Error(CODES[name] ?? 'BINARY_NOT_FOUND');
}
