// Minimal Markdown renderer for model answers. It builds DOM nodes with createElement/textContent
// only (never innerHTML), and only turns http(s) URLs into links.
import { element } from './dom.js';

/** Appends text to node, rendering `code`, **bold** and [label](http(s)://…) links. */
function inlineText(node, text) {
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))/g;
  let previous = 0;
  for (const match of text.matchAll(pattern)) {
    node.append(document.createTextNode(text.slice(previous, match.index)));
    const value = match[0];
    if (value.startsWith('`')) node.append(element('code', '', value.slice(1, -1)));
    else if (value.startsWith('**')) node.append(element('strong', '', value.slice(2, -2)));
    else {
      const parts = value.match(/^\[([^\]]+)\]\((.+)\)$/);
      try {
        const url = new URL(parts[2]);
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
        const link = element('a', '', parts[1]);
        link.href = url.href;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        node.append(link);
      } catch {
        node.append(document.createTextNode(value));
      }
    }
    previous = match.index + value.length;
  }
  node.append(document.createTextNode(text.slice(previous)));
}

/**
 * Renders fenced code, tables, headings, rules, block quotes, lists and paragraphs into a
 * DocumentFragment.
 */
export function markdown(text) {
  const fragment = document.createDocumentFragment();
  const lines = String(text || '')
    .replace(/\r\n/g, '\n')
    .split('\n');
  const isTableRule = (line) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line || '');
  const tableCells = (line) =>
    line
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((x) => x.trim());
  // Lines that end a paragraph. Kept as it was in this refactor: "\1" refers to the list-marker group
  // of another alternative, so the last alternative matches a lone "-", "*" or "_" line instead of a
  // "---" / "***" / "___" rule, and such a rule is absorbed into the paragraph above it.
  // eslint-disable-next-line no-useless-backreference -- known quirk, preserved until it is fixed on purpose
  const specialLine = /^\s*```|^#{1,6}\s|^\s*([-*]|\d+[.)])\s|^>\s?|^\s*([-*_])(?:\s*\1){2,}\s*$/;
  const special = (line) => specialLine.test(line);
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    if (/^\s*```/.test(line)) {
      const code = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++]);
      if (i < lines.length) i++;
      const pre = element('pre');
      pre.append(element('code', '', code.join('\n')));
      fragment.append(pre);
      continue;
    }
    if (line.includes('|') && isTableRule(lines[i + 1])) {
      const wrap = element('div', 'table-wrap'),
        table = element('table'),
        head = element('thead'),
        headRow = element('tr');
      for (const cell of tableCells(line)) {
        const th = element('th');
        inlineText(th, cell);
        headRow.append(th);
      }
      head.append(headRow);
      table.append(head);
      const body = element('tbody');
      i += 2;
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
        const tr = element('tr');
        for (const cell of tableCells(lines[i++])) {
          const td = element('td');
          inlineText(td, cell);
          tr.append(td);
        }
        body.append(tr);
      }
      table.append(body);
      wrap.append(table);
      fragment.append(wrap);
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const h = element(heading[1].length <= 2 ? 'h2' : heading[1].length === 3 ? 'h3' : 'h4');
      inlineText(h, heading[2]);
      fragment.append(h);
      i++;
      continue;
    }
    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      fragment.append(element('hr'));
      i++;
      continue;
    }
    if (/^>\s?/.test(line)) {
      const quote = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) quote.push(lines[i++].replace(/^>\s?/, ''));
      const node = element('blockquote');
      inlineText(node, quote.join('\n'));
      fragment.append(node);
      continue;
    }
    const list = line.match(/^\s*([-*]|\d+[.)])\s+(.+)$/);
    if (list) {
      const ordered = /^\d/.test(list[1]);
      const ul = element(ordered ? 'ol' : 'ul');
      if (ordered) ul.start = parseInt(list[1], 10) || 1;
      while (i < lines.length) {
        const item = lines[i].match(/^\s*([-*]|\d+[.)])\s+(.+)$/);
        if (!item || /^\d/.test(item[1]) !== ordered) break;
        const li = element('li');
        inlineText(li, item[2]);
        ul.append(li);
        i++;
      }
      fragment.append(ul);
      continue;
    }
    const paragraph = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !special(lines[i]) &&
      !(lines[i].includes('|') && isTableRule(lines[i + 1]))
    )
      paragraph.push(lines[i++]);
    const p = element('p');
    inlineText(p, paragraph.join('\n'));
    fragment.append(p);
  }
  return fragment;
}
