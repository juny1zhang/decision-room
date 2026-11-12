// Claude Code adapter: claude.ai login and model checks, and one tool-restricted `claude -p` turn per answer.
import { CATALOG_TIMEOUT } from '../config.mjs';
import { diagnosticFailure } from '../diagnostics.mjs';
import { AppError } from '../errors.mjs';
import { checkCli, effortLevels, isModelId } from './common.mjs';

// Every call ignores user, project and local settings and hooks, and requires a claude.ai login.
const COMMON_ARGS = [
  '--safe-mode',
  '--setting-sources',
  '',
  '--settings',
  JSON.stringify({ forceLoginMethod: 'claudeai', disableAllHooks: true })
];
// `claude --help` must list these flags, which every call relies on.
const CLI_CHECK = {
  id: 'claude',
  helpArgs: ['--help'],
  requiredFlags: ['--safe-mode', '--tools', '--output-format']
};

/**
 * Lists the models the CLI offers and their effort levels. Sends no prompt. `help` is the `claude --help`
 * text: it decides whether the CLI can be asked, and supplies the effort levels of the fallback list.
 */
export async function claudeCatalog(bin, run, help, signal) {
  const effortHelp = help.match(/--effort\s+<[^>]+>[^\n]*(?:\n[ \t]+)?\(([^)]+)\)/i);
  const fallback = {
    models: ['sonnet', 'opus', 'haiku'],
    reasoningLevels: effortLevels(effortHelp?.[1].split(',').map((value) => value.trim())),
    reasoningByModel: {}
  };
  if (!help.includes('--input-format')) return fallback;
  // Claude's SDK initialize response contains the CLI model picker, including exact model IDs.
  const args = [...COMMON_ARGS, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json'];
  args.push('--verbose', '--no-session-persistence', '--tools', '');
  args.push('--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}');
  const input =
    JSON.stringify({ type: 'control_request', request_id: 'models', request: { subtype: 'initialize' } }) +
    '\n';
  try {
    const result = await run(bin, args, { input, signal, timeout: CATALOG_TIMEOUT });
    if (result.code !== 0) return fallback;
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
        return { models: Object.keys(reasoningByModel), reasoningByModel, reasoningLevels: defaultLevels };
      }
    }
  } catch (error) {
    if (signal?.aborted) throw error;
  }
  return fallback;
}

async function inspect(ctx) {
  const { bin, run, signal, cachedCatalog, info } = ctx;
  const help = await checkCli(ctx, CLI_CHECK);
  if (!help) return info;
  const auth = await run(bin, [...COMMON_ARGS, 'auth', 'status'], { signal });
  let result;
  try {
    result = JSON.parse(auth.stdout);
  } catch {}
  info.authenticated = auth.code === 0 && result?.loggedIn === true;
  info.subscription = info.authenticated && result.authMethod === 'claude.ai';
  info.message = info.subscription
    ? '已识别 Claude 账号登录'
    : '请执行 claude auth login，使用你的 Claude 订阅账号。';
  if (info.subscription) Object.assign(info, cachedCatalog || (await claudeCatalog(bin, run, help, signal)));
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
  if (result.code !== 0) throw new AppError(diagnosticFailure(result));
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new AppError('无法解析 Claude 返回结果。请更新 Claude Code 后重试。');
  }
  if (parsed.is_error || (parsed.subtype && parsed.subtype !== 'success')) {
    if (/max_turns/.test(parsed.subtype || ''))
      throw new AppError('Claude 达到本轮工具调用上限。请缩小问题，或关闭联网后重试。');
    throw new AppError(
      diagnosticFailure({
        code: result.code,
        stderr: parsed.result || parsed.errors?.join('\n') || '',
        stdout: ''
      })
    );
  }
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
  inspect,
  invoke
};
