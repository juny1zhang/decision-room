// One provider call for one discussion stage, with the checks every answer must pass.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { CLI_TIMEOUT, MAX_REPLY } from './config.mjs';
import { failureError } from './diagnostics.mjs';
import { instructions } from './prompts.mjs';
import { getProvider } from './providers/index.mjs';

/** The token counts an answer may carry. */
const USAGE_FIELDS = ['inputTokens', 'outputTokens', 'cachedInputTokens'];

/** The counts of `usage` that are whole, non-negative numbers, or null when none is. */
function cleanUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const clean = {};
  for (const field of USAGE_FIELDS) {
    const value = usage[field];
    if (Number.isSafeInteger(value) && value >= 0) clean[field] = value;
  }
  return Object.keys(clean).length ? clean : null;
}

/** `callback` made safe to call from a CLI's output handler: missing or throwing, it changes nothing. */
const quietly = (callback) => (value) => {
  try {
    callback?.(value);
  } catch {}
};

/**
 * Returns invoke(id, prompt, webSearch, signal, { model, reasoning }, { onText, onActivity }), which runs
 * provider `id` in a private working folder under `runtimeDir` (removed afterwards) using the CLI found by
 * the last health check (`binary(id)`), and resolves to { text, model, durationMs, usage? }: the text
 * trimmed, the call's wall-clock time and, when the CLI reported it, its token usage { inputTokens,
 * outputTokens, cachedInputTokens } (only the counts it reported). While the CLI answers, onText(chunk)
 * receives the text it streams and onActivity(kind) what the model does ('thinking', 'searching',
 * 'writing'), when the provider can tell; both are previews only, the answer is the resolved text. A
 * failed call rejects with an AppError whose `category` (see diagnostics.mjs) tells what kind of failure
 * it was; stopping, a timeout or a CLI that cannot start reject without a category.
 */
export function createInvoker({ run, runtimeDir, binary, now = Date.now }) {
  return async function invoke(
    id,
    prompt,
    webSearch,
    signal,
    { model, reasoning },
    { onText, onActivity } = {}
  ) {
    const provider = getProvider(id);
    const workDir = await fs.mkdtemp(path.join(runtimeDir, `${id}-`));
    try {
      const startedAt = now();
      const answer = await provider.invoke({
        bin: binary(id),
        run,
        workDir,
        signal,
        prompt,
        instructions: instructions(provider.label, webSearch),
        model,
        reasoning,
        webSearch,
        timeout: CLI_TIMEOUT,
        onText: quietly(onText),
        onActivity: quietly(onActivity)
      });
      const durationMs = Math.max(0, now() - startedAt);
      const text = typeof answer.text === 'string' ? answer.text.trim() : '';
      if (!text) throw failureError({ category: 'other', message: `${provider.label} 返回了空结果。` });
      if (text.length > MAX_REPLY)
        throw failureError({
          category: 'other',
          message: `${provider.label} 回答过长，请缩小问题范围后重试。`
        });
      const { usage: reported, ...rest } = answer;
      const usage = cleanUsage(reported);
      return { ...rest, text, durationMs, ...(usage && { usage }) };
    } finally {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  };
}
