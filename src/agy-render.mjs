import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { SAFE_EVENT_CHARS } from './agy-limits.mjs';

export const LEAN_RULES = JSON.parse(readFileSync(new URL('../config/lean-filters.json', import.meta.url), 'utf8'));
export const LATEST = '<latest_turn>Respond to the most recent message(s) above, using the whole conversation as context, with the JSON envelope only.</latest_turn>';
export const READY_NOTICE = 'reply with {"content":[{"type":"text","text":"READY"}]} and nothing else';

export const sha = (value) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const blocksOf = (content) => typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];

export const IMAGE_PLACEHOLDER = '[image omitted: this Gemini route does not receive images; say so if the user asks about it]';
export const DOCUMENT_PLACEHOLDER = '[document omitted: this Gemini route does not receive documents; say so if the user asks about it]';

// Text for any non-text block, shared by messages and tool results. Never includes base64 payloads.
function placeholder(block) {
  if (block.type === 'image') return IMAGE_PLACEHOLDER;
  if (block.type === 'document') return DOCUMENT_PLACEHOLDER;
  if (block.type === 'tool_reference') return `[tool loaded: ${block.tool_name}]`;
  return `[${String(block.type)} block omitted]`;
}

export function resultText(block) {
  return blocksOf(block.content ?? '').map((entry) => entry.type === 'text' ? (entry.text ?? '') : placeholder(entry)).join('\n');
}

// Canonical per-message hash. Tool inputs are excluded on purpose: Claude may rewrite them
// (hooks, permission updates) without changing what the provider already saw.
export function hashMessage(message) {
  const blocks = blocksOf(message.content).flatMap((block) => {
    if (block.type === 'text') return block.text === '' ? [] : [{ type: 'text', text: block.text }];
    if (block.type === 'tool_use') return [{ type: 'tool_use', id: block.id, name: block.name }];
    if (block.type === 'tool_result') return [{ type: 'tool_result', id: block.tool_use_id, error: Boolean(block.is_error), content: sha(resultText(block)) }];
    return [{ type: block.type, media: block.source?.media_type ?? null }];
  });
  return sha({ role: message.role, blocks });
}

export function hashSystem(system) {
  return sha(blocksOf(system).map((block) => block.text ?? ''));
}

export function loadLeanRules(env = process.env) {
  const file = env.CLAUDE_GEMINI_LEAN_FILTERS;
  if (!file) return LEAN_RULES;
  let rules;
  try { rules = JSON.parse(readFileSync(file, 'utf8')); } catch { throw Error('INVALID_LEAN_FILTERS'); }
  const valid = Array.isArray(rules) && rules.every((rule) => rule !== null && typeof rule === 'object' && typeof rule.label === 'string'
    && (typeof rule.start === 'string' || typeof rule.paragraph === 'string')
    && [rule.start, rule.end, rule.paragraph].every((pattern) => {
      if (pattern === undefined) return true;
      try { new RegExp(pattern, 'm'); return typeof pattern === 'string'; } catch { return false; }
    }));
  if (!valid) throw Error('INVALID_LEAN_FILTERS');
  return rules;
}

export function leanText(input, omitted, rules = LEAN_RULES) {
  let out = input;
  for (const rule of rules) {
    if (rule.start) {
      const first = new RegExp(rule.start, 'm').exec(out);
      if (!first) continue;
      const from = first.index;
      const after = from + first[0].length;
      let to = out.length;
      if (rule.end) {
        const stop = new RegExp(rule.end, 'm').exec(out.slice(after));
        if (!stop) continue;
        to = after + stop.index;
      }
      if (to - from < (rule.minChars ?? 0)) continue;
      omitted.push({ label: rule.label, chars: to - from });
      out = `${out.slice(0, from)}[omitted by lean profile: ${rule.label}]\n\n${out.slice(to)}`;
    } else if (rule.paragraph) {
      const pattern = new RegExp(rule.paragraph, 'm');
      out = out.split('\n\n').map((paragraph) => {
        if (!pattern.test(paragraph) || paragraph.length < (rule.minChars ?? 0)) return paragraph;
        const kept = `[omitted by lean profile: ${rule.label}]`;
        omitted.push({ label: rule.label, chars: paragraph.length - kept.length });
        return kept;
      }).join('\n\n');
    }
  }
  return out;
}

export function createRenderContext({ lean = true, seen = new Set(), rules = LEAN_RULES } = {}) {
  return { lean, seen, rules, omitted: [] };
}

function filterText(value, role, context) {
  let out = context.lean ? leanText(value, context.omitted, context.rules) : value;
  if (role === 'system' && context.lean) {
    out = out.split('\n\n').filter((paragraph) => {
      if (paragraph.length < 30) return true;
      const key = sha(paragraph);
      if (context.seen.has(key)) { context.omitted.push({ label: 'duplicate system paragraph', chars: paragraph.length }); return false; }
      context.seen.add(key);
      return true;
    }).join('\n\n');
  }
  return out;
}

function renderBlock(block, role, context) {
  if (block.type === 'text') return filterText(block.text, role, context);
  if (block.type === 'tool_use') return `<tool_use id="${block.id}" name="${block.name}">${JSON.stringify(block.input)}</tool_use>`;
  if (block.type === 'tool_result') {
    return `<tool_result id="${block.tool_use_id}" error="${Boolean(block.is_error)}">\n${resultText(block)}\n</tool_result>`;
  }
  return placeholder(block);
}

export function renderMessage(message, context) {
  const body = blocksOf(message.content).map((block) => renderBlock(block, message.role, context)).filter((part) => part !== '').join('\n');
  return `<message role="${message.role}">\n${body}\n</message>`;
}

export const renderConversation = (messages, context) => messages.map((message) => renderMessage(message, context)).join('\n');

export function referencedTools(messages) {
  const names = new Set();
  for (const message of messages) {
    for (const block of blocksOf(message.content)) {
      if (block.type !== 'tool_result') continue;
      for (const entry of blocksOf(block.content ?? '')) if (entry.type === 'tool_reference') names.add(entry.tool_name);
    }
  }
  return names;
}

const MAX_PROP_DESC = 200;

function trimPropDesc(text) {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= MAX_PROP_DESC) return clean;
  const sentences = clean.split(/(?<=[.!?])\s+/);
  let out = sentences[0];
  for (let i = 1; i < sentences.length && out.length + 1 + sentences[i].length <= MAX_PROP_DESC; i++) {
    out += ' ' + sentences[i];
  }
  return out.length <= MAX_PROP_DESC ? out : out.slice(0, MAX_PROP_DESC - 1).trimEnd() + '…';
}

export function compactSchema(schema, depth = 0) {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map((item) => compactSchema(item, depth + 1));
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === '$schema') continue;
    if (key === 'description' && depth > 0 && typeof value === 'string') { out[key] = trimPropDesc(value); continue; }
    out[key] = compactSchema(value, depth + 1);
  }
  return out;
}

export function renderTool(tool, referenced = new Set(), { lean = true } = {}) {
  if (tool.defer_loading && !referenced.has(tool.name)) return `<tool name="${tool.name}" deferred="true"/>`;
  const schema = lean ? compactSchema(tool.input_schema) : tool.input_schema;
  const desc = lean ? String(tool.description ?? '').replace(/\n{3,}/g, '\n\n').trim() : (tool.description ?? '');
  return `<tool name="${tool.name}">\n${desc}\ninput_schema: ${JSON.stringify(schema)}\n</tool>`;
}

export function renderStatic({ system, tools = [], messages = [] }, context) {
  const systemText = blocksOf(system ?? []).map((block) => block.text).join('\n\n');
  const referenced = referencedTools(messages);
  return `<harness_system>\n${context.lean ? leanText(systemText, context.omitted, context.rules) : systemText}\n</harness_system>\n<tools>\n${
    tools.map((tool) => renderTool(tool, referenced, { lean: context.lean })).join('\n')}\n</tools>`;
}

export const escapeAt = (text) => text.replaceAll('@', '\\u0040');

// Statelessly render the whole request as one event.
export function renderFull(request, { lean = true, seen, rules } = {}) {
  const context = createRenderContext({ lean, seen, rules });
  const staticText = renderStatic(request, context);
  const conversation = renderConversation(request.messages, context);
  return { text: escapeAt(`${staticText}\n<conversation>\n${conversation}\n</conversation>\n${LATEST}`), omitted: context.omitted };
}

export function estimateTokens(request) {
  return Math.ceil(renderFull(request).text.length / 3.6) + 5000;
}

// Split a body into events no larger than `limit`; every part but the last asks for READY.
export function splitEvents(body, { limit = SAFE_EVENT_CHARS, tail = LATEST } = {}) {
  if (body.length + tail.length <= limit) return [body + tail];
  const room = limit - tail.length - 200;
  const pieces = [];
  for (let at = 0; at < body.length;) {
    let end = Math.min(body.length, at + room);
    if (end < body.length) {
      const cut = body.lastIndexOf('\n', end);
      if (cut > at + room * 0.5) end = cut + 1;
    }
    pieces.push(body.slice(at, end));
    at = end;
  }
  return pieces.map((piece, index) => {
    const header = `[context part ${index + 1}/${pieces.length}${index + 1 < pieces.length ? ` — ${READY_NOTICE}` : ' — final part'}]\n`;
    return header + piece + (index + 1 === pieces.length ? tail : '');
  });
}
