import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveBinary } from '../src/binaries.mjs';

async function layout(t) {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'binaries-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const make = async (...parts) => {
    const file = path.join(dir, ...parts);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '#!/bin/sh\n');
    await chmod(file, 0o755);
    return file;
  };
  return { dir, make };
}

test('an explicit override wins and must exist', async (t) => {
  const { dir, make } = await layout(t);
  const file = await make('custom', 'agy');
  assert.equal(resolveBinary('agy', 'X_BIN', { env: { X_BIN: file, PATH: '' }, home: dir }), file);
  assert.throws(() => resolveBinary('agy', 'X_BIN', { env: { X_BIN: path.join(dir, 'missing'), PATH: '/bin' }, home: dir }), { message: 'AGY_NOT_FOUND' });
});

test('~/.local/bin is searched before PATH, then each PATH entry; symlinks resolve to the real file', async (t) => {
  const { dir, make } = await layout(t);
  const local = await make('.local', 'bin', 'claude');
  const onPath = await make('tools', 'claude');
  assert.equal(resolveBinary('claude', 'X', { env: { PATH: path.join(dir, 'tools') }, home: dir }), local);
  await rm(local);
  assert.equal(resolveBinary('claude', 'X', { env: { PATH: `${path.join(dir, 'nope')}:${path.join(dir, 'tools')}` }, home: dir }), onPath);
  const link = path.join(dir, 'bin', 'agy');
  const target = await make('real', 'agy-binary');
  await mkdir(path.dirname(link), { recursive: true });
  await symlink(target, link);
  assert.equal(resolveBinary('agy', 'X', { env: { PATH: path.dirname(link) }, home: dir }), target);
});

test('missing binaries report a stable code', async (t) => {
  const { dir } = await layout(t);
  assert.throws(() => resolveBinary('claude', 'X', { env: { PATH: '' }, home: dir }), { message: 'CLAUDE_NOT_FOUND' });
  assert.throws(() => resolveBinary('agy', 'X', { env: { PATH: '' }, home: dir }), { message: 'AGY_NOT_FOUND' });
});
