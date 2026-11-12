// Helpers for the adapters that read a CLI's JSON output line by line while it answers: live previews of
// the text being written, what the model is doing, and the token usage the CLI reports.
//
// The stream formats are not documented as stable, and only Claude's streaming flags were seen in a real
// CLI's help (tests/fixtures/cli). The readers in the adapters therefore ignore every line, event and field
// they do not know, and previews are best-effort: the answer itself always comes from the CLI's final
// result, exactly as without streaming.

/**
 * Combined stdout and stderr bytes accepted from a CLI that streams partial messages. Every piece of text
 * arrives in its own JSON envelope, so such output is many times the size of the answer; it is read line
 * by line and not kept.
 */
export const STREAM_OUTPUT_LIMIT = 32 * 1024 * 1024;

export const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The JSON object on one output line, or null for anything else: blank, malformed, cut off or not an object. */
export function parseEvent(line) {
  if (typeof line !== 'string') return null;
  const text = line.trim();
  if (!text.startsWith('{')) return null;
  try {
    const value = JSON.parse(text);
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : undefined);

/** The first of `keys` that `raw` holds as a token count. */
function firstCount(raw, keys) {
  for (const key of keys) {
    const value = count(raw[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * Token usage as { inputTokens, outputTokens, cachedInputTokens } from a usage object a CLI reports, in
 * snake_case or camelCase, with only the counts it holds; null when it holds none. inputTokens counts every
 * input token, cached ones included, and cachedInputTokens those read from the prompt cache. OpenAI-style
 * usage (Codex) already counts cached tokens as input (`cacheIncluded`); Anthropic-style usage (Claude)
 * lists cache reads and cache writes beside the other input tokens, so they are added.
 */
export function readUsage(raw, { cacheIncluded = false } = {}) {
  if (!isObject(raw)) return null;
  let input = firstCount(raw, ['input_tokens', 'inputTokens']);
  const output = firstCount(raw, ['output_tokens', 'outputTokens']);
  const cached = firstCount(raw, [
    'cached_input_tokens',
    'cachedInputTokens',
    'cache_read_input_tokens',
    'cacheReadInputTokens',
    'cacheReadTokens'
  ]);
  const written = firstCount(raw, [
    'cache_creation_input_tokens',
    'cacheCreationInputTokens',
    'cacheWriteTokens'
  ]);
  if (input !== undefined && !cacheIncluded) input += (cached ?? 0) + (written ?? 0);
  const usage = {};
  if (input !== undefined) usage.inputTokens = input;
  if (output !== undefined) usage.outputTokens = output;
  if (cached !== undefined) usage.cachedInputTokens = cached;
  return Object.keys(usage).length ? usage : null;
}

/** The sum of several usages from readUsage(), such as one per model; null when none has a count. */
export function sumUsage(usages) {
  const total = {};
  for (const usage of usages) {
    if (!usage) continue;
    for (const [key, value] of Object.entries(usage)) total[key] = (total[key] ?? 0) + value;
  }
  return Object.keys(total).length ? total : null;
}

/**
 * The progress a stream reader reports, from the optional callbacks of a provider call:
 *   text(chunk)      answer text that follows what came before: onText(chunk);
 *   activity(kind)   what the model does now, 'thinking', 'searching' or 'writing': onActivity(kind), once
 *                    per change (text reports 'writing' itself);
 *   separate()       the next text starts a new paragraph (a new message, or text after a tool call): a
 *                    blank line goes before it, unless no text came yet.
 */
export function progressReporter({ onText, onActivity } = {}) {
  let activity = '';
  let written = false;
  let gap = false;
  const report = (kind) => {
    if (kind === activity) return;
    activity = kind;
    onActivity?.(kind);
  };
  return {
    activity: report,
    separate() {
      gap = written;
    },
    text(chunk) {
      if (typeof chunk !== 'string' || !chunk) return;
      report('writing');
      if (gap) onText?.('\n\n');
      gap = false;
      written = true;
      onText?.(chunk);
    }
  };
}
