// Markdown renderer for model answers. js/markdown-parse.js turns the text into a tree; this module
// builds DOM nodes from it with createElement and textContent only (never innerHTML), so raw HTML in
// an answer stays text. Only http(s) URLs become links, and they open in a new tab.
import { element } from './dom.js';
import { parseMarkdown, safeUrl } from './markdown-parse.js';

/** Headings stay small inside a message: levels 1–2 render as h2, 3 as h3 and 4–6 as h4. */
const HEADING_TAGS = ['h2', 'h2', 'h3', 'h4', 'h4', 'h4'];
const EMPHASIS_TAGS = { strong: 'strong', em: 'em', del: 'del' };

/** Appends inline nodes (text, code, emphasis, links) to `parent` and returns it. */
function appendInline(parent, nodes) {
  for (const node of nodes) {
    if (node.type === 'text') parent.append(document.createTextNode(node.text));
    else if (node.type === 'code') parent.append(element('code', '', node.text));
    else if (node.type === 'link') {
      const href = safeUrl(node.href);
      if (!href) {
        appendInline(parent, node.children);
        continue;
      }
      const link = element('a');
      link.href = href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      if (node.title) link.title = node.title;
      parent.append(appendInline(link, node.children));
    } else if (Object.hasOwn(EMPHASIS_TAGS, node.type))
      parent.append(appendInline(element(EMPHASIS_TAGS[node.type]), node.children));
  }
  return parent;
}

function renderList(block) {
  const list = element(block.ordered ? 'ol' : 'ul', block.loose ? 'loose' : '');
  if (block.ordered) list.start = block.start;
  for (const blocks of block.items) {
    const item = element('li');
    for (const child of blocks) {
      // Items of a tight list hold their text directly; a loose list keeps paragraphs apart.
      if (child.type === 'paragraph' && !block.loose) appendInline(item, child.children);
      else item.append(renderBlock(child));
    }
    list.append(item);
  }
  return list;
}

function tableRow(tag, cells, align) {
  const row = element('tr');
  cells.forEach((cell, index) => {
    const node = appendInline(element(tag), cell);
    if (align[index]) node.dataset.align = align[index];
    row.append(node);
  });
  return row;
}

function renderTable(block) {
  const wrap = element('div', 'table-wrap');
  const table = element('table');
  const head = element('thead');
  const body = element('tbody');
  head.append(tableRow('th', block.head, block.align));
  for (const row of block.rows) body.append(tableRow('td', row, block.align));
  table.append(head, body);
  wrap.append(table);
  return wrap;
}

function renderBlock(block) {
  switch (block.type) {
    case 'heading':
      return appendInline(element(HEADING_TAGS[block.level - 1]), block.children);
    case 'paragraph':
      return appendInline(element('p'), block.children);
    case 'blockquote':
      return appendInline(element('blockquote'), block.children);
    case 'codeBlock': {
      const pre = element('pre');
      // app.css shows the language as a small caption; there is no highlighting.
      if (block.lang) pre.dataset.lang = block.lang;
      pre.append(element('code', '', block.text));
      return pre;
    }
    case 'hr':
      return element('hr');
    case 'list':
      return renderList(block);
    case 'table':
      return renderTable(block);
    default:
      return document.createTextNode('');
  }
}

/** Renders block nodes from parseMarkdown into a DocumentFragment. */
export function renderBlocks(blocks) {
  const fragment = document.createDocumentFragment();
  for (const block of blocks) fragment.append(renderBlock(block));
  return fragment;
}

/** Renders Markdown text into a DocumentFragment. */
export function markdown(text) {
  return renderBlocks(parseMarkdown(text));
}
