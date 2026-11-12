// Room titles: the default title made from a room's first question, and the check of a title the user
// gives a room when renaming it.
import { TITLE_LENGTH } from './config.mjs';
import { AppError } from './errors.mjs';

/** Most visible characters a room may be renamed to. */
export const TITLE_LIMIT = 80;
/**
 * Longest title in UTF-16 code units. It bounds titles whose visible characters are made of very many; an
 * emoji sequence such as a family or a regional flag takes up to 14.
 */
const TITLE_UNITS = TITLE_LIMIT * 16;

/**
 * Opening lines of the suggestions on the empty page (the data-example attributes in public/index.html; a
 * unit test keeps the two in step). A question that starts with one is titled by what the person filled in
 * below it, so that discussions started from the same suggestion get different titles.
 */
export const SUGGESTION_OPENINGS = Object.freeze([
  '我在两个选择之间犹豫。请先帮我梳理判断标准，再分别分析取舍。',
  '请帮我比较两个旅行方案，考虑交通、体力、预算和天气，给出推荐与备选。',
  '请审查这个技术方案，分析容易遗漏的边界和后续维护成本。'
]);

// Control characters (C0, DEL and C1) and the line and paragraph separators.
const CONTROL = /[\p{Cc}\u2028\u2029]/u;
const CONTROLS = /[\p{Cc}\u2028\u2029]/gu;
const LINE_BREAK = /\r\n|[\n\r\u2028\u2029]/;
// The label of a filled-in field: "选项 A：" or "Option A: ", but not "https:" or "10:30".
const FIELD_LABEL = /^[^：:]{1,16}(?:：|:(?=\s|$))\s*/;
const graphemes = new Intl.Segmenter('zh', { granularity: 'grapheme' });

/** The visible characters (grapheme clusters) of `text`. */
const visible = (text) => Array.from(graphemes.segment(text), ({ segment }) => segment);

/** `text` on one line: control characters count as spaces, runs of spaces become one, ends are trimmed. */
const oneLine = (text) => text.replace(CONTROLS, ' ').replace(/\s+/g, ' ').trim();

/**
 * `text` cut to at most `limit` visible characters, ending in "…" when it was cut (after any spaces or
 * separators the cut left at the end). Emoji, letters with combining marks and other characters made of
 * several code points are never split.
 */
export function clipTitle(text, limit = TITLE_LENGTH) {
  const characters = visible(text);
  if (characters.length <= limit) return text;
  const kept = characters.slice(0, limit - 1).join('');
  return (kept.replace(/[\s/|·,，、;；:：.。]+$/u, '') || kept) + '…';
}

/**
 * The title of a new room whose first question is `question`: its first non-empty line, with whitespace
 * collapsed, cut to about TITLE_LENGTH visible characters. When that line opens one of the page's
 * suggestions, the title is made of what was filled in after it instead (the values of fields such as
 * "选项 A：…", joined with " / "), unless nothing was.
 */
export function defaultTitle(question) {
  const lines = String(question).split(LINE_BREAK).map(oneLine).filter(Boolean);
  if (!lines.length) return '';
  const opening = SUGGESTION_OPENINGS.find((text) => lines[0].startsWith(text));
  if (opening) {
    const rest = lines[0].slice(opening.length).trim();
    const filled = [rest, ...lines.slice(1).map((line) => line.replace(FIELD_LABEL, ''))].filter(Boolean);
    if (filled.length) return clipTitle(filled.join(' / '));
  }
  return clipTitle(lines[0]);
}

/**
 * Checks a title given when renaming a room: trimmed, it must hold 1 to TITLE_LIMIT visible characters and
 * no control characters (such as a line break). Returns the trimmed title, or throws an AppError (400).
 */
export function readTitle(value) {
  const title = typeof value === 'string' ? value.trim() : '';
  if (!title) throw new AppError('讨论标题不能为空。');
  if (CONTROL.test(title)) throw new AppError('讨论标题不能包含换行或其他控制字符。');
  if (title.length > TITLE_UNITS || visible(title).length > TITLE_LIMIT)
    throw new AppError(`讨论标题不能超过 ${TITLE_LIMIT} 个字符。`);
  return title;
}
