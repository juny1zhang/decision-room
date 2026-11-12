// Claude Code adapter: claude.ai login and model checks, and one tool-restricted `claude -p` turn per answer.
import { CATALOG_TIMEOUT } from '../config.mjs';
import { classifyFailure, failureError } from '../diagnostics.mjs';
import { checkCli, effortLevels, isModelId, listsFlag } from './common.mjs';

// Every call ignores user, project and local settings and hooks, and requires a claude.ai login.
const COMMON_ARGS = [
  '--safe-mode',
  '--setting-sources',
  '',
  '--settings',
  JSON.stringify({ forceLoginMethod: 'claudeai', disableAllHooks: true })
];
/** What this adapter expects of the Claude Code CLI (the format is described in common.mjs). */
export const contract = {
  versionArgs: ['--version'],
  helpChecks: [
    {
      args: ['--help'],
      flags: [
        // Every call, the login status included
        '--safe-mode',
        '--setting-sources',
        '--settings',
        // Answers and the model catalogue
        '-p',
        '--output-format',
        '--no-session-persistence',
        '--strict-mcp-config',
        '--mcp-config',
        '--tools',
        // Answers only
        '--disable-slash-commands',
        '--no-chrome',
        '--permission-mode',
        '--disallowedTools',
        '--append-system-prompt',
        '--model',
        '--effort',
        '--allowedTools',
        // The model catalogue only, which is asked when the help lists --input-format
        '--input-format',
        '--verbose'
      ],
      // Every answer relies on these.
      required: ['--safe-mode', '--tools', '--output-format']
    }
  ],
  // Accepted, but left out of --help (checked in the Claude Code 2.1.322 binary).
  hiddenFlags: ['--max-turns']
};

/**
 * The levels `claude --help` lists for --effort, lowest first, such as ["low", "medium", "high"] from
 * "--effort <level>  Effort level for the current session (low, medium, high)"; the list may start on the
 * next line. Unknown levels are left out.
 */
export function claudeEffortLevels(help) {
  const match = help.match(/--effort\s+<[^>]+>[^\n]*(?:\n[ \t]+)?\(([^)]+)\)/i);
  return effortLevels(match?.[1].split(',').map((value) => value.trim()));
}

/**
 * Lists the models the CLI offers and their effort levels. Sends no prompt. `help` is the `claude --help`
 * text: it decides whether the CLI can be asked, and supplies the effort levels of the fallback list.
 */
export async function claudeCatalog(bin, run, help, signal) {
  return (await readCatalog(bin, run, help, signal)).catalog;
}

/**
 * claudeCatalog() as { ok, catalog }: ok is false when the CLI was asked but gave no model list, so the
 * fallback list is only a stand-in and the question is worth repeating.
 */
async function readCatalog(bin, run, help, signal) {
  const fallback = {
    models: ['sonnet', 'opus', 'haiku'],
    reasoningLevels: claudeEffortLevels(help),
    reasoningByModel: {}
  };
  if (!listsFlag(help, '--input-format')) return { ok: true, catalog: fallback };
  // Claude's SDK initialize response contains the CLI model picker, including exact model IDs.
  const args = [...COMMON_ARGS, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json'];
  args.push('--verbose', '--no-session-persistence', '--tools', '');
  args.push('--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}');
  const input =
    JSON.stringify({ type: 'control_request', request_id: 'models', request: { subtype: 'initialize' } }) +
    '\n';
  try {
    const result = await run(bin, args, { input, signal, timeout: CATALOG_TIMEOUT });
    if (result.code !== 0) return { ok: false, catalog: fallback };
    for (const line of result.stdout.trim().split('\n')) {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      const response = event.response;
      if (
        event.type !== 'control_response' ||
        response?.subtype !== 'success' ||
        !Array.isArray(response.response?.models)
      )
        continue;
      const reasoningByModel = Object.create(null);
      let defaultLevels = fallback.reasoningLevels;
      for (const model of response.response.models) {
        const supported = model.supportsEffort === false ? [] : effortLevels(model.supportedEffortLevels);
        if (model.value === 'default') defaultLevels = supported;
        for (const id of [model.value, model.resolvedModel]) {
          if (isModelId(id) && id !== 'default') reasoningByModel[id] = supported;
        }
      }
      if (Object.keys(reasoningByModel).length) {
        const catalog = {
          models: Object.keys(reasoningByModel),
          reasoningByModel,
          reasoningLevels: defaultLevels
        };
        return { ok: true, catalog };
      }
    }
  } catch (error) {
    if (signal?.aborted) throw error;
  }
  return { ok: false, catalog: fallback };
}

// The version and help checks run once per executable; the login status before every discussion; the
// model catalogue again only when the login status changes or the last one is older than HEALTH_TTL.
async function inspect(ctx) {
  const { bin, run, signal, info } = ctx;
  const [cli, auth] = await Promise.all([
    ctx.cli(() => checkCli(run, bin, { id: 'claude', contract, options: { signal } })),
    run(bin, [...COMMON_ARGS, 'auth', 'status'], { signal })
  ]);
  info.version = cli.version;
  if (!cli.ok) {
    info.message = cli.message;
    return info;
  }
  let result;
  try {
    result = JSON.parse(auth.stdout);
  } catch {}
  info.authenticated = auth.code === 0 && result?.loggedIn === true;
  info.subscription = info.authenticated && result.authMethod === 'claude.ai';
  info.message = info.subscription
    ? '已识别 Claude 账号登录'
    : '请执行 claude auth login，使用你的 Claude 订阅账号。';
  if (!info.subscription) return info;
  const { catalog } = await ctx.remote(`${auth.code}\n${auth.stdout}`, () =>
    readCatalog(bin, run, cli.help, signal)
  );
  info.models = catalog.models;
  info.reasoningLevels = catalog.reasoningLevels;
  info.reasoningByModel = catalog.reasoningByModel;
  return info;
}

/**
 * Arguments for one non-interactive turn that reads its prompt from stdin: no session file, MCP servers,
 * slash commands or browser, and no tools except web search and fetch when `webSearch` is on.
 */
export function printArgs({ instructions, model, reasoning, webSearch }) {
  const tools = webSearch ? 'WebSearch,WebFetch' : '';
  const args = [...COMMON_ARGS, '-p', '--output-format', 'json', '--no-session-persistence'];
  args.push('--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}');
  args.push('--disable-slash-commands', '--no-chrome', '--permission-mode', 'dontAsk');
  args.push('--tools', tools, '--disallowedTools', 'mcp__*', '--max-turns', '8');
  args.push('--append-system-prompt', instructions);
  if (model) args.push('--model', model);
  if (reasoning) args.push('--effort', reasoning);
  if (webSearch) args.push('--allowedTools', 'WebSearch,WebFetch');
  return args;
}

async function invoke({
  bin,
  run,
  workDir,
  signal,
  prompt,
  instructions,
  model,
  reasoning,
  webSearch,
  timeout
}) {
  const args = printArgs({ instructions, model, reasoning, webSearch });
  const result = await run(bin, args, { input: prompt, cwd: workDir, timeout, signal });
  let parsed = null;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {}
  if (!parsed || typeof parsed !== 'object') parsed = null;
  // The result is the model's answer unless the CLI marked it as an error; only then may it explain a failure.
  const subtype = typeof parsed?.subtype === 'string' ? parsed.subtype : '';
  const failed = parsed !== null && (parsed.is_error === true || (subtype !== '' && subtype !== 'success'));
  if (failed && subtype.includes('max_turns'))
    throw failureError({
      category: 'other',
      message: 'Claude 达到本轮工具调用上限。请缩小问题，或关闭联网后重试。'
    });
  if (result.code !== 0 || failed) {
    const errors = failed ? [parsed.result, parsed.error, ...[parsed.errors].flat()] : [];
    throw failureError(classifyFailure({ code: result.code, stderr: result.stderr, errors }));
  }
  if (!parsed)
    throw failureError({ category: 'cli', message: '无法解析 Claude 返回结果。请更新 Claude Code 后重试。' });
  return {
    text: typeof parsed.result === 'string' ? parsed.result : '',
    model: Object.keys(parsed.modelUsage || {}).join(', ') || model || 'Claude 默认模型'
  };
}

export default {
  id: 'claude',
  label: 'Claude',
  binaries: ['claude'],
  missingHint: 'claude',
  envDenylist: [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
    'ANTHROPIC_PROFILE',
    'ANTHROPIC_FEDERATION_RULE_ID',
    'ANTHROPIC_ORGANIZATION_ID',
    // Set when Decision Room itself runs inside Claude Code; the child must not act as a nested session.
    'CLAUDECODE',
    'CLAUDE_CODE_ENTRYPOINT'
  ],
  apiKeyEnv: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
  supportsWeb: true,
  contract,
  inspect,
  invoke
};
