// Markdown parser for model answers. It turns text into a small tree and uses no DOM, so the page and
// the Node unit tests run the same code; js/markdown.js builds DOM nodes from the tree.
//
// The syntax follows CommonMark and GitHub's tables and strikethrough, adjusted for model answers:
// a list nests under the item above it when it is indented by two or more spaces (or a tab); a "---"
// line after a paragraph is a rule, not a heading underline; **strong** also closes right after CJK
// punctuation ("**结论：**之后"); and bare http(s) URLs become links. Raw HTML is never interpreted: it
// stays text. Only http(s) URLs become links.
//
// Block nodes:
//   { type: 'heading', level: 1-6, children: Inline[] }
//   { type: 'paragraph', children: Inline[] }                      text keeps its line breaks ("\n")
//   { type: 'blockquote', children: Inline[] }
//   { type: 'codeBlock', lang: string, text: string }              lang: first word after ``` or ''
//   { type: 'hr' }
//   { type: 'list', ordered: boolean, start: number (ordered lists only), loose: boolean,
//     items: Block[][] }                     loose: items or their blocks are separated by blank lines
//   { type: 'table', align: ('left' | 'center' | 'right' | null)[], head: Inline[][], rows: Inline[][][] }
// Inline nodes:
//   { type: 'text', text } · { type: 'code', text } · { type: 'strong' | 'em' | 'del', children }
//   { type: 'link', href, title?, children }                      href: an absolute http(s) URL

const TAB_WIDTH = 4;
// Limits that keep the work linear on hostile input: lists nested deeper stay text, and longer link
// texts, link targets and URLs are not links.
const MAX_DEPTH = 12;
const MAX_LABEL = 500;
const MAX_URL = 2048;
const MAX_LANGUAGE = 30;

// ---------------------------------------------------------------- Blocks

const HEADING = /^ {0,3}(#{1,6})\s+(\S.*)$/s;
const RULE = /^[ \t]*(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const QUOTE = /^ {0,3}>[ \t]?/;
const LIST_ITEM = /^([ \t]*)([-*]|(\d{1,9})[.)])(\s+)(\S.*)$/s;
const FENCE = /^([ \t]*)(`{3,})([^`]*)$/;
const CLOSING_FENCE = /^[ \t]*(`{3,})[ \t]*$/;
const SEPARATOR_CELL = /^(:?)-+(:?)$/;

const isBlank = (line) => !line.trim();
const isSpaceOrTab = (char) => char === ' ' || char === '\t';

/** Trims spaces and tabs only: a full-width space that indents Chinese text is kept. */
function trimLine(line) {
  let start = 0;
  let end = line.length;
  while (start < end && isSpaceOrTab(line[start])) start++;
  while (end > start && isSpaceOrTab(line[end - 1])) end--;
  return line.slice(start, end);
}

/** A heading's text, without a closing run of hashes ("## 标题 ##"). */
function headingText(text) {
  let end = text.length;
  while (end > 0 && WHITESPACE.test(text[end - 1])) end--;
  let hashes = end;
  while (hashes > 0 && text[hashes - 1] === '#') hashes--;
  if (hashes > 0 && hashes < end && WHITESPACE.test(text[hashes - 1])) end = hashes;
  return text.slice(0, end).trim();
}

/** Width in columns of a line prefix, with tabs advancing to the next multiple of four. */
function width(prefix) {
  let column = 0;
  for (const char of prefix) column += char === '\t' ? TAB_WIDTH - (column % TAB_WIDTH) : 1;
  return column;
}

const indentOf = (line) => width(/^[ \t]*/.exec(line)[0]);

/** Removes up to `columns` columns of indentation; a tab that is only partly removed leaves spaces. */
function stripIndent(line, columns) {
  let column = 0;
  let index = 0;
  while (column < columns && (line[index] === ' ' || line[index] === '\t')) {
    const next = line[index] === '\t' ? column + TAB_WIDTH - (column % TAB_WIDTH) : column + 1;
    if (next > columns) return ' '.repeat(next - columns) + line.slice(index + 1);
    column = next;
    index++;
  }
  return line.slice(index);
}

/** The run of identical characters starting at `index`. */
function runLength(text, index) {
  let end = index;
  while (text[end] === text[index]) end++;
  return end - index;
}

/** A line that opens a fenced code block: three or more backticks and an optional language. */
function openingFence(line) {
  const match = FENCE.exec(line);
  if (!match) return null;
  const lang = match[3].trim().split(/\s+/)[0].slice(0, MAX_LANGUAGE);
  return { indent: width(match[1]), length: match[2].length, lang };
}

function closesFence(line, fence) {
  const match = CLOSING_FENCE.exec(line);
  return match !== null && match[1].length >= fence.length;
}

/** A list item's marker line: its indentation, content column, type and content. */
function listMarker(line) {
  const match = LIST_ITEM.exec(line);
  if (!match || RULE.test(line)) return null;
  const indent = width(match[1]);
  const markerEnd = indent + match[2].length;
  const gap = width(match[1] + match[2] + match[4]) - markerEnd;
  return {
    indent,
    column: markerEnd + Math.min(gap, 4),
    ordered: match[3] !== undefined,
    number: Number(match[3] ?? 0),
    content: match[5]
  };
}

/** Splits a table row at its pipes, except escaped ones (\|) and those inside code spans. */
function splitRow(line) {
  const text = line.trim();
  const cells = [];
  let cell = '';
  let closed = false;
  let index = text.startsWith('|') ? 1 : 0;
  while (index < text.length) {
    const char = text[index];
    closed = false;
    if (char === '\\' && index + 1 < text.length) {
      cell += text[index + 1] === '|' ? '|' : text.slice(index, index + 2);
      index += 2;
    } else if (char === '`') {
      const length = runLength(text, index);
      const close = codeSpanEnd(text, index + length, length);
      const end = close < 0 ? index + length : close + length;
      // As on GitHub, "\|" inside a code span in a table is a pipe too.
      cell += text.slice(index, end).replaceAll('\\|', '|');
      index = end;
    } else if (char === '|') {
      cells.push(cell.trim());
      cell = '';
      closed = true;
      index++;
    } else {
      cell += char;
      index++;
    }
  }
  if (!closed) cells.push(cell.trim());
  return cells;
}

/** The column alignments of a table's separator row (|:---|---:|), or null if it is not one. */
function tableAlignment(line) {
  if (line === undefined || !line.includes('|')) return null;
  const align = [];
  for (const cell of splitRow(line)) {
    const match = SEPARATOR_CELL.exec(cell);
    if (!match) return null;
    align.push(match[1] && match[2] ? 'center' : match[2] ? 'right' : match[1] ? 'left' : null);
  }
  return align;
}

const tableStarts = (line, next) => line.includes('|') && tableAlignment(next) !== null;

/** Lines that end a paragraph (or a list item's lazy continuation) instead of continuing it. */
function interrupts(line, next, depth) {
  return (
    openingFence(line) !== null ||
    HEADING.test(line) ||
    RULE.test(line) ||
    QUOTE.test(line) ||
    (depth < MAX_DEPTH && listMarker(line) !== null) ||
    tableStarts(line, next)
  );
}

function parseFence(lines, index, fence) {
  const code = [];
  let next = index + 1;
  while (next < lines.length && !closesFence(lines[next], fence))
    code.push(stripIndent(lines[next++], fence.indent));
  if (next < lines.length) next++;
  // An unclosed fence (a cut-off answer) runs to the end, without the blank lines it ends with.
  else while (code.length && isBlank(code[code.length - 1])) code.pop();
  return { block: { type: 'codeBlock', lang: fence.lang, text: code.join('\n') }, next };
}

function parseTable(lines, index) {
  const head = splitRow(lines[index]);
  const align = tableAlignment(lines[index + 1]);
  const rows = [];
  let next = index + 2;
  while (next < lines.length && !isBlank(lines[next]) && lines[next].includes('|')) {
    const cells = splitRow(lines[next++]);
    while (cells.length < head.length) cells.push('');
    rows.push(cells.map((cell) => parseInline(cell)));
  }
  return { block: { type: 'table', align, head: head.map((cell) => parseInline(cell)), rows }, next };
}

function parseQuote(lines, index) {
  const quote = [];
  let next = index;
  while (next < lines.length && QUOTE.test(lines[next]))
    quote.push(trimLine(lines[next++].replace(QUOTE, '')));
  return { block: { type: 'blockquote', children: parseInline(quote.join('\n')) }, next };
}

function parseParagraph(lines, index, depth) {
  const text = [trimLine(lines[index])];
  let next = index + 1;
  while (next < lines.length && !isBlank(lines[next]) && !interrupts(lines[next], lines[next + 1], depth))
    text.push(trimLine(lines[next++]));
  return { block: { type: 'paragraph', children: parseInline(text.join('\n')) }, next };
}

/** Per array of lines, the last search that found no closing fence: { from, length }. */
const unclosedFences = new WeakMap();

/** The index of the line that closes `fence`, searching from `from`, or -1. */
function fenceEnd(lines, from, fence) {
  // No closing line after `from` for a fence means none after it for a longer fence either.
  const failed = unclosedFences.get(lines);
  if (failed && from >= failed.from && fence.length >= failed.length) return -1;
  for (let index = from; index < lines.length; index++) if (closesFence(lines[index], fence)) return index;
  unclosedFences.set(lines, { from, length: fence.length });
  return -1;
}

/**
 * Adds a fenced code block's lines, up to its closing line, to a list item's lines. The code loses
 * the item's indentation, or less if the code itself is indented less, so it keeps its own layout.
 */
function takeFence(lines, from, close, column, out) {
  let strip = column;
  for (let index = from; index < close; index++)
    if (!isBlank(lines[index])) strip = Math.min(strip, indentOf(lines[index]));
  for (let index = from; index < close; index++) out.push(stripIndent(lines[index], strip));
  out.push(stripIndent(lines[close], Math.min(indentOf(lines[close]), column)));
  return close + 1;
}

/**
 * Collects one list item's lines without the indentation that places them in the item: lines
 * indented by two or more columns more than the item's marker (which may be nested list items),
 * blank lines followed by such a line, and lazy continuation lines (unindented text that continues
 * the item's last paragraph). A fenced code block opened in the item belongs to it up to its
 * closing line, even where the code is not indented. Returns the lines, the index of the first line
 * after the item and how many blank lines precede that line.
 */
function collectItem(lines, index, marker) {
  const { indent, column } = marker;
  const out = [];
  let next = index + 1;
  let blanks = 0;
  let lazy = false; // whether the last line can take a lazy continuation line
  let unclosed = false; // inside a fence without a closing line: it ends with the item
  const add = (line) => {
    out.push(line);
    if (unclosed) return;
    const fence = openingFence(line);
    lazy = !fence && !HEADING.test(line) && !RULE.test(line);
    if (!fence) return;
    const close = fenceEnd(lines, next, fence);
    if (close < 0) unclosed = true;
    else next = takeFence(lines, next, close, column, out);
  };
  add(marker.content);
  while (next < lines.length) {
    const line = lines[next];
    if (isBlank(line)) {
      blanks++;
      next++;
      continue;
    }
    const lineIndent = indentOf(line);
    if (lineIndent >= indent + 2) {
      for (; blanks; blanks--) out.push('');
      next++;
      add(stripIndent(line, Math.min(lineIndent, column)));
    } else if (!blanks && lazy && !interrupts(line, lines[next + 1], 0)) {
      out.push(trimLine(line));
      next++;
    } else break;
  }
  return { lines: out, next, blanks };
}

function parseList(lines, index, depth) {
  let marker = listMarker(lines[index]);
  const list = { type: 'list', ordered: marker.ordered };
  if (marker.ordered) list.start = marker.number;
  list.loose = false;
  list.items = [];
  let next = index;
  let end;
  for (;;) {
    const item = collectItem(lines, next, marker);
    const { blocks, spans } = parseBlocks(item.lines, depth + 1);
    list.items.push(blocks);
    if (spans.some(([start], k) => k > 0 && start > spans[k - 1][1])) list.loose = true;
    next = item.next;
    end = next - item.blanks;
    marker = next < lines.length ? listMarker(lines[next]) : null;
    // A different kind of marker (bullet vs. number) starts a new list.
    if (!marker || marker.ordered !== list.ordered) break;
    if (item.blanks) list.loose = true;
  }
  return { block: list, next, end };
}

function parseBlock(lines, index, depth) {
  const line = lines[index];
  const fence = openingFence(line);
  if (fence) return parseFence(lines, index, fence);
  if (tableStarts(line, lines[index + 1])) return parseTable(lines, index);
  const heading = HEADING.exec(line);
  if (heading)
    return {
      block: { type: 'heading', level: heading[1].length, children: parseInline(headingText(heading[2])) },
      next: index + 1
    };
  if (RULE.test(line)) return { block: { type: 'hr' }, next: index + 1 };
  if (QUOTE.test(line)) return parseQuote(lines, index);
  if (depth < MAX_DEPTH && listMarker(line)) return parseList(lines, index, depth);
  return parseParagraph(lines, index, depth);
}

/**
 * Parses lines into blocks. `spans` holds each block's first line and the line after its last one,
 * which tells a list whether blank lines separate the blocks of an item (a loose list).
 */
function parseBlocks(lines, depth) {
  const blocks = [];
  const spans = [];
  let index = 0;
  while (index < lines.length) {
    if (isBlank(lines[index])) {
      index++;
      continue;
    }
    const { block, next, end = next } = parseBlock(lines, index, depth);
    blocks.push(block);
    spans.push([index, end]);
    index = next;
  }
  return { blocks, spans };
}

/** Parses Markdown text into block nodes (see the top of this file). */
export function parseMarkdown(text) {
  const lines = String(text || '')
    .replace(/\r\n?/g, '\n')
    .split('\n');
  return parseBlocks(lines, 0).blocks;
}

// ---------------------------------------------------------------- Inline content

const ESCAPABLE = /[!-/:-@[-`{-~]/;
const WHITESPACE = /\s/;
const PUNCTUATION = /[\p{P}\p{S}]/u;
const CJK =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303f\uff00-\uffef]/u;
const INLINE_SPECIAL = /[\\`*_~[<hH]/g;
const ASCII_ALPHANUMERIC = /[A-Za-z0-9]/;
const URL_START = /https?:\/\//iy;
const ANGLE_URL = /<(https?:\/\/[^\s<>]*)>/iy;
const HOST_CHAR = /[\w.~%:@!$&'()*+,;=[\]-]/;
const URL_STOP = /[\s<>"`\u2010-\u2027\u3000-\u303f\uff00-\uffef]/;
const URL_TRAILING = /[?!.,:;*_~'。，、；：！？]/;

const isAscii = (char) => char.charCodeAt(0) < 128;

/** The absolute http(s) URL `value` names, normalized, or null for anything else. */
export function safeUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/** Index of the run of exactly `length` backticks that closes a code span, or -1. Spans stay on a line. */
function codeSpanEnd(text, from, length) {
  let lineEnd = text.indexOf('\n', from);
  if (lineEnd < 0) lineEnd = text.length;
  for (let index = text.indexOf('`', from); index >= 0 && index < lineEnd; index = text.indexOf('`', index)) {
    const run = runLength(text, index);
    if (run === length) return index;
    index += run;
  }
  return -1;
}

/** A code span's text: one space is removed from both ends when both have one (`` `x` ``). */
const codeText = (content) =>
  content.startsWith(' ') && content.endsWith(' ') && /[^ ]/.test(content) ? content.slice(1, -1) : content;

const isSpace = (char) => char <= ' ' || (!isAscii(char) && WHITESPACE.test(char));

function skipSpaces(text, index) {
  while (isSpaceOrTab(text[index])) index++;
  return index;
}

/** The index of the first `stop` character from `index` on the same line, within `limit` characters. */
function findOnLine(text, index, stop, limit) {
  const end = Math.min(text.length, index + limit);
  for (let position = index; position < end; position++) {
    if (text[position] === stop) return position;
    if (text[position] === '\n') return -1;
  }
  return -1;
}

/** The "(url "title")" part of a link, starting after its "(": the URL may hold balanced parentheses. */
function parseDestination(text, index) {
  let position = skipSpaces(text, index);
  let url;
  if (text[position] === '<') {
    const end = findOnLine(text, position + 1, '>', MAX_URL);
    if (end < 0) return null;
    url = text.slice(position + 1, end);
    if (url.includes('<')) return null;
    position = end + 1;
  } else {
    const start = position;
    const limit = Math.min(text.length, start + MAX_URL);
    let depth = 0;
    for (; position < limit; position++) {
      const char = text[position];
      if (char === '\\' && ESCAPABLE.test(text[position + 1] ?? '')) position++;
      else if (isSpace(char)) break;
      else if (char === '(') depth++;
      else if (char === ')' && --depth < 0) break;
    }
    if (depth > 0 || position === start || position >= limit) return null;
    url = text.slice(start, position).replace(/\\([!-/:-@[-`{-~])/g, '$1');
  }
  const afterUrl = position;
  position = skipSpaces(text, position);
  let title = '';
  if (position > afterUrl && /["'(]/.test(text[position] ?? '')) {
    const end = findOnLine(text, position + 1, text[position] === '(' ? ')' : text[position], MAX_LABEL);
    if (end < 0) return null;
    title = text.slice(position + 1, end);
    position = skipSpaces(text, end + 1);
  }
  return text[position] === ')' ? { url, title, end: position + 1 } : null;
}

/** A [text](url) link starting at `index`, or null; links to anything but http(s) stay text. */
function parseLink(text, index) {
  let depth = 0;
  let close = -1;
  const limit = Math.min(text.length, index + MAX_LABEL);
  for (let position = index; position < limit && close < 0;) {
    const char = text[position];
    if (char === '\n') return null;
    if (char === '\\') position += 2;
    else if (char === '`') {
      const length = runLength(text, position);
      const end = codeSpanEnd(text, position + length, length);
      position = end < 0 ? position + length : end + length;
    } else {
      if (char === '[') depth++;
      else if (char === ']' && --depth === 0) close = position;
      position++;
    }
  }
  if (close < 0 || text[close + 1] !== '(') return null;
  const label = text.slice(index + 1, close);
  const target = label.trim() ? parseDestination(text, close + 2) : null;
  const href = target && safeUrl(target.url);
  if (!href) return null;
  const node = { type: 'link', href, children: inline(label, true) };
  if (target.title) node.title = target.title;
  return { node, end: target.end };
}

/** An <http(s)://…> link starting at `index`, or null. */
function angleLink(text, index) {
  ANGLE_URL.lastIndex = index;
  const match = ANGLE_URL.exec(text);
  const href = match && safeUrl(match[1]);
  if (!href) return null;
  return {
    node: { type: 'link', href, children: [{ type: 'text', text: match[1] }] },
    end: ANGLE_URL.lastIndex
  };
}

/**
 * A bare http(s) URL starting at `index`, or null. It ends at a space, a quote, an angle bracket or
 * CJK punctuation; trailing punctuation and an unbalanced closing bracket stay outside the link. In
 * the path a non-ASCII character (北京 in …/wiki/北京) continues the URL only where a segment or value
 * starts, so a URL followed by Chinese text without a space ends where that text starts.
 */
function bareLink(text, index) {
  URL_START.lastIndex = index;
  if (!URL_START.test(text)) return null;
  const hostStart = URL_START.lastIndex;
  const limit = Math.min(text.length, index + MAX_URL);
  let end = hostStart;
  while (end < limit && HOST_CHAR.test(text[end])) end++;
  if (end > hostStart && end < limit && '/?#'.includes(text[end])) {
    for (; end < limit; end++) {
      const char = text[end];
      const previous = text[end - 1];
      if (URL_STOP.test(char)) break;
      if (!isAscii(char) && isAscii(previous) && !'/=#&+_-'.includes(previous)) break;
    }
  }
  if (end >= limit && limit < text.length) return null;
  let parentheses = 0;
  let brackets = 0;
  for (let position = hostStart; position < end; position++) {
    const char = text[position];
    parentheses += char === '(' ? 1 : char === ')' ? -1 : 0;
    brackets += char === '[' ? 1 : char === ']' ? -1 : 0;
  }
  for (; end > hostStart; end--) {
    const char = text[end - 1];
    if (char === ')' && parentheses < 0) parentheses++;
    else if (char === ']' && brackets < 0) brackets++;
    else if (!URL_TRAILING.test(char)) break;
  }
  if (end === hostStart) return null;
  const raw = text.slice(index, end);
  const href = safeUrl(raw);
  return href && { node: { type: 'link', href, children: [{ type: 'text', text: raw }] }, end };
}

/** A [text](url) link, an <url> or a bare URL starting at `index` ("[", "<" or "h"), or null. */
function linkAt(text, index) {
  const char = text[index];
  if (char === '[') return parseLink(text, index);
  if (char === '<') return angleLink(text, index);
  // Not in the middle of a word ("xhttps://…").
  return ASCII_ALPHANUMERIC.test(text[index - 1] ?? '') ? null : bareLink(text, index);
}

/**
 * A run of *, _ or ~~ that may open and/or close emphasis. `_` and a single `*` follow CommonMark's
 * flanking rules, relaxed next to CJK text, where punctuation is not followed by a space; so an
 * underscore inside a word (snake_case) stays text, as does `*` in "5*(3+4)*2". Longer `*` runs and
 * `~~` only need a non-space on the inner side, so "**结论：**之后" is strong, as it was before.
 */
function delimiterRun(text, index, length) {
  const char = text[index];
  const before = text[index - 1];
  const after = text[index + length];
  const spaceBefore = before === undefined || WHITESPACE.test(before);
  const spaceAfter = after === undefined || WHITESPACE.test(after);
  let canOpen = !spaceAfter;
  let canClose = !spaceBefore;
  if (char === '_' || length === 1) {
    const punctuationBefore = !spaceBefore && PUNCTUATION.test(before);
    const punctuationAfter = !spaceAfter && PUNCTUATION.test(after);
    const cjk = (!spaceBefore && CJK.test(before)) || (!spaceAfter && CJK.test(after));
    const left = !spaceAfter && (!punctuationAfter || spaceBefore || punctuationBefore || cjk);
    const right = !spaceBefore && (!punctuationBefore || spaceAfter || punctuationAfter || cjk);
    canOpen = char === '_' ? left && (!right || punctuationBefore) : left;
    canClose = char === '_' ? right && (!left || punctuationAfter) : right;
  }
  return { type: 'delimiter', char, length, original: length, canOpen, canClose };
}

/** Splits inline text into text, code, link and delimiter-run tokens. */
function tokenize(text, inLink) {
  const tokens = [];
  let buffer = '';
  const flush = () => {
    if (buffer) tokens.push({ type: 'text', text: buffer });
    buffer = '';
  };
  const push = (token) => {
    flush();
    tokens.push(token);
  };
  let index = 0;
  while (index < text.length) {
    INLINE_SPECIAL.lastIndex = index;
    const found = INLINE_SPECIAL.exec(text);
    if (!found) {
      buffer += text.slice(index);
      break;
    }
    buffer += text.slice(index, found.index);
    index = found.index;
    const char = text[index];
    if (char === '\\') {
      const next = text[index + 1];
      // A backslash before punctuation makes it literal; at the end of a line it is a line break.
      if (next === '\n' || (next !== undefined && ESCAPABLE.test(next))) {
        buffer += next;
        index += 2;
      } else {
        buffer += char;
        index++;
      }
    } else if (char === '`') {
      const length = runLength(text, index);
      const close = codeSpanEnd(text, index + length, length);
      if (close < 0) buffer += text.slice(index, index + length);
      else push({ type: 'code', text: codeText(text.slice(index + length, close)) });
      index = close < 0 ? index + length : close + length;
    } else if (char === '*' || char === '_' || char === '~') {
      const length = runLength(text, index);
      if (char === '~' && length !== 2) buffer += text.slice(index, index + length);
      else push(delimiterRun(text, index, length));
      index += length;
    } else {
      const link = inLink ? null : linkAt(text, index); // links cannot contain links
      if (link) {
        push(link.node);
        index = link.end;
      } else {
        buffer += char;
        index++;
      }
    }
  }
  flush();
  return tokens;
}

/**
 * CommonMark's "process emphasis": each closing run is matched with the nearest earlier run of the
 * same character that can open, consuming two characters (strong) when both have two, else one (em);
 * ~~ makes del. Runs between a matched pair can no longer match. Matches are recorded on the runs.
 */
function matchEmphasis(tokens) {
  const openers = []; // indexes of runs that can still open, in order
  const floors = new Map(); // per kind of closer: openers at or below this index were ruled out
  for (let index = 0; index < tokens.length; index++) {
    const closer = tokens[index];
    if (closer.type !== 'delimiter') continue;
    if (closer.canClose) {
      const kind = closer.char + closer.canOpen + (closer.original % 3);
      while (closer.length > 0) {
        const floor = floors.get(kind) ?? -1;
        let position = openers.length - 1;
        for (; position >= 0 && openers[position] > floor; position--) {
          const opener = tokens[openers[position]];
          if (opener.char !== closer.char) continue;
          if (closer.char === '~') break;
          // The "rule of 3": *foo**bar* is one emphasis, not two.
          const sum = opener.original + closer.original;
          if (
            (opener.canClose || closer.canOpen) &&
            sum % 3 === 0 &&
            (opener.original % 3 || closer.original % 3)
          )
            continue;
          break;
        }
        if (position < 0 || openers[position] <= floor) {
          floors.set(kind, index - 1);
          break;
        }
        const opener = tokens[openers[position]];
        const used = closer.char === '~' || (opener.length >= 2 && closer.length >= 2) ? 2 : 1;
        const type = closer.char === '~' ? 'del' : used === 2 ? 'strong' : 'em';
        (opener.opens ??= []).push(type);
        (closer.closes ??= []).push(type);
        opener.length -= used;
        closer.length -= used;
        openers.length = position + (opener.length > 0 ? 1 : 0);
      }
    }
    if (closer.length > 0 && closer.canOpen) openers.push(index);
  }
}

/** Joins adjacent text nodes and drops empty ones. */
function mergeText(nodes) {
  const merged = [];
  for (const node of nodes) {
    const last = merged[merged.length - 1];
    if (node.type === 'text' && last?.type === 'text') last.text += node.text;
    else if (node.type !== 'text' || node.text) merged.push(node);
  }
  return merged;
}

/** Builds the inline tree from tokens whose emphasis has been matched. */
function buildTree(tokens) {
  const root = { children: [] };
  const stack = [root];
  for (const token of tokens) {
    const parent = stack[stack.length - 1];
    if (token.type !== 'delimiter') {
      parent.children.push(token);
      continue;
    }
    // A run closes emphasis with its first characters and opens it with its last ones.
    for (let count = token.closes?.length ?? 0; count > 0; count--) {
      const node = stack.pop();
      node.children = mergeText(node.children);
    }
    const current = stack[stack.length - 1];
    if (token.length) current.children.push({ type: 'text', text: token.char.repeat(token.length) });
    for (const type of [...(token.opens ?? [])].reverse()) {
      const node = { type, children: [] };
      stack[stack.length - 1].children.push(node);
      stack.push(node);
    }
  }
  return mergeText(root.children);
}

function inline(text, inLink) {
  const tokens = tokenize(String(text), inLink);
  matchEmphasis(tokens);
  return buildTree(tokens);
}

/** Parses inline Markdown (one paragraph, heading or table cell) into inline nodes. */
export function parseInline(text) {
  return inline(text, false);
}
