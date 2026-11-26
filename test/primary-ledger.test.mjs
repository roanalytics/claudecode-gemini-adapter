import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLedgerTask } from '../scripts/primary-ledger.mjs';

test('six chained batches reconcile against the independently summed postings', () => {
  const task = createLedgerTask('/synthetic/ledger');
  assert.equal(task.files.length, 6);
  assert.equal(task.prompt.includes(task.files[0].path), true);
  const totals = { north: 0, south: 0, west: 0 };
  let entries = 0;
  for (const [i, file] of task.files.entries()) {
    const data = JSON.parse(file.line);
    assert.equal(data.next, task.files[i + 1]?.path ?? null);
    if (i > 0) assert.equal(task.prompt.includes(file.path), false);
    const call = { type: 'tool_use', id: 'r' + i, name: 'Read', input: { file_path: file.path } };
    assert.equal(task.validCall(i, [call]), true);
    assert.equal(task.validCall(i, [{ ...call, input: { file_path: file.path, offset: 1 } }]), false);
    const messages = [{ role: 'assistant', content: [call] }, { role: 'user', content: [
      { type: 'tool_result', tool_use_id: call.id, content: [{ type: 'text', text: '1\t' + file.line }] }] }];
    assert.equal(task.validReplay(i, messages), true);
    messages[1].content[0].tool_use_id = 'wrong';
    assert.equal(task.validReplay(i, messages), false);
    messages[1].content[0].tool_use_id = call.id;
    messages[1].content[0].content = 'unrelated data';
    assert.equal(task.validReplay(i, messages), false);
    for (const [region, delta] of data.postings) { totals[region] += delta; entries++; }
  }
  assert.equal(entries, 96);
  const report = JSON.stringify({ entries, ...totals });
  assert.equal(task.validReport(report), true);
  assert.equal(task.validReport(JSON.stringify({ entries, ...totals, north: totals.north + 1 })), false);
  assert.equal(task.validReport('unverified'), false);
});
