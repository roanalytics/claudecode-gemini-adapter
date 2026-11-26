import { randomUUID } from 'node:crypto';

export class BridgeError extends Error {
  constructor(code, status = 502, { retry = status >= 500 || status === 429, meta } = {}) {
    super(code); this.status = status; this.retry = retry; this.meta = meta;
  }
}
// Claude Code retries 400/401/403/404/422 regardless of x-should-retry (measured); 502 + retry:false costs exactly one request.
export const deterministic = (code, meta) => new BridgeError(code, 502, { retry: false, meta });
// Request validation failures are final: Claude Code retries 4xx responses, so they are reported as non-retryable 502s.
const fail = (code, status = 502) => { throw new BridgeError(code, status, { retry: false }); };
const modelFail = (code) => { throw new BridgeError(code, 502, { retry: false }); };
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
// Keywords this matcher enforces. Any other keyword (if/then/else, dependentRequired, nullable, x-*, ...) is ignored:
// the tool still works and Claude Code remains the final executor, so an unfamiliar schema never blocks a session.
function checkSchema(schema, depth = 0) {
  if (typeof schema === 'boolean') return;
  if (!object(schema) || depth > 32) fail('UNSUPPORTED_TOOL_SCHEMA');
  if (schema.pattern !== undefined) {
    try { new RegExp(schema.pattern, 'u'); } catch { fail('UNSUPPORTED_TOOL_SCHEMA'); }
  }
  for (const group of ['properties', '$defs', 'definitions']) {
    if (object(schema[group])) for (const child of Object.values(schema[group])) checkSchema(child, depth + 1);
  }
  for (const group of ['anyOf', 'oneOf', 'allOf']) {
    if (Array.isArray(schema[group])) for (const child of schema[group]) checkSchema(child, depth + 1);
  }
  if (schema.not !== undefined) checkSchema(schema.not, depth + 1);
  if (schema.items !== undefined && !Array.isArray(schema.items)) checkSchema(schema.items, depth + 1);
  if (object(schema.additionalProperties)) checkSchema(schema.additionalProperties, depth + 1);
  if (schema.propertyNames !== undefined) checkSchema(schema.propertyNames, depth + 1);
  if (typeof schema.$ref === 'string' && !schema.$ref.startsWith('#/')) fail('EXTERNAL_TOOL_SCHEMA_REF');
}

function matches(value, schema, root = schema, depth = 0) {
  if (depth > 48 || schema === false) return false;
  if (schema === true) return true;
  if (typeof schema.$ref === 'string' && schema.$ref.startsWith('#/')) {
    const target = schema.$ref.slice(2).split('/').reduce((node, key) => node?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], root);
    if (!target || !matches(value, target, root, depth + 1)) return false;
  }
  const types = { object: object(value), array: Array.isArray(value), string: typeof value === 'string',
    number: typeof value === 'number' && Number.isFinite(value), integer: Number.isInteger(value),
    boolean: typeof value === 'boolean', null: value === null };
  const declared = [schema.type].flat().filter((type) => typeof type === 'string' && Object.hasOwn(types, type));
  if (declared.length && !declared.some((type) => types[type])) return false;
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value))) return false;
  if (Object.hasOwn(schema, 'const') && JSON.stringify(value) !== JSON.stringify(schema.const)) return false;
  if (schema.not !== undefined && matches(value, schema.not, root, depth + 1)) return false;
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((child) => matches(value, child, root, depth + 1))) return false;
  if (Array.isArray(schema.oneOf) && schema.oneOf.filter((child) => matches(value, child, root, depth + 1)).length !== 1) return false;
  if (Array.isArray(schema.allOf) && !schema.allOf.every((child) => matches(value, child, root, depth + 1))) return false;
  if (object(value)) {
    if (schema.propertyNames && Object.keys(value).some(key => !matches(key, schema.propertyNames, root, depth + 1))) return false;
    if (Array.isArray(schema.required) && schema.required.some((key) => !Object.hasOwn(value, key))) return false;
    const count = Object.keys(value).length;
    if (count < (Number.isFinite(schema.minProperties) ? schema.minProperties : 0) || count > (Number.isFinite(schema.maxProperties) ? schema.maxProperties : Infinity)) return false;
    const properties = object(schema.properties) ? schema.properties : {};
    for (const [key, child] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) {
        if (!matches(child, properties[key], root, depth + 1)) return false;
      } else if (schema.additionalProperties === false) return false;
      else if (object(schema.additionalProperties) && !matches(child, schema.additionalProperties, root, depth + 1)) return false;
    }
  }
  if (Array.isArray(value)) {
    if (value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)) return false;
    if (schema.items !== undefined && !Array.isArray(schema.items) && !value.every((child) => matches(child, schema.items, root, depth + 1))) return false;
    if (schema.uniqueItems && new Set(value.map((child) => JSON.stringify(child))).size !== value.length) return false;
  }
  if (typeof value === 'string') {
    if ([...value].length < (schema.minLength ?? 0) || [...value].length > (schema.maxLength ?? Infinity)) return false;
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) return false;
  }
  if (typeof value === 'number' && (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity)
    || value <= (schema.exclusiveMinimum ?? -Infinity) || value >= (schema.exclusiveMaximum ?? Infinity))) return false;
  return true;
}

function blocks(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) fail('INVALID_CONTENT');
  return content;
}

function isInlineImage(block) {
  const source = block.source;
  if (!object(source) || source.type !== 'base64' || typeof source.data !== 'string' ||
    !source.data.length || source.data.length % 4 !== 0 ||
    !['image/png', 'image/jpeg', 'image/webp'].includes(source.media_type)) return false;
  const bytes = Buffer.from(source.data, 'base64');
  if (bytes.toString('base64') !== source.data) return false;
  if (source.media_type === 'image/png') return bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a';
  if (source.media_type === 'image/jpeg') return bytes.subarray(0, 3).toString('hex') === 'ffd8ff';
  return bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
}

// What validateRequest dropped from a request instead of failing (names only, never values).
const ignored = new WeakMap();
export const ignoredOf = (input) => ignored.get(input) ?? { fields: [], tools: [] };

export function validateRequest(input, { allowImages = false } = {}) {
  const allowed = new Set(['model', 'max_tokens', 'messages', 'system', 'stream', 'tools', 'tool_choice',
    'metadata', 'thinking', 'output_config', 'temperature', 'top_p', 'top_k', 'stop_sequences',
    'safeguards']); // safeguards: sent by Claude Code in plan mode; advisory for Anthropic's API, ignored here
  if (!object(input)) fail('UNSUPPORTED_REQUEST_FIELD');
  // Fields from newer Claude Code versions are dropped, not fatal; fields that change meaning are validated below.
  const drop = { fields: Object.keys(input).filter((key) => !allowed.has(key)).slice(0, 20), tools: [] };
  for (const key of drop.fields) delete input[key];
  ignored.set(input, drop);
  if (typeof input.model !== 'string' || !input.model || input.model.length > 160) fail('INVALID_MODEL');
  if (!Number.isInteger(input.max_tokens) || input.max_tokens < 1 || input.max_tokens > 65536) fail('INVALID_MAX_TOKENS');
  if (!Array.isArray(input.messages) || !input.messages.length || input.messages.length > 2000) fail('INVALID_MESSAGES');
  if (input.stream !== undefined && typeof input.stream !== 'boolean') fail('INVALID_STREAM');
  if (input.thinking && (input.thinking.type !== 'disabled' || Object.keys(input.thinking).length !== 1)) fail('THINKING_UNSUPPORTED');
  if (input.output_config && (Object.keys(input.output_config).some((key) => key !== 'effort')
    || !['low', 'medium', 'high', 'max'].includes(input.output_config.effort))) fail('OUTPUT_CONFIG_UNSUPPORTED');
  for (const key of ['temperature', 'top_p', 'top_k']) {
    if (input[key] !== undefined && (!Number.isFinite(input[key]) || input[key] < 0)) fail('INVALID_SAMPLING');
  }
  if (input.stop_sequences && (!Array.isArray(input.stop_sequences) || input.stop_sequences.length)) fail('STOP_SEQUENCES_UNSUPPORTED');
  if (input.system !== undefined && blocks(input.system).some((block) => block.type !== 'text' || typeof block.text !== 'string')) fail('UNSUPPORTED_SYSTEM');
  if (input.tools !== undefined && (!Array.isArray(input.tools) || input.tools.length > 2000)) fail('INVALID_TOOLS');
  // Server tools (for example web search) run on Anthropic's side and have no schema: the model cannot use them here.
  if (input.tools) {
    input.tools = input.tools.filter((tool) => {
      const server = object(tool) && typeof tool.type === 'string' && tool.type !== 'custom';
      if (server) drop.tools.push(String(tool.name ?? tool.type).slice(0, 80));
      return !server;
    });
  }
  const names = new Set();
  for (const tool of input.tools ?? []) {
    if (!object(tool) || (tool.type !== undefined && tool.type !== 'custom') || (tool.defer_loading !== undefined && typeof tool.defer_loading !== 'boolean')
      || !/^[\w-]{1,128}$/.test(tool.name ?? '') || names.has(tool.name)) fail('INVALID_TOOL');
    checkSchema(tool.input_schema);
    names.add(tool.name);
  }
  const choice = input.tool_choice;
  if (choice && (!['auto', 'none', 'any', 'tool'].includes(choice.type)
    || Object.keys(choice).some((key) => !['type', 'name', 'disable_parallel_tool_use'].includes(key))
    || (choice.type === 'tool' && !names.has(choice.name)))) fail('INVALID_TOOL_CHOICE');
  const pending = new Set();
  for (const message of input.messages) {
    if (!object(message) || !['user', 'assistant', 'system'].includes(message.role)) fail('INVALID_MESSAGE');
    for (const block of blocks(message.content)) {
      if (!object(block) || typeof block.type !== 'string') fail('UNSUPPORTED_CONTENT');
      if (block.type === 'text') { if (typeof block.text !== 'string') fail('UNSUPPORTED_CONTENT'); continue; }
      if (block.type === 'tool_use') {
        if (message.role !== 'assistant' || typeof block.id !== 'string' || !object(block.input)) fail('UNSUPPORTED_CONTENT');
        if (pending.has(block.id)) fail('DUPLICATE_TOOL_ID');
        pending.add(block.id);
      } else if (block.type === 'tool_result') {
        if (message.role !== 'user' || !pending.delete(block.tool_use_id)) fail('UNSUPPORTED_CONTENT');
        if (blocks(block.content ?? '').some((entry) => !object(entry) || typeof entry.type !== 'string' ||
          (entry.type === 'text' && typeof entry.text !== 'string') ||
          (entry.type === 'tool_reference' && !(typeof entry.tool_name === 'string' && entry.tool_name)) ||
          (allowImages && entry.type === 'image' && !isInlineImage(entry)))) fail('UNSUPPORTED_TOOL_RESULT');
      } else if (block.type === 'image' || block.type === 'document') {
        // Never poisons a conversation: the provider route renders a placeholder instead of the bytes.
        if (!object(block.source) || (allowImages && block.type === 'image' && message.role === 'user' && !isInlineImage(block))) fail('UNSUPPORTED_CONTENT');
      }
      // Any other block type from a newer Claude Code is accepted and rendered as "[<type> block omitted]".
    }
  }
  if (pending.size) fail('MISSING_TOOL_RESULT');
  return input;
}

export function makeMessage(input, output, id = `msg_${randomUUID().replaceAll('-', '')}`) {
  if (!object(output) || !Array.isArray(output.content) || !output.content.length) modelFail('INVALID_MODEL_ENVELOPE');
  let calls = 0;
  const content = output.content.map((block) => {
    if (block.type === 'text' && typeof block.text === 'string') return { type: 'text', text: block.text };
    const tool = input.tools?.find((candidate) => candidate.name === block.name);
    if (block.type !== 'tool_use' || !tool || !object(block.input) || !matches(block.input, tool.input_schema)) modelFail('INVALID_MODEL_TOOL_CALL');
    calls++;
    const id = typeof block.id === 'string' && /^toolu_[a-f0-9]{32}$/.test(block.id) ? block.id : `toolu_${randomUUID().replaceAll('-', '')}`;
    return { type: 'tool_use', id, name: block.name, input: block.input };
  });
  const choice = input.tool_choice;
  if ((choice?.type === 'none' && calls) || (['any', 'tool'].includes(choice?.type) && !calls)
    || (choice?.type === 'tool' && content.some((block) => block.type === 'tool_use' && block.name !== choice.name))
    || (choice?.disable_parallel_tool_use && calls > 1)) modelFail('TOOL_CHOICE_VIOLATION');
  const usage = output.usage;
  if (!usage || !['input_tokens', 'output_tokens'].every((key) => Number.isInteger(usage[key]) && usage[key] >= 0)) modelFail('MISSING_MEASURED_USAGE');
  if (usage.output_tokens > input.max_tokens) modelFail('OUTPUT_BUDGET_EXCEEDED');
  return { id, type: 'message', role: 'assistant', model: input.model,
    content, stop_reason: calls ? 'tool_use' : 'end_turn', stop_sequence: null, usage };
}

const emit = (response, event) => response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);

export function streamStart(response, { id, model, usage = { input_tokens: 0, output_tokens: 0 } }) {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  emit(response, { type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [],
    stop_reason: null, stop_sequence: null, usage: { input_tokens: usage.input_tokens, output_tokens: 0 } } });
}

export function streamFinish(response, message) {
  message.content.forEach((block, index) => {
    emit(response, { type: 'content_block_start', index, content_block: block.type === 'text'
      ? { type: 'text', text: '' } : { ...block, input: {} } });
    emit(response, { type: 'content_block_delta', index, delta: block.type === 'text'
      ? { type: 'text_delta', text: block.text } : { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
    emit(response, { type: 'content_block_stop', index });
  });
  emit(response, { type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: null },
    usage: { input_tokens: message.usage.input_tokens, output_tokens: message.usage.output_tokens } });
  emit(response, { type: 'message_stop' });
  response.end();
}

export function streamMessage(response, message) {
  streamStart(response, message);
  streamFinish(response, message);
}
