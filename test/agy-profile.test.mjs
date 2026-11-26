import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkAgyProfile, inspectAgyProfile } from '../src/agy-profile.mjs';

async function home(t, files = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'agy-profile-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, '.gemini', name)), { recursive: true });
    await writeFile(path.join(dir, '.gemini', name), content);
  }
  return dir;
}

test('a fresh account has no errors and no warnings', async (t) => {
  const dir = await home(t);
  assert.deepEqual(inspectAgyProfile(dir), { errors: [], warnings: [] });
  assert.doesNotThrow(() => checkAgyProfile(dir));
});

test('billing and identity settings are fatal errors that name the offending field', async (t) => {
  for (const [settings, field] of [[{ useG1Credits: true }, 'useG1Credits'], [{ modelProvider: 'x' }, 'modelProvider']]) {
    const dir = await home(t, { 'antigravity-cli/settings.json': JSON.stringify(settings) });
    const { errors } = inspectAgyProfile(dir);
    assert.equal(errors[0].code, 'AGY_PROFILE_UNSAFE');
    assert.ok(errors[0].detail.includes(field), errors[0].detail);
    assert.throws(() => checkAgyProfile(dir), { message: 'AGY_PROFILE_UNSAFE' });
  }
  for (const text of ['{not json', '[]']) {
    const broken = await home(t, { 'antigravity-cli/settings.json': text });
    assert.equal(inspectAgyProfile(broken).errors[0].code, 'AGY_PROFILE_UNSAFE');
  }
});

test('"always allow" entries, always-proceed and MCP servers only warn', async (t) => {
  const dir = await home(t, {
    'antigravity-cli/settings.json': JSON.stringify({ permissions: { allow: ['command(ln)', 'command(git status)'] }, toolPermission: 'always-proceed' }),
    'config/mcp_config.json': '{"mcpServers":{"x":{}}}' });
  const { errors, warnings } = inspectAgyProfile(dir);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings.map((w) => w.code), ['AGY_PERMISSIONS_ALLOW', 'AGY_ALWAYS_PROCEED', 'AGY_MCP_PRESENT']);
  assert.ok(warnings[0].detail.includes('command(ln)'));
  assert.doesNotThrow(() => checkAgyProfile(dir));
});

test('safe explicit settings and an empty MCP file are accepted without warnings', async (t) => {
  const dir = await home(t, { 'antigravity-cli/settings.json': JSON.stringify({ useG1Credits: false, modelProvider: '', toolPermission: 'strict' }), 'config/mcp_config.json': '' });
  assert.deepEqual(inspectAgyProfile(dir), { errors: [], warnings: [] });
});

test('global customizations only warn', async (t) => {
  const dir = await home(t, { 'GEMINI.md': 'rules', 'config/skills/demo/SKILL.md': 'x' });
  const { errors, warnings } = inspectAgyProfile(dir);
  assert.deepEqual(errors, []);
  assert.equal(warnings[0].code, 'AGY_CUSTOMIZATIONS_PRESENT');
  assert.ok(warnings[0].detail.includes('GEMINI.md') && warnings[0].detail.includes('config/skills'));
  assert.doesNotThrow(() => checkAgyProfile(dir));
});
