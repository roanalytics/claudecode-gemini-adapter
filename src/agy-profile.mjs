import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const GLOBAL_FILES = ['AGENTS.md', 'GEMINI.md', 'config/AGENTS.md', 'config/GEMINI.md', 'config/hooks.json',
  'config/agents.json', 'config/skills.json', 'config/rules.json'];
const GLOBAL_DIRS = ['config/agents', 'config/skills', 'config/rules', 'config/plugins', 'skills', 'antigravity-cli/skills'];

// Reads the user's Antigravity configuration (never credentials).
// errors: settings that touch billing or identity. The adapter refuses to run.
// warnings: settings that look risky or cost tokens but cannot weaken the adapter, because every session passes its own
// --settings (native tools denied, strict permissions), runs the claude-bridge agent without tools/MCP/skills, and the
// macOS sandbox only lets agy and /usr/bin/security execute and blocks writes outside the scratch directory.
export function inspectAgyProfile(home) {
  const errors = [];
  const warnings = [];
  const dir = path.join(home, '.gemini');
  const settingsFile = path.join(dir, 'antigravity-cli/settings.json');
  const mcpFile = path.join(dir, 'config/mcp_config.json');
  const unsafe = (detail) => errors.push({ code: 'AGY_PROFILE_UNSAFE', detail });
  let settings = {};
  if (existsSync(settingsFile)) {
    const info = lstatSync(settingsFile);
    if (!info.isFile() || info.size > 1_000_000) unsafe('antigravity-cli/settings.json is not a regular file under 1 MB');
    else {
      try { settings = JSON.parse(readFileSync(settingsFile, 'utf8')); }
      catch { unsafe('antigravity-cli/settings.json is not valid JSON'); }
    }
  }
  if (!plain(settings)) { unsafe('antigravity-cli/settings.json must contain a JSON object'); settings = {}; }
  if (settings.useG1Credits !== undefined && settings.useG1Credits !== false) unsafe('useG1Credits must be false (the adapter never spends extra AI credits)');
  if (settings.modelProvider !== undefined && settings.modelProvider !== '') unsafe('modelProvider must be empty (the adapter only uses the signed-in Antigravity account)');
  const allow = Array.isArray(settings.permissions?.allow) ? settings.permissions.allow : [];
  if (allow.length) {
    warnings.push({ code: 'AGY_PERMISSIONS_ALLOW', detail: `Antigravity "always allow" entries (${allow.slice(0, 5).map(String).join(', ')}${allow.length > 5 ? ', …' : ''}) are ignored inside the adapter: per-session settings deny native tools and the macOS sandbox blocks execution` });
  }
  if (settings.toolPermission === 'always-proceed') {
    warnings.push({ code: 'AGY_ALWAYS_PROCEED', detail: 'toolPermission is always-proceed in your Antigravity settings; the adapter overrides it with strict for every session' });
  }
  if (existsSync(mcpFile) && (!lstatSync(mcpFile).isFile() || lstatSync(mcpFile).size !== 0)) {
    warnings.push({ code: 'AGY_MCP_PRESENT', detail: 'config/mcp_config.json is not empty; provider-side MCP servers are disabled by the claude-bridge agent and cannot start inside the sandbox' });
  }
  const found = [
    ...GLOBAL_FILES.filter((file) => existsSync(path.join(dir, file))),
    ...GLOBAL_DIRS.filter((sub) => existsSync(path.join(dir, sub)) && (!lstatSync(path.join(dir, sub)).isDirectory() || readdirSync(path.join(dir, sub)).length)),
  ];
  if (found.length) {
    warnings.push({ code: 'AGY_CUSTOMIZATIONS_PRESENT', detail: `global Antigravity customizations found (${found.join(', ')}); they can add tokens. The adapter's claude-bridge agent disables tools, MCP servers and skills` });
  }
  return { errors, warnings };
}

export function checkAgyProfile(home) {
  const { errors } = inspectAgyProfile(home);
  if (errors.length) throw Error(errors[0].code);
}
