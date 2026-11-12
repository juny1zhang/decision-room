#!/usr/bin/env node
// Checks the installed Codex, Claude Code and Cursor Agent CLIs against the `contract` of their adapters in
// src/providers (see common.mjs): each help command still lists every flag the app passes, the check the app
// runs before a CLI's first use still passes, and what the app reads without a login still parses: the
// models of `codex debug models` and Claude's --effort levels. The CLIs are found and started the way the
// app does it (DECISION_ROOM_<ID>_BIN, PATH and common install folders; API keys removed from the
// environment). Only version and help commands and `codex debug models` run: nothing sends a prompt or
// needs a login.
//
//   node scripts/check-cli-contract.mjs [codex] [claude] [cursor]
//
// A CLI named on the command line must be installed. Without names, every CLI found is checked and the
// others are skipped. Exits with 1 when a flag is missing, a command fails, a model list is empty or no
// CLI is found; with 2 for an unknown name.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRunner, findExecutable } from '../src/process.mjs';
import { claudeEffortLevels } from '../src/providers/claude.mjs';
import { codexCatalog } from '../src/providers/codex.mjs';
import { checkCli, helpOptions } from '../src/providers/common.mjs';
import { CHILD_ENV_DENYLIST, getProvider, isProviderId, PROVIDERS } from '../src/providers/index.mjs';
import { safeDetail, stripAnsi } from '../src/redact.mjs';

const USAGE = 'Usage: node scripts/check-cli-contract.mjs [codex] [claude] [cursor]';
/** Lines of a command's output shown under a failed check. */
const OUTPUT_LINES = 120;

let problems = 0;
const ok = (text) => console.log(`  ok    ${text}`);
const note = (text) => console.log(`  note  ${text}`);
const detail = (text) => console.log(`          ${text}`);
function fail(text, output = '') {
  problems += 1;
  console.log(`  FAIL  ${text}`);
  const lines = stripAnsi(output).trimEnd().split('\n');
  if (!lines.join('')) return;
  for (const line of lines.slice(0, OUTPUT_LINES)) console.log(`        | ${line}`);
  if (lines.length > OUTPUT_LINES) console.log(`        | … ${lines.length - OUTPUT_LINES} more lines`);
}

/**
 * `run`, starting each distinct command once: checkCli() and the catalogue then read the output this script
 * has already seen, as they would in the app.
 */
function runOnce(run) {
  const results = new Map();
  return (bin, args, options) => {
    const key = JSON.stringify([bin, args]);
    if (!results.has(key)) results.set(key, run(bin, args, options));
    return results.get(key);
  };
}

/** The result of `command`, or undefined after reporting why it did not exit with 0. */
async function output(run, bin, args, command) {
  let result;
  try {
    result = await run(bin, args);
  } catch (error) {
    fail(`${command}: ${safeDetail(error.message)}`);
    return undefined;
  }
  if (result.code === 0) return result;
  fail(
    `${command} exited with ${result.code ?? 'a signal'}`,
    safeDetail(result.stderr || result.stdout, 4000)
  );
  return undefined;
}

// What the app reads without a login besides the flags, checked with the adapters' own parsers. Each
// resolves to the lines to report, a summary and its details, or throws when the information is missing.
const OFFLINE = {
  async codex({ bin, run }) {
    let catalog;
    try {
      catalog = await codexCatalog(bin, run);
    } catch (error) {
      const result = await run(bin, ['debug', 'models']).catch(() => undefined);
      const failure = new Error(`codex debug models: ${error.message}`);
      failure.output = safeDetail(result?.stderr || '', 4000);
      throw failure;
    }
    const { models, reasoningByModel, reasoningLevels } = catalog;
    if (!models.length) throw new Error('codex debug models lists no model the app can offer');
    if (models.every((model) => !reasoningByModel[model].length))
      throw new Error('codex debug models lists no reasoning level the app knows, for any model');
    return [
      `codex debug models: ${models.length} models; levels all of them offer: ${reasoningLevels.join(', ') || 'none'}`,
      ...models.map((model) => `${model}: ${reasoningByModel[model].join(', ') || 'no reasoning levels'}`)
    ];
  },
  async claude({ help }) {
    const levels = claudeEffortLevels(help);
    if (!levels.length) throw new Error('claude --help lists no --effort level the app knows');
    return [`--effort levels: ${levels.join(', ')}`];
  }
};

async function checkProvider(provider, bin, run) {
  const { contract } = provider;
  const command = (args) => [path.basename(bin), ...args].join(' ');
  const version = await output(run, bin, contract.versionArgs, command(contract.versionArgs));
  if (!version) return;
  ok(`${command(contract.versionArgs)}: ${safeDetail(version.stdout.trim().split('\n')[0])}`);
  const hidden = new Set(contract.hiddenFlags);
  for (const check of contract.helpChecks) {
    const help = await output(run, bin, check.args, command(check.args));
    if (!help) continue;
    const options = helpOptions(help.stdout);
    const missing = check.flags.filter((flag) => !options.has(flag));
    if (missing.length) fail(`${command(check.args)} lists no option ${missing.join(', ')}`, help.stdout);
    else ok(`${command(check.args)} lists ${check.flags.join(' ')}`);
    const listed = contract.hiddenFlags.filter((flag) => options.has(flag));
    if (listed.length)
      note(`${command(check.args)} now lists ${listed.join(', ')}: move it from hiddenFlags to flags`);
    for (const flag of listed) hidden.delete(flag);
  }
  if (hidden.size) note(`passed but hidden from the help, so not checked here: ${[...hidden].join(', ')}`);
  let cli;
  try {
    cli = await checkCli(run, bin, { id: provider.id, contract });
  } catch (error) {
    fail(`the check before first use stopped: ${safeDetail(error.message)}`);
    return;
  }
  if (cli.ok) ok('the check the app runs before first use passes');
  else fail(`the check the app runs before first use fails: ${cli.message}`);
  if (!OFFLINE[provider.id]) return;
  try {
    const [summary, ...details] = await OFFLINE[provider.id]({ bin, run, help: cli.help });
    ok(summary);
    details.forEach(detail);
  } catch (error) {
    fail(safeDetail(error.message), error.output);
  }
}

async function main(argv) {
  const names = argv.slice(2);
  if (names.includes('--help') || names.includes('-h')) {
    console.log(USAGE);
    return;
  }
  const unknown = names.filter((name) => !isProviderId(name));
  if (unknown.length) {
    console.error(`Unknown CLI: ${unknown.join(', ')}\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  const providers = names.length ? [...new Set(names)].map(getProvider) : PROVIDERS;
  console.log(
    `Decision Room CLI contract check · Node ${process.version} · ${process.platform} ${process.arch}`
  );
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'decision-room-contract-'));
  const run = createRunner({ cwd, denylist: CHILD_ENV_DENYLIST });
  let found = 0;
  try {
    for (const provider of providers) {
      console.log('');
      const bin = await findExecutable(provider);
      if (!bin) {
        const where = `${provider.binaries.join(' or ')}; DECISION_ROOM_${provider.id.toUpperCase()}_BIN sets its path`;
        if (names.length) {
          console.log(provider.label);
          fail(`not found (${where})`);
        } else console.log(`${provider.label} · not found (${where}), skipped`);
        continue;
      }
      found += 1;
      console.log(`${provider.label} · ${bin}`);
      await checkProvider(provider, bin, runOnce(run));
    }
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
  console.log('');
  if (!found && !names.length) fail('no CLI found');
  console.log(problems ? `${problems} problem${problems === 1 ? '' : 's'} found.` : 'All checks passed.');
  if (problems) process.exitCode = 1;
}

await main(process.argv);
