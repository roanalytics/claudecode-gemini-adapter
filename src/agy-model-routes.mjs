import { createAgyTransport } from './agy-transport.mjs';
import { deterministic } from './protocol.mjs';

export const AGY_ALIASES = Object.freeze({
  fable: 'gemini-4-neon-xhigh',
  opus: 'gemini-4-neon-high',
  sonnet: 'gemini-4-neon-low',
  haiku: 'gemini-3.8-flash-low',
});

// CLAUDE_GEMINI_MODEL_FABLE|OPUS|SONNET|HAIKU replace the default route of one alias.
export function resolveAliases(env = process.env) {
  const aliases = { ...AGY_ALIASES };
  for (const alias of Object.keys(AGY_ALIASES)) {
    const override = env[`CLAUDE_GEMINI_MODEL_${alias.toUpperCase()}`];
    if (override === undefined || override === '') continue;
    if (!/^gemini-[a-z0-9.-]{1,100}$/.test(override)) throw Error('INVALID_MODEL_OVERRIDE');
    aliases[alias] = override;
  }
  return Object.freeze(aliases);
}

export function claudeAgyModelPins(aliases = AGY_ALIASES) {
  return Object.fromEntries(Object.entries(aliases).map(([alias, model]) =>
    ['ANTHROPIC_DEFAULT_' + alias.toUpperCase() + '_MODEL', model]));
}

export function createRoutedAgyTransport({ invoke, pool, lean = true, rules, aliases = AGY_ALIASES } = {}) {
  const routes = new Map();
  for (const [alias, model] of Object.entries(aliases)) {
    const transport = createAgyTransport({ model, invoke, pool, lean, rules });
    routes.set(alias, transport);
    routes.set(model, transport);
  }
  return (request, signal) => {
    const route = routes.get(request.model);
    if (!route) throw deterministic('AGY_MODEL_NOT_ROUTED');
    return route(request, signal);
  };
}
