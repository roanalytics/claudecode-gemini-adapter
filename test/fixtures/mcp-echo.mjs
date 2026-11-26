#!/usr/bin/env node
// Minimal MCP stdio server for tests: one real `echo` tool plus 150 dummy tools, to exercise Tool Search with many tools.
import { createInterface } from 'node:readline';

const TOTAL_DUMMY = 150;
const tools = [
  { name: 'echo', description: 'Echo the given text back, prefixed with ECHO:', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  ...Array.from({ length: TOTAL_DUMMY }, (_, index) => ({ name: `dummy_${index}`, description: `Dummy tool number ${index}; does nothing.`, inputSchema: { type: 'object', properties: {} } })),
];
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');

for await (const line of createInterface({ input: process.stdin })) {
  let request;
  try { request = JSON.parse(line); } catch { continue; }
  if (request.id === undefined) continue;
  if (request.method === 'initialize') {
    send({ id: request.id, result: { protocolVersion: request.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'echo', version: '0.0.1' } } });
  } else if (request.method === 'tools/list') send({ id: request.id, result: { tools } });
  else if (request.method === 'tools/call') {
    if (request.params?.name === 'echo') send({ id: request.id, result: { content: [{ type: 'text', text: `ECHO:${request.params.arguments?.text ?? ''}` }] } });
    else send({ id: request.id, result: { content: [{ type: 'text', text: 'dummy' }] } });
  } else if (request.method === 'resources/list') {
    send({ id: request.id, result: { resources: [{ uri: 'echo://note', name: 'note', description: 'Synthetic resource for tests', mimeType: 'text/plain' }] } });
  } else if (request.method === 'resources/read') {
    if (request.params?.uri === 'echo://note') send({ id: request.id, result: { contents: [{ uri: 'echo://note', mimeType: 'text/plain', text: 'RESOURCE_ECHO_OK' }] } });
    else send({ id: request.id, error: { code: -32602, message: 'Unknown resource' } });
  } else send({ id: request.id, error: { code: -32601, message: 'Method not found' } });
}
