// One provider call for one discussion stage, with the checks every answer must pass.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { CLI_TIMEOUT, MAX_REPLY } from './config.mjs';
import { failureError } from './diagnostics.mjs';
import { instructions } from './prompts.mjs';
import { getProvider } from './providers/index.mjs';

/**
 * Returns invoke(id, prompt, webSearch, signal, { model, reasoning }), which runs provider `id` in a private
 * working folder under `runtimeDir` (removed afterwards) using the CLI found by the last health check
 * (`binary(id)`), and resolves to { text, model } with the text trimmed. A failed call rejects with an
 * AppError whose `category` (see diagnostics.mjs) tells what kind of failure it was; stopping, a timeout or
 * a CLI that cannot start reject without a category.
 */
export function createInvoker({ run, runtimeDir, binary }) {
  return async function invoke(id, prompt, webSearch, signal, { model, reasoning }) {
    const provider = getProvider(id);
    const workDir = await fs.mkdtemp(path.join(runtimeDir, `${id}-`));
    try {
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
        timeout: CLI_TIMEOUT
      });
      const text = typeof answer.text === 'string' ? answer.text.trim() : '';
      if (!text) throw failureError({ category: 'other', message: `${provider.label} 返回了空结果。` });
      if (text.length > MAX_REPLY)
        throw failureError({
          category: 'other',
          message: `${provider.label} 回答过长，请缩小问题范围后重试。`
        });
      return { ...answer, text };
    } finally {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  };
}
