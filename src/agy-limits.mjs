// agy silently truncates a single `user` event above ~192 K characters (bench-live, 2026-11-25:
// 191,250 intact, 194,687 truncated, with the notice injected into the text).
// Stay well below the measured cliff; see docs/research/findings.md.
export const MEASURED_TRUNCATION_CHARS = 192_000;
export const SAFE_EVENT_CHARS = Math.floor(0.8 * MEASURED_TRUNCATION_CHARS);

export const DEFAULT_MAX_CONCURRENT = 4;
export const DEFAULT_MAX_SESSIONS = 6;
export const MAX_CONCURRENT_LIMIT = 16;
export const MAX_SESSIONS_LIMIT = 32;

function parseBoundedInt(raw, min, max, code) {
  const text = String(raw).trim();
  if (!/^\d+$/.test(text)) throw Error(code);
  const value = Number(text);
  if (!Number.isInteger(value) || value < min || value > max) throw Error(code);
  return value;
}

export function resolveConcurrency(env = process.env) {
  const rawConcurrent = env.CLAUDE_GEMINI_MAX_CONCURRENT;
  const maxConcurrent = rawConcurrent !== undefined && String(rawConcurrent).trim() !== ''
    ? parseBoundedInt(rawConcurrent, 1, MAX_CONCURRENT_LIMIT, 'INVALID_MAX_CONCURRENT')
    : DEFAULT_MAX_CONCURRENT;
  const rawSessions = env.CLAUDE_GEMINI_MAX_SESSIONS;
  const maxSessions = rawSessions !== undefined && String(rawSessions).trim() !== ''
    ? parseBoundedInt(rawSessions, maxConcurrent, MAX_SESSIONS_LIMIT, 'INVALID_MAX_SESSIONS')
    : Math.min(MAX_SESSIONS_LIMIT, Math.max(DEFAULT_MAX_SESSIONS, maxConcurrent + 2));
  return { maxConcurrent, maxSessions };
}
