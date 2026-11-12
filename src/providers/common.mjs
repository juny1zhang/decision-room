// Helpers shared by the provider adapters.
//
// Each adapter also exports its `contract`: what it expects of its CLI. The contract is the one source for
// the check before an executable's first use (checkCli below), for the contract tests against captured CLI
// output (tests/unit/contract.test.mjs, tests/fixtures/cli/) and for scripts/check-cli-contract.mjs, which
// checks the installed CLIs. It has:
//   versionArgs  the arguments that print the CLI's version.
//   helpChecks   [{ args, flags, required }]: the help command `args` lists `flags`, every flag the adapter
//                passes to the command that help describes: the CLI itself for ['--help'], `codex exec` for
//                ['exec', '--help']. `required`, some of those flags, are checked before a CLI is first
//                used, and a CLI that lacks one is outdated. Flags the adapter uses only when the help
//                offers them, such as Claude's --input-format, are not required.
//   hiddenFlags  flags the adapter passes that the CLI accepts without listing them in its help.
// Checking a contract runs only version and help commands, so it needs no login and sends no prompt.
import { diagnosticFailure } from '../diagnostics.mjs';
import { safeDetail, stripAnsi } from '../redact.mjs';

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

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The `flags` that `help` does not name as a whole word: "--model" is not found in "--model-file", nor "-p"
 * in "--print". Lenient on purpose, as it decides whether the app may use a CLI: a flag mentioned anywhere
 * counts. helpOptions() is the strict reading.
 */
export function missingFlags(help, flags) {
  const text = stripAnsi(help);
  return flags.filter((flag) => !new RegExp(`(?<![\\w-])${escapeRegExp(flag)}(?![\\w-])`).test(text));
}

/** Whether `help` names `flag` (see missingFlags). */
export function listsFlag(help, flag) {
  return missingFlags(help, [flag]).length === 0;
}

// One option of an option line: a flag and its arguments, as in "-c", "--model <MODEL>", "--resume [id]",
// "--image <FILE>...", "--color[=<WHEN>]" or "-o FILE".
const OPTION = /^(-{1,2}[A-Za-z0-9][\w-]*)(?:[ =]?(?:<[^<>]*>|\[[^[\]]*\]|[A-Z][A-Z0-9_-]*)(?:\.\.\.)?)*$/;

/**
 * The flags `help` defines on its option lines, such as "-p" and "--print" from
 * "  -p, --print   Print response and exit", without those it only mentions in a description. An option
 * line starts, after at most eight spaces, with options separated by commas, followed by two or more spaces
 * or the end of the line. Stricter than missingFlags(): the contract tests and scripts/check-cli-contract.mjs
 * use it to see that each option itself is still there.
 */
export function helpOptions(help) {
  const options = new Set();
  for (const line of stripAnsi(help).split(/\r?\n/)) {
    const head = line.match(/^ {0,8}(-\S.*?)(?: {2,}|\t|$)/)?.[1].trimEnd();
    const names = head?.split(/,\s*/).map((part) => part.match(OPTION)?.[1]);
    if (names?.every(Boolean)) for (const name of names) options.add(name);
  }
  return options;
}

/**
 * The static checks of a CLI, which depend only on its executable: its version line, and whether each help
 * command of its `contract` that has `required` flags names them all (see missingFlags). The commands run at
 * the same time, with the run `options`. Resolves to { ok, version, help, message }: `version` is the first
 * line of the version output, `help` the text of the help commands it ran, and ok is false when a command
 * fails or a flag is missing, with the reason in `message` (`outdated` for missing flags, by default
 * "<id> 版本需要更新…"). Providers pass this to ctx.cli() so it runs once per executable (see
 * providers/index.mjs).
 */
export async function checkCli(run, bin, { id, contract, outdated, options = {} }) {
  const checks = contract.helpChecks.filter((check) => check.required?.length);
  const [version, ...helps] = await Promise.all([
    run(bin, contract.versionArgs, options),
    ...checks.map((check) => run(bin, check.args, options))
  ]);
  const result = {
    ok: false,
    version: safeDetail(version.stdout.trim().split('\n')[0]),
    help: helps.map((help) => help.stdout).join('\n'),
    message: ''
  };
  const lacking = checks.some(
    (check, index) => helps[index].code !== 0 || missingFlags(helps[index].stdout, check.required).length > 0
  );
  if (version.code !== 0) result.message = diagnosticFailure(version);
  else if (lacking) {
    const required = checks.flatMap((check) => check.required);
    result.message = outdated || `${id} 版本需要更新：本应用需要 ${required.join('、')}。`;
  } else result.ok = true;
  return result;
}
