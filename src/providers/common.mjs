// Helpers shared by the provider adapters.
import { diagnosticFailure } from '../diagnostics.mjs';
import { safeDetail } from '../redact.mjs';

/** Reasoning effort levels as the CLIs name them, lowest first. */
export const EFFORT_ORDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

/** The known effort levels among `values`, lowest first. */
export function effortLevels(values) {
  const offered = new Set(Array.isArray(values) ? values : []);
  return EFFORT_ORDER.filter((value) => offered.has(value));
}

/** Whether `value` is safe to pass to a CLI as a model ID (for example, it cannot be read as a flag). */
export function isModelId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/@+[\],=-]{0,239}$/.test(value);
}

/**
 * The first inspection steps of Codex and Claude: record the CLI version in info.version, then make sure
 * the help output (`helpArgs`) lists every flag in `requiredFlags`. Resolves to the help text, or to null
 * after writing the reason into info.message.
 */
export async function checkCli({ bin, run, signal, info }, { id, helpArgs, requiredFlags }) {
  const version = await run(bin, ['--version'], { signal });
  info.version = safeDetail(version.stdout.trim().split('\n')[0]);
  if (version.code !== 0) {
    info.message = diagnosticFailure(version);
    return null;
  }
  const help = await run(bin, helpArgs, { signal });
  if (help.code !== 0 || requiredFlags.some((flag) => !help.stdout.includes(flag))) {
    info.message = `${id} 版本需要更新：本应用需要 ${requiredFlags.join('、')}。`;
    return null;
  }
  return help.stdout;
}
