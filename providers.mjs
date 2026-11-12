// Query each official CLI for the models it offers. These commands send no user prompt.
const effortOrder = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

function levels(values) {
  const offered = new Set(Array.isArray(values) ? values : []);
  return effortOrder.filter(value => offered.has(value));
}

export function isModelId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/@+[\],=-]{0,239}$/.test(value);
}

export async function codexCatalog(bin, run, signal) {
  const result = await run(bin, ['debug', 'models'], { signal, timeout: 6500 });
  if (result.code !== 0) throw new Error('model catalog unavailable');
  const models = JSON.parse(result.stdout).models;
  const entries = models.filter(model => isModelId(model.slug) && (!model.visibility || model.visibility === 'list'))
    .map(model => [model.slug, levels(model.supported_reasoning_levels?.map(level => level.effort))]);
  const reasoningByModel = Object.fromEntries(entries);
  const common = effortOrder.filter(level => entries.length && entries.every(([, supported]) => supported.includes(level)));
  return { models: Object.keys(reasoningByModel), reasoningByModel, reasoningLevels: common };
}

export async function claudeCatalog(bin, run, commonArgs, help, signal) {
  const effortHelp = help.match(/--effort\s+<[^>]+>[^\n]*(?:\n[ \t]+)?\(([^)]+)\)/i);
  const fallback = {
    models: ['sonnet', 'opus', 'haiku'],
    reasoningLevels: levels(effortHelp?.[1].split(',').map(value => value.trim())),
    reasoningByModel: {},
  };
  if (!help.includes('--input-format')) return fallback;
  // Claude's SDK initialize response contains the CLI model picker, including exact model IDs.
  const args = [...commonArgs, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json',
    '--verbose', '--no-session-persistence', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'];
  const input = JSON.stringify({ type: 'control_request', request_id: 'models', request: { subtype: 'initialize' } }) + '\n';
  try {
    const result = await run(bin, args, { input, signal, timeout: 6500 });
    if (result.code !== 0) return fallback;
    for (const line of result.stdout.trim().split('\n')) {
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      const response = event.response;
      if (event.type !== 'control_response' || response?.subtype !== 'success' || !Array.isArray(response.response?.models)) continue;
      const reasoningByModel = Object.create(null);
      let defaultLevels = fallback.reasoningLevels;
      for (const model of response.response.models) {
        const supported = model.supportsEffort === false ? [] : levels(model.supportedEffortLevels);
        if (model.value === 'default') defaultLevels = supported;
        for (const id of [model.value, model.resolvedModel]) {
          if (isModelId(id) && id !== 'default') reasoningByModel[id] = supported;
        }
      }
      if (Object.keys(reasoningByModel).length) {
        return { models: Object.keys(reasoningByModel), reasoningByModel, reasoningLevels: defaultLevels };
      }
    }
  } catch (error) {
    if (signal?.aborted) throw error;
  }
  return fallback;
}
