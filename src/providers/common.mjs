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
 * The static checks of a CLI, which depend only on its executable: its version line, and whether the help
 * output (`helpArgs`) lists every flag in `requiredFlags`. Both commands run at the same time, with the run
 * `options`. Resolves to { ok, version, help, message }: `version` is the first line of `--version`, `help`
 * the help text, and ok is false when a command fails or a flag is missing, with the reason in `message`
 * (`outdated` for missing flags, by default "<id> 版本需要更新…"). Providers pass this to ctx.cli() so it
 * runs once per executable (see providers/index.mjs).
 */
export async function checkCli(run, bin, { id, helpArgs, requiredFlags, outdated, options = {} }) {
  const [version, help] = await Promise.all([run(bin, ['--version'], options), run(bin, helpArgs, options)]);
  const result = {
    ok: false,
    version: safeDetail(version.stdout.trim().split('\n')[0]),
    help: help.stdout,
    message: ''
  };
  if (version.code !== 0) result.message = diagnosticFailure(version);
  else if (help.code !== 0 || requiredFlags.some((flag) => !help.stdout.includes(flag)))
    result.message = outdated || `${id} 版本需要更新：本应用需要 ${requiredFlags.join('、')}。`;
  else result.ok = true;
  return result;
}
