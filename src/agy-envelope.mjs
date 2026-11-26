const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// Collect every balanced top-level {...} span (string-aware) from free-form model output.
function objectSpans(text) {
  const spans = [];
  let depth = 0, start = -1, inString = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"' && depth > 0) inString = true;
    else if (ch === '{') { if (depth++ === 0) start = i; }
    else if (ch === '}' && depth > 0 && --depth === 0) spans.push(text.slice(start, i + 1));
  }
  return spans;
}

const STRUCTURAL_AFTER_CLOSER = /^\s*([,}\]`]|$)/;

// Lenient JSON reader for model output with the usual mistakes: unescaped double quotes and raw newlines inside
// strings (typically code passed to Edit or Write), invalid escapes such as \' or \$, and trailing commas.
// A double quote inside a string only ends it when what follows is structurally plausible for the current container.
export function looseJsonParse(text) {
  const n = text.length;
  const stack = [];
  let out = '', inString = false, isKey = false, lastSignificant = '';
  const skip = (from) => { let j = from; while (j < n && /\s/.test(text[j])) j++; return j; };
  for (let i = 0; i < n; i++) {
    const ch = text[i];
    if (!inString) {
      if (ch === '"') {
        inString = true;
        isKey = stack.at(-1) === '{' && (lastSignificant === '{' || lastSignificant === ',');
        out += ch; lastSignificant = ch;
      } else if (ch === ',') {
        const next = text[skip(i + 1)];
        if (next === '}' || next === ']') continue; // trailing comma
        out += ch; lastSignificant = ch;
      } else {
        if (ch === '{' || ch === '[') stack.push(ch);
        else if (ch === '}' || ch === ']') stack.pop();
        out += ch;
        if (!/\s/.test(ch)) lastSignificant = ch;
      }
      continue;
    }
    if (ch === '\\') {
      const next = text[i + 1];
      if (next !== undefined && '"\\/bfnrt'.includes(next)) { out += ch + next; i++; }
      else if (next === 'u' && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) { out += text.slice(i, i + 6); i += 5; }
      // anything else is an invalid escape: drop the backslash and keep the character
      continue;
    }
    if (ch === '"') {
      const j = skip(i + 1);
      const next = text[j];
      let closes = false;
      if (j >= n) closes = true;
      else if (next === ':') closes = isKey;
      else if (next === '}' || next === ']') closes = (next === '}') === (stack.at(-1) === '{') && STRUCTURAL_AFTER_CLOSER.test(text.slice(j + 1));
      else if (next === ',') {
        const k = skip(j + 1);
        const rest = text.slice(k);
        closes = stack.at(-1) === '{' ? rest[0] === '"' || rest[0] === '}'
          : /^(["{\[}\]]|true\b|false\b|null\b|-?\d+(\.\d+)?([eE][+-]?\d+)?\s*[,}\]])/.test(rest);
      }
      if (closes) { inString = false; out += ch; lastSignificant = ch; }
      else out += '\\"';
      continue;
    }
    if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (ch < ' ') out += `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`;
    else out += ch;
  }
  try { return JSON.parse(out); } catch { return undefined; }
}

function normalizeBlock(block, toolNames) {
  if (!object(block)) return null;
  if (block.type === 'text' && typeof block.text === 'string') return { type: 'text', text: block.text };
  const name = block.name ?? block.tool;
  const input = block.input ?? block.arguments ?? block.args;
  if ((block.type === 'tool_use' || block.type === undefined || block.type === 'tool_call' || block.type === 'function_call')
    && typeof name === 'string' && toolNames.has(name) && object(input ?? {})) {
    return { type: 'tool_use', name, input: input ?? {} };
  }
  return null;
}

function fromCandidate(candidate, toolNames) {
  if (!object(candidate)) return null;
  if (Array.isArray(candidate.content) && candidate.content.length) {
    const blocks = candidate.content.map((block) => normalizeBlock(block, toolNames));
    // Keep unknown blocks untouched so downstream validation reports them exactly as before.
    return blocks.some((block) => block === null) ? candidate.content : blocks;
  }
  for (const wrapper of [candidate.tool_call, candidate.function_call, candidate]) {
    const block = normalizeBlock(wrapper, toolNames);
    if (block?.type === 'tool_use') return [block];
  }
  return null;
}

const looksLikeEnvelope = (text) => /\{\s*"content"\s*:\s*\[/.test(text) || /"type"\s*:\s*"tool_use"/.test(text);
const stripFence = (text) => text.replace(/^```[a-zA-Z]*\s*/, '').replace(/\s*```$/, '');

function describeFailure(text) {
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  const body = first >= 0 ? text.slice(first, last > first ? last + 1 : undefined) : text;
  let message = 'the reply is not valid JSON', at = 0;
  try { JSON.parse(body); } catch (error) {
    message = String(error.message).replace(/ in JSON at position \d+.*$/, '').slice(0, 120);
    at = Number(/position (\d+)/.exec(error.message)?.[1] ?? 0);
  }
  const near = body.slice(Math.max(0, at - 40), at + 40).replace(/\s+/g, ' ');
  return { message, near };
}

// Returns { content } with Anthropic-shaped blocks, { empty: true } for a blank answer, or { invalidJson: { message, near } }
// when the answer is clearly an envelope that cannot be parsed even leniently. A broken envelope is never returned as text.
export function extractEnvelope(text, toolNames = []) {
  if (typeof text !== 'string' || !text.trim()) return { empty: true };
  const names = new Set(toolNames);
  const trimmed = text.trim();
  const strict = [];
  for (const source of [trimmed, stripFence(trimmed)]) {
    try { strict.push(JSON.parse(source)); break; } catch {}
  }
  if (!strict.length) {
    for (const span of objectSpans(trimmed).reverse()) {
      try { strict.push(JSON.parse(span)); } catch {}
    }
  }
  for (const candidate of strict) {
    const content = fromCandidate(candidate, names);
    if (content) return { content };
  }
  if (strict.length || !looksLikeEnvelope(trimmed)) return { content: [{ type: 'text', text }] };
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  const sources = [trimmed, stripFence(trimmed), ...(first >= 0 && last > first ? [trimmed.slice(first, last + 1)] : [])];
  for (const source of sources) {
    const content = fromCandidate(looseJsonParse(source), names);
    if (content) return { content };
  }
  return { invalidJson: describeFailure(trimmed) };
}
