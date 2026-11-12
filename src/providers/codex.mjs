// Codex CLI adapter: login and model checks, and one read-only `codex exec` turn per answer.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { CATALOG_TIMEOUT } from '../config.mjs';
import { classifyFailure, errorText, failureError } from '../diagnostics.mjs';
import { checkCli, EFFORT_ORDER, effortLevels, isModelId } from './common.mjs';

// `codex exec --help` must list these flags, which every turn relies on.
const CLI_CHECK = {
  id: 'codex',
  helpArgs: ['exec', '--help'],
  requiredFlags: ['--ignore-user-config', '--ephemeral', '--json']
};
const DISABLED_FEATURES = ['shell_tool', 'multi_agent', 'hooks', 'apps', 'plugins'];

/** Asks the CLI for the models it offers and their reasoning levels. Sends no prompt. */
export async function codexCatalog(bin, run, signal) {
  const result = await run(bin, ['debug', 'models'], { signal, timeout: CATALOG_TIMEOUT });
  if (result.code !== 0) throw new Error('model catalog unavailable');
  const models = JSON.parse(result.stdout).models;
  const entries = models
    .filter((model) => isModelId(model.slug) && (!model.visibility || model.visibility === 'list'))
    .map((model) => [
      model.slug,
      effortLevels(model.supported_reasoning_levels?.map((level) => level.effort))
    ]);
  const reasoningByModel = Object.fromEntries(entries);
  const common = EFFORT_ORDER.filter(
    (level) => entries.length && entries.every(([, supported]) => supported.includes(level))
  );
  return { models: Object.keys(reasoningByModel), reasoningByModel, reasoningLevels: common };
}

async function inspect(ctx) {
  const { bin, run, signal, cachedCatalog, info } = ctx;
  if (!(await checkCli(ctx, CLI_CHECK))) return info;
  const auth = await run(bin, ['login', 'status'], { signal });
  const text = `${auth.stdout}\n${auth.stderr}`;
  info.authenticated = auth.code === 0;
  info.subscription = auth.code === 0 && /chatgpt/i.test(text) && !/using.{0,20}api.?key/i.test(text);
  info.message = info.subscription
    ? '已识别 ChatGPT 登录'
    : '请执行 codex login，选择 Sign in with ChatGPT。';
  if (info.subscription) {
    try {
      Object.assign(info, cachedCatalog || (await codexCatalog(bin, run, signal)));
    } catch (error) {
      if (signal?.aborted) throw error;
      info.reasoningLevels = ['low', 'medium', 'high'];
      info.message += '。模型目录暂不可用，可选默认模型或输入模型 ID。';
    }
  }
  return info;
}

// `-c` overrides that keep each turn away from project docs, memories, browsers and image tools.
const FIXED_CONFIG = [
  'model_provider="openai"',
  'project_doc_max_bytes=0',
  'features.memories=false',
  'features.computer_use=false',
  'features.in_app_browser=false',
  'features.browser_use=false',
  'features.image_generation=false'
];

/** Arguments for one ephemeral, read-only `codex exec` turn that reads its prompt from stdin. */
export function execArgs({ outputFile, model, reasoning, webSearch }) {
  const args = ['--no-daemon', '-a', 'never'];
  for (const feature of DISABLED_FEATURES) args.push('--disable', feature);
  args.push('exec');
  if (model) args.push('--model', model);
  if (reasoning) args.push('-c', `model_reasoning_effort=${JSON.stringify(reasoning)}`);
  args.push('--ignore-user-config', '--ephemeral', '--sandbox', 'read-only', '--skip-git-repo-check');
  args.push('--json', '--color', 'never');
  for (const setting of [...FIXED_CONFIG, `web_search="${webSearch ? 'live' : 'disabled'}"`])
    args.push('-c', setting);
  args.push('-o', outputFile, '-');
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
  const outputFile = path.join(workDir, 'answer.txt');
  let failed = false;
  // Messages of turn.failed and error events: with stderr, the only output that may explain a failure.
  const errors = [];
  let completed = false;
  let last = '';
  let reportedModel = '';
  const result = await run(bin, execArgs({ outputFile, model, reasoning, webSearch }), {
    input: instructions + prompt,
    cwd: workDir,
    timeout,
    signal,
    onLine(line) {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (!event || typeof event !== 'object') return;
      if (event.type === 'turn.completed') completed = true;
      if (event.type === 'turn.failed') {
        failed = true;
        errors.push(errorText(event.error));
      }
      if (event.type === 'error') errors.push(errorText(event));
      if (event.type === 'item.completed' && event.item?.type === 'agent_message')
        last = event.item.text || '';
      if (event.type === 'thread.started' && typeof event.model === 'string') reportedModel = event.model;
    }
  });
  // stdout carries the model's own messages, so it never decides what kind of failure this was.
  if (result.code !== 0 || failed)
    throw failureError(classifyFailure({ code: result.code, stderr: result.stderr, errors }));
  if (!completed)
    throw failureError({
      category: 'other',
      message: 'Codex 没有返回完成标记，未将这次输出认定为有效结论。'
    });
  let text = last;
  try {
    text = await fs.readFile(outputFile, 'utf8');
  } catch {}
  return { text, model: reportedModel || model || 'Codex 默认模型' };
}

export default {
  id: 'codex',
  label: 'Codex',
  binaries: ['codex'],
  missingHint: 'codex',
  envDenylist: [
    'OPENAI_API_KEY',
    'CODEX_API_KEY',
    'CODEX_ACCESS_TOKEN',
    'OPENAI_BASE_URL',
    'OPENAI_API_BASE'
  ],
  apiKeyEnv: ['OPENAI_API_KEY', 'CODEX_API_KEY'],
  supportsWeb: true,
  inspect,
  invoke
};
