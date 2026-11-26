import { randomBytes, randomInt } from 'node:crypto';
import path from 'node:path';

export function createLedgerTask(workspace) {
  const regions = ['north', 'south', 'west'];
  const expected = { entries: 0, north: 0, south: 0, west: 0 };
  const names = Array.from({ length: 6 }, () => path.join(workspace, randomBytes(12).toString('hex') + '.json'));
  const files = names.map((name, index) => {
    const postings = Array.from({ length: 16 }, (_, row) => {
      const region = regions[(row + index) % regions.length];
      const delta = randomInt(-30, 31);
      expected[region] += delta;
      expected.entries++;
      return [region, delta];
    });
    return { path: name, line: JSON.stringify({ next: names[index + 1] ?? null, postings }) };
  });
  const validCall = (i, blocks) => {
    const call = blocks?.[0];
    return blocks?.length === 1 && call?.type === 'tool_use' && call.name === 'Read' &&
      call.input?.file_path === files[i].path && Object.keys(call.input).length === 1;
  };
  return {
    files, validCall,
    prompt: 'Reconcile the posted ledger. Start with ' + names[0] +
      '. Use Read with only file_path, once per batch; follow each next path until null. ' +
      'Sum the signed postings per region across all batches and count all entries. ' +
      'Return only a JSON object with integer fields entries, north, south, west.',
    validReplay(i, messages) {
      const assistant = messages.at(-2), user = messages.at(-1);
      if (assistant?.role !== 'assistant' || !validCall(i, assistant.content) || user?.role !== 'user' ||
        !Array.isArray(user.content)) return false;
      const id = assistant.content[0].id;
      const results = user.content.filter(b => b.type === 'tool_result');
      const [r] = results;
      if (!id || results.length !== 1 || r.tool_use_id !== id || r.is_error) return false;
      const text = Array.isArray(r.content) ? r.content.filter(b => b.type === 'text').map(b => b.text).join('') : r.content;
      return typeof text === 'string' && text.includes(files[i].line);
    },
    validReport(text) {
      if (typeof text !== 'string') return false;
      try {
        const value = JSON.parse(text);
        return value !== null && typeof value === 'object' && Object.keys(value).length === 4 &&
          Object.keys(expected).every(k => value[k] === expected[k]);
      } catch { return false; }
    },
  };
}
