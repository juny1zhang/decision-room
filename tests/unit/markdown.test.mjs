// The Markdown renderer for model answers: public/js/markdown-parse.js turns text into a tree and
// public/js/markdown.js builds DOM nodes from it. The DOM half runs against a minimal fake document
// whose innerHTML throws, so the tests also prove the renderer never parses HTML.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInline, parseMarkdown, safeUrl } from '../../public/js/markdown-parse.js';
import { markdown, renderBlocks } from '../../public/js/markdown.js';

// ---------------------------------------------------------------- Tree helpers

const nodes = (children) =>
  children.map((child) => (typeof child === 'string' ? { type: 'text', text: child } : child));
const code = (text) => ({ type: 'code', text });
const strong = (...children) => ({ type: 'strong', children: nodes(children) });
const em = (...children) => ({ type: 'em', children: nodes(children) });
const del = (...children) => ({ type: 'del', children: nodes(children) });
const link = (href, ...children) => ({ type: 'link', href, children: nodes(children) });
/** A bare or <angle> URL: the text as written, the href normalized. */
const url = (text, href = text) => link(href, text);
const p = (...children) => ({ type: 'paragraph', children: nodes(children) });
const heading = (level, ...children) => ({ type: 'heading', level, children: nodes(children) });
const quote = (...children) => ({ type: 'blockquote', children: nodes(children) });
const codeBlock = (text, lang = '') => ({ type: 'codeBlock', lang, text });
const hr = { type: 'hr' };
/** A list item: strings are paragraphs. */
const item = (...blocks) => blocks.map((block) => (typeof block === 'string' ? p(block) : block));
const ul = (...items) => ({ type: 'list', ordered: false, loose: false, items });
const ol = (start, ...items) => ({ type: 'list', ordered: true, start, loose: false, items });
const loose = (list) => ({ ...list, loose: true });
const cells = (...values) => values.map((value) => (value === '' ? [] : nodes([value].flat())));

// ---------------------------------------------------------------- Fake DOM

class FakeText {
  constructor(value) {
    this.value = String(value);
  }
  get textContent() {
    return this.value;
  }
}

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.className = '';
    this.dataset = {};
    this.childNodes = [];
  }
  append(...children) {
    for (const child of children)
      this.childNodes.push(typeof child === 'string' ? new FakeText(child) : child);
  }
  get textContent() {
    return this.childNodes.map((child) => child.textContent).join('');
  }
  set textContent(value) {
    this.childNodes = [new FakeText(value)];
  }
  get innerHTML() {
    throw new Error('innerHTML must not be used');
  }
  set innerHTML(_value) {
    throw new Error('innerHTML must not be used');
  }
  insertAdjacentHTML() {
    throw new Error('insertAdjacentHTML must not be used');
  }
}

globalThis.document = {
  createElement: (tagName) => new FakeElement(tagName),
  createTextNode: (value) => new FakeText(value),
  createDocumentFragment: () => new FakeElement('#fragment')
};

const escape = (value) =>
  String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

/** Serializes the fake DOM, escaping text the way a browser would. */
function html(node) {
  if (node instanceof FakeText) return escape(node.value);
  const inner = node.childNodes.map(html).join('');
  if (node.tagName === '#fragment') return inner;
  const attributes = [];
  if (node.className) attributes.push(['class', node.className]);
  for (const name of ['href', 'target', 'rel', 'title', 'start'])
    if (node[name] !== undefined) attributes.push([name, node[name]]);
  for (const [name, value] of Object.entries(node.dataset)) attributes.push(['data-' + name, value]);
  const open = [node.tagName, ...attributes.map(([name, value]) => `${name}="${escape(value)}"`)].join(' ');
  return `<${open}>${inner}</${node.tagName}>`;
}

const render = (text) => html(markdown(text));

// ---------------------------------------------------------------- What worked before keeps working

test('the constructs rendered before the parser was split out keep their structure', () => {
  const text = [
    '# 标题',
    '## 二级',
    '### 三级',
    '#### 四级',
    '',
    '第一行',
    '第二行',
    '',
    '3. 三',
    '4. 四',
    '',
    '- 甲',
    '* 乙',
    '',
    '```',
    'const a = 1;',
    '```',
    '',
    '| 方案 | 成本 |',
    '| --- | --- |',
    '| A | **低** |',
    '',
    '> 引用',
    '> 第二行',
    '',
    '`code`、**粗体** 和 [链接](https://example.com/a)'
  ].join('\n');
  assert.deepEqual(parseMarkdown(text), [
    heading(1, '标题'),
    heading(2, '二级'),
    heading(3, '三级'),
    heading(4, '四级'),
    p('第一行\n第二行'),
    ol(3, item('三'), item('四')),
    ul(item('甲'), item('乙')),
    codeBlock('const a = 1;'),
    { type: 'table', align: [null, null], head: cells('方案', '成本'), rows: [cells('A', strong('低'))] },
    quote('引用\n第二行'),
    p(code('code'), '、', strong('粗体'), ' 和 ', link('https://example.com/a', '链接'))
  ]);
  assert.equal(
    render(text),
    '<h2>标题</h2><h2>二级</h2><h3>三级</h3><h4>四级</h4><p>第一行\n第二行</p>' +
      '<ol start="3"><li>三</li><li>四</li></ol><ul><li>甲</li><li>乙</li></ul>' +
      '<pre><code>const a = 1;</code></pre>' +
      '<div class="table-wrap"><table><thead><tr><th>方案</th><th>成本</th></tr></thead>' +
      '<tbody><tr><td>A</td><td><strong>低</strong></td></tr></tbody></table></div>' +
      '<blockquote>引用\n第二行</blockquote>' +
      '<p><code>code</code>、<strong>粗体</strong> 和 ' +
      '<a href="https://example.com/a" target="_blank" rel="noopener noreferrer">链接</a></p>'
  );
});

test('parseMarkdown accepts empty input and Windows line endings', () => {
  assert.deepEqual(parseMarkdown(''), []);
  assert.deepEqual(parseMarkdown(undefined), []);
  assert.deepEqual(parseMarkdown('a\r\nb\r\n\r\nc'), [p('a\nb'), p('c')]);
});

// ---------------------------------------------------------------- Blocks

test('headings need a space after the hashes, and lose closing hashes', () => {
  assert.deepEqual(parseMarkdown('###### 六\n####### 七\n#无空格\n## 标题 ##\n## C#\n   ### 缩进'), [
    heading(6, '六'),
    p('####### 七\n#无空格'),
    heading(2, '标题'),
    heading(2, 'C#'),
    heading(3, '缩进')
  ]);
  assert.equal(render('# 一\n##### 五'), '<h2>一</h2><h4>五</h4>');
});

test('paragraphs keep their line breaks, without the spaces around each line', () => {
  assert.deepEqual(parseMarkdown('  第一行  \n\t第二行\n\n\n第二段'), [p('第一行\n第二行'), p('第二段')]);
  // A full-width space that indents Chinese text is content, not indentation.
  assert.deepEqual(parseMarkdown('\u3000\u3000首行缩进'), [p('\u3000\u3000首行缩进')]);
});

test('a rule line after a paragraph line is a rule, not part of the paragraph', () => {
  for (const rule of ['---', '***', '___', '- - -', '* * *', '_____'])
    assert.deepEqual(parseMarkdown(`段落\n${rule}\n下一段`), [p('段落'), hr, p('下一段')], rule);
  assert.deepEqual(parseMarkdown('---\n\n***'), [hr, hr]);
  // Two dashes or a lone dash are text.
  assert.deepEqual(parseMarkdown('段落\n--\n-'), [p('段落\n--\n-')]);
  assert.equal(render('a\n---'), '<p>a</p><hr></hr>');
});

test('block quotes hold inline text', () => {
  assert.deepEqual(parseMarkdown('> **注意**：一\n>二\n  > 三\n\n正文'), [
    quote(strong('注意'), '：一\n二\n三'),
    p('正文')
  ]);
});

// ---------------------------------------------------------------- Lists

test('ordered lists keep their start number and accept ")" markers', () => {
  assert.deepEqual(parseMarkdown('3. 三\n4) 四'), [ol(3, item('三'), item('四'))]);
  assert.deepEqual(parseMarkdown('0. 零'), [ol(0, item('零'))]);
  assert.deepEqual(parseMarkdown('1.5 倍\n-1 度\n1234567890. 太长'), [p('1.5 倍\n-1 度\n1234567890. 太长')]);
  assert.equal(render('7. 七'), '<ol start="7"><li>七</li></ol>');
});

test('switching between bullets and numbers starts a new list', () => {
  assert.deepEqual(parseMarkdown('- a\n1. b\n- c'), [ul(item('a')), ol(1, item('b')), ul(item('c'))]);
});

test('lists interrupt a paragraph', () => {
  assert.deepEqual(parseMarkdown('理由：\n- 快\n- 省'), [p('理由：'), ul(item('快'), item('省'))]);
});

test('lists nest by two or more spaces of indentation, or a tab', () => {
  const nested = ul(item('a', ul(item('b'))), item('c'));
  assert.deepEqual(parseMarkdown('- a\n  - b\n- c'), [nested]);
  assert.deepEqual(parseMarkdown('- a\n    - b\n- c'), [nested]);
  assert.deepEqual(parseMarkdown('- a\n\t- b\n- c'), [nested]);
  // One space is not enough: the item is a sibling.
  assert.deepEqual(parseMarkdown('- a\n - b'), [ul(item('a'), item('b'))]);
  // Two spaces nest under "1." too, although its text starts at the third column.
  assert.deepEqual(parseMarkdown('1. a\n  - b\n2. c'), [ol(1, item('a', ul(item('b'))), item('c'))]);
});

test('nested lists mix bullets and numbers over several levels', () => {
  const text = ['1. 一', '   - 甲', '     1. 子一', '     2. 子二', '   - 乙', '2. 二', '   1. 丙'].join(
    '\n'
  );
  assert.deepEqual(parseMarkdown(text), [
    ol(
      1,
      item('一', ul(item('甲', ol(1, item('子一'), item('子二'))), item('乙'))),
      item('二', ol(1, item('丙')))
    )
  ]);
  assert.equal(
    render(text),
    '<ol start="1"><li>一<ul><li>甲<ol start="1"><li>子一</li><li>子二</li></ol></li><li>乙</li></ul></li>' +
      '<li>二<ol start="1"><li>丙</li></ol></li></ol>'
  );
});

test('siblings may be indented a little differently', () => {
  assert.deepEqual(parseMarkdown('- a\n    - b\n  - c\n- d'), [
    ul(item('a', ul(item('b'), item('c'))), item('d'))
  ]);
  assert.deepEqual(parseMarkdown(' 1. a\n10. b'), [ol(1, item('a'), item('b'))]);
});

test('list items take indented and lazy continuation lines', () => {
  assert.deepEqual(parseMarkdown('- 第一点\n  补充说明\n- 第二点\n没有缩进的续行'), [
    ul(item('第一点\n补充说明'), item('第二点\n没有缩进的续行'))
  ]);
  // A lazy line continues the innermost paragraph.
  assert.deepEqual(parseMarkdown('1. a\n   - b\nc'), [ol(1, item('a', ul(item('b\nc'))))]);
  assert.equal(render('- a\nb'), '<ul><li>a\nb</li></ul>');
});

test('headings, rules, quotes, fences and tables end a list item instead of continuing it', () => {
  assert.deepEqual(parseMarkdown('- a\n## 标题'), [ul(item('a')), heading(2, '标题')]);
  assert.deepEqual(parseMarkdown('- a\n---'), [ul(item('a')), hr]);
  assert.deepEqual(parseMarkdown('- a\n> 引用'), [ul(item('a')), quote('引用')]);
  assert.deepEqual(parseMarkdown('- a\n```\nx\n```'), [ul(item('a')), codeBlock('x')]);
  assert.deepEqual(parseMarkdown('- a\n| x | y |\n|---|---|'), [
    ul(item('a')),
    { type: 'table', align: [null, null], head: cells('x', 'y'), rows: [] }
  ]);
  // After a blank line, unindented text is a new paragraph.
  assert.deepEqual(parseMarkdown('- a\n\n总结'), [ul(item('a')), p('总结')]);
});

test('blank lines between items or inside an item make a loose list', () => {
  assert.deepEqual(parseMarkdown('1. a\n\n2. b'), [loose(ol(1, item('a'), item('b')))]);
  assert.deepEqual(parseMarkdown('- a\n\n  第二段\n- b'), [loose(ul(item('a', '第二段'), item('b')))]);
  // A blank line inside a nested list makes only that list loose.
  assert.deepEqual(parseMarkdown('- a\n  - b\n\n  - c\n- d'), [
    ul(item('a', loose(ul(item('b'), item('c')))), item('d'))
  ]);
  // Trailing blank lines do not.
  assert.deepEqual(parseMarkdown('- a\n- b\n\n'), [ul(item('a'), item('b'))]);
  assert.equal(
    render('- a\n\n  第二段\n- b'),
    '<ul class="loose"><li><p>a</p><p>第二段</p></li><li><p>b</p></li></ul>'
  );
});

test('a list item holds code blocks, quotes and tables indented under it', () => {
  const text = [
    '1. 安装：',
    '   ```bash',
    '   npm install',
    '     --save',
    '   ```',
    '2. 引用：',
    '   > 注意',
    '3. 表格：',
    '   | a | b |',
    '   |---|---|',
    '   | 1 | 2 |'
  ].join('\n');
  assert.deepEqual(parseMarkdown(text), [
    ol(
      1,
      item('安装：', codeBlock('npm install\n  --save', 'bash')),
      item('引用：', quote('注意')),
      item('表格：', { type: 'table', align: [null, null], head: cells('a', 'b'), rows: [cells('1', '2')] })
    )
  ]);
});

test('a fenced block in a list item keeps code that is not indented under the item', () => {
  const text = '1. 示例\n   ```python\ndef f():\n    pass\n   ```\n2. 下一步';
  assert.deepEqual(parseMarkdown(text), [
    ol(1, item('示例', codeBlock('def f():\n    pass', 'python')), item('下一步'))
  ]);
  // A fence opened by the item's first line.
  assert.deepEqual(parseMarkdown('- ```js\n  x = 1\n  ```'), [ul(item(codeBlock('x = 1', 'js')))]);
  // Without a closing line, the code ends with the item.
  assert.deepEqual(parseMarkdown('- a\n  ```\n  code\nb'), [ul(item('a', codeBlock('code'))), p('b')]);
});

test('list items keep code spans and links, including pipes and parentheses', () => {
  const text =
    '- 运行 `a | b`，见 [文档](https://example.com/a_(b)) 或 https://example.com/c。\n- **结论：**可行';
  assert.deepEqual(parseMarkdown(text), [
    ul(
      item(
        p(
          '运行 ',
          code('a | b'),
          '，见 ',
          link('https://example.com/a_(b)', '文档'),
          ' 或 ',
          url('https://example.com/c'),
          '。'
        )
      ),
      item(p(strong('结论：'), '可行'))
    )
  ]);
});

test('a list nested deeper than the limit stays text', () => {
  const text = Array.from({ length: 20 }, (_, level) => ' '.repeat(level * 2) + '- ' + level).join('\n');
  let list = parseMarkdown(text)[0];
  let depth = 0;
  while (list?.type === 'list') {
    depth++;
    list = list.items[0][1];
  }
  assert.equal(depth, 12);
});

// ---------------------------------------------------------------- Code blocks

test('fenced code keeps its text verbatim and records the language', () => {
  assert.deepEqual(parseMarkdown('```TypeScript title="a.ts"\nconst a = **b** <i>;\n\n  [x](y)\n```\n后文'), [
    codeBlock('const a = **b** <i>;\n\n  [x](y)', 'TypeScript'),
    p('后文')
  ]);
  assert.equal(render('```py\nprint(1)\n```'), '<pre data-lang="py"><code>print(1)</code></pre>');
});

test('a fence closes only with a fence at least as long and without a language', () => {
  assert.deepEqual(parseMarkdown('````md\n```js\nx\n```\n````'), [codeBlock('```js\nx\n```', 'md')]);
  // An unclosed fence runs to the end, without its trailing blank lines.
  assert.deepEqual(parseMarkdown('段落\n```\na\n\n'), [p('段落'), codeBlock('a')]);
  // Backticks in the "language" mean inline code, not a fence.
  assert.deepEqual(parseMarkdown('```npm install```\n下一行'), [p(code('npm install'), '\n下一行')]);
});

test('an indented fence removes that indentation from its lines', () => {
  assert.deepEqual(parseMarkdown('  ```\n  a\n    b\nc\n  ```'), [codeBlock('a\n  b\nc')]);
});

// ---------------------------------------------------------------- Tables

test('tables take their column alignment from the separator row', () => {
  assert.deepEqual(parseMarkdown('| 左 | 中 | 右 | 默认 |\n|:--|:-:|--:|---|\n| 1 | 2 | 3 | 4 |'), [
    {
      type: 'table',
      align: ['left', 'center', 'right', null],
      head: cells('左', '中', '右', '默认'),
      rows: [cells('1', '2', '3', '4')]
    }
  ]);
  assert.equal(
    render('a | b\n:-: | -:\n1 | 2'),
    '<div class="table-wrap"><table><thead><tr><th data-align="center">a</th><th data-align="right">b</th></tr>' +
      '</thead><tbody><tr><td data-align="center">1</td><td data-align="right">2</td></tr></tbody></table></div>'
  );
});

test('pipes inside code spans or escaped with a backslash stay in the cell', () => {
  assert.deepEqual(parseMarkdown('| 命令 | 说明 |\n|---|---|\n| `ls \\| wc -l` | a \\| b `x|y` |'), [
    {
      type: 'table',
      align: [null, null],
      head: cells('命令', '说明'),
      rows: [cells(code('ls | wc -l'), ['a | b ', code('x|y')])]
    }
  ]);
  // An unmatched backtick does not hide the pipes after it.
  assert.deepEqual(parseMarkdown('a | b\n---|---\n` | c')[0].rows, [cells('`', 'c')]);
});

test('table rows are padded to the header and end at a blank line or a line without pipes', () => {
  assert.deepEqual(parseMarkdown('段落\n| a | b |\n|---|---|\n| 1 |\n| 2 | 3 | 4 |\n无竖线\n\n| x |'), [
    p('段落'),
    {
      type: 'table',
      align: [null, null],
      head: cells('a', 'b'),
      rows: [cells('1', ''), cells('2', '3', '4')]
    },
    p('无竖线'),
    p('| x |')
  ]);
  // A separator needs a pipe and dashes in every cell.
  assert.deepEqual(parseMarkdown('a | b\n---'), [p('a | b'), hr]);
  assert.deepEqual(parseMarkdown('a | b\n|--|x|'), [p('a | b\n|--|x|')]);
});

// ---------------------------------------------------------------- Inline content

test('code spans match backtick runs of the same length', () => {
  assert.deepEqual(
    parseInline('`a` ``b ` c`` ` `` `'),
    nodes([code('a'), ' ', code('b ` c'), ' ', code('``')])
  );
  // One space is trimmed from both ends only when both ends have one and the code is not all spaces.
  assert.deepEqual(parseInline('`  a ` `  `'), nodes([code(' a'), ' ', code('  ')]));
  assert.deepEqual(parseInline('`未闭合 和 ``不匹配'), nodes(['`未闭合 和 ``不匹配']));
  // Code spans stay on one line.
  assert.deepEqual(parseMarkdown('`第一行\n第二行`'), [p('`第一行\n第二行`')]);
  // Markdown inside code stays text.
  assert.deepEqual(parseInline('`**a** [b](https://c.com)`'), [code('**a** [b](https://c.com)')]);
});

test('strong and emphasis use asterisks or underscores, but not underscores inside words', () => {
  assert.deepEqual(
    parseInline('**粗** *斜* _斜_ __粗__'),
    nodes([strong('粗'), ' ', em('斜'), ' ', em('斜'), ' ', strong('粗')])
  );
  assert.deepEqual(
    parseInline('snake_case_name 和 __init__.py 以外的 a_b'),
    nodes(['snake_case_name 和 ', strong('init'), '.py 以外的 a_b'])
  );
  assert.deepEqual(parseInline('中文_不是_强调'), nodes(['中文_不是_强调']));
  assert.deepEqual(
    parseInline('**a *b* c** ***d*** *e **f** g*'),
    nodes([strong('a ', em('b'), ' c'), ' ', em(strong('d')), ' ', em('e ', strong('f'), ' g')])
  );
});

test('strong closes after CJK punctuation, as it did before', () => {
  assert.deepEqual(
    parseInline('**结论：**选择 A。**「重点」**在于成本'),
    nodes([strong('结论：'), '选择 A。', strong('「重点」'), '在于成本'])
  );
  assert.deepEqual(parseInline('*注：*见下文'), nodes([em('注：'), '见下文']));
});

test('asterisks in arithmetic and lone delimiters stay text', () => {
  for (const text of [
    '2 * 3 * 4',
    '5*(3+4)*2',
    'a * b*',
    '** 不是粗体 **',
    '密码 ****',
    '~单个波浪线~',
    '~~~三个~~~',
    '3~5 天'
  ])
    assert.deepEqual(parseInline(text), nodes([text]), text);
});

test('strikethrough uses two tildes', () => {
  assert.deepEqual(
    parseInline('~~删除~~ 和 **~~都有~~**'),
    nodes([del('删除'), ' 和 ', strong(del('都有'))])
  );
});

test('a backslash makes punctuation literal and ends a line', () => {
  assert.deepEqual(
    parseInline('\\*不是斜体\\* \\_ \\[a](https://b.com) C:\\Users \\'),
    nodes(['*不是斜体* _ [a](', url('https://b.com', 'https://b.com/'), ') C:\\Users \\'])
  );
  assert.deepEqual(parseInline('第一行\\\n第二行'), nodes(['第一行\n第二行']));
});

test('emphasis may span the lines of a paragraph', () => {
  assert.deepEqual(parseMarkdown('**第一行\n第二行**'), [p(strong('第一行\n第二行'))]);
});

// ---------------------------------------------------------------- Links

test('links may hold balanced parentheses, formatting and a title', () => {
  assert.deepEqual(
    parseInline('[Foo](https://en.wikipedia.org/wiki/Foo_(bar)) 后'),
    nodes([link('https://en.wikipedia.org/wiki/Foo_(bar)', 'Foo'), ' 后'])
  );
  assert.deepEqual(parseInline('[a](https://x.com/a)b)'), nodes([link('https://x.com/a', 'a'), 'b)']));
  assert.deepEqual(parseInline('[**粗** `code` [x]](https://x.com "标题")'), [
    { ...link('https://x.com/', strong('粗'), ' ', code('code'), ' [x]'), title: '标题' }
  ]);
  assert.deepEqual(parseInline('[a](<https://x.com/a b>)'), [link('https://x.com/a%20b', 'a')]);
  assert.deepEqual(parseInline('[`]`](https://x.com)'), [link('https://x.com/', code(']'))]);
  // Unbalanced, empty or unclosed links stay text (the URL inside may still become a link).
  assert.deepEqual(parseInline('[a](https://x.com/(b)'), nodes(['[a](', url('https://x.com/(b)')]));
  assert.deepEqual(
    parseInline('[](https://x.com) [a]'),
    nodes(['[](', url('https://x.com', 'https://x.com/'), ') [a]'])
  );
  assert.equal(
    render('[文档](https://example.com/docs "说明")'),
    '<p><a href="https://example.com/docs" target="_blank" rel="noopener noreferrer" title="说明">文档</a></p>'
  );
});

test('<url> links show the URL without the brackets', () => {
  assert.deepEqual(
    parseInline('见 <https://example.com/a?b=1>。'),
    nodes(['见 ', url('https://example.com/a?b=1'), '。'])
  );
  assert.deepEqual(parseInline('<https://example.com>'), [
    url('https://example.com', 'https://example.com/')
  ]);
});

test('bare URLs become links without the punctuation that ends the sentence', () => {
  for (const mark of ['。', '，', '、', '；', '：', '！', '？', ',', '.', ';', ':', '!', '?'])
    assert.deepEqual(
      parseInline(`见 https://example.com/a${mark}下文`),
      nodes(['见 ', url('https://example.com/a'), mark + '下文']),
      mark
    );
  assert.deepEqual(
    parseInline('网址 https://example.com/a?b=1&c=2#d.'),
    nodes(['网址 ', url('https://example.com/a?b=1&c=2#d'), '.'])
  );
});

test('an unbalanced closing parenthesis stays outside a bare URL', () => {
  assert.deepEqual(
    parseInline('(see https://example.com/a)'),
    nodes(['(see ', url('https://example.com/a'), ')'])
  );
  assert.deepEqual(
    parseInline('(https://en.wikipedia.org/wiki/Foo_(bar)).'),
    nodes(['(', url('https://en.wikipedia.org/wiki/Foo_(bar)'), ').'])
  );
  assert.deepEqual(
    parseInline('（来源：https://example.com/a）'),
    nodes(['（来源：', url('https://example.com/a'), '）'])
  );
  assert.deepEqual(parseInline('[https://example.com/a]'), nodes(['[', url('https://example.com/a'), ']']));
});

test('a bare URL ends where Chinese text or a closing quote follows it', () => {
  assert.deepEqual(
    parseInline('详见https://example.com/docs了解更多'),
    nodes(['详见', url('https://example.com/docs'), '了解更多'])
  );
  assert.deepEqual(
    parseInline('网站https://example.com中文'),
    nodes(['网站', url('https://example.com', 'https://example.com/'), '中文'])
  );
  assert.deepEqual(
    parseInline('https://zh.wikipedia.org/wiki/A#历史 https://example.com/a?下文'),
    nodes([
      url('https://zh.wikipedia.org/wiki/A#历史', 'https://zh.wikipedia.org/wiki/A#%E5%8E%86%E5%8F%B2'),
      ' ',
      url('https://example.com/a'),
      '?下文'
    ])
  );
  assert.deepEqual(parseInline('“https://example.com/a”'), nodes(['“', url('https://example.com/a'), '”']));
  // Non-ASCII path segments stay in the URL.
  assert.deepEqual(
    parseInline('https://zh.wikipedia.org/wiki/北京 和 https://example.com/?q=中文'),
    nodes([
      url('https://zh.wikipedia.org/wiki/北京', 'https://zh.wikipedia.org/wiki/%E5%8C%97%E4%BA%AC'),
      ' 和 ',
      url('https://example.com/?q=中文', 'https://example.com/?q=%E4%B8%AD%E6%96%87')
    ])
  );
});

test('bare URLs inside emphasis, code and words', () => {
  assert.deepEqual(
    parseInline('**https://example.com/a**，_https://example.com/a_b_'),
    nodes([strong(url('https://example.com/a')), '，', em(url('https://example.com/a_b'))])
  );
  assert.deepEqual(
    parseInline('`https://example.com` xhttps://example.com HTTPS://EXAMPLE.COM'),
    nodes([
      code('https://example.com'),
      ' xhttps://example.com ',
      url('HTTPS://EXAMPLE.COM', 'https://example.com/')
    ])
  );
  assert.deepEqual(
    parseInline('https:// 和 https://. 和 http://localhost:41710'),
    nodes(['https:// 和 https://. 和 ', url('http://localhost:41710', 'http://localhost:41710/')])
  );
});

// ---------------------------------------------------------------- Safety

test('safeUrl accepts absolute http(s) URLs only', () => {
  assert.equal(safeUrl('https://example.com/a b'), 'https://example.com/a%20b');
  assert.equal(safeUrl('HTTP://Example.com'), 'http://example.com/');
  for (const value of [
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    ' javascript:alert(1)',
    'java\tscript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    'mailto:a@b.com',
    '//example.com',
    '/relative',
    '#anchor',
    ''
  ])
    assert.equal(safeUrl(value), null, value);
});

test('links to anything but http(s) stay inert text', () => {
  for (const text of [
    '[点我](javascript:alert(1))',
    '[点我](JaVaScRiPt:alert(1))',
    '[点我](data:text/html;base64,PHNjcmlwdD4=)',
    '[点我](vbscript:msgbox(1))',
    '[点我](/relative)',
    '[点我](<javascript:alert(1)>)',
    '<javascript:alert(1)>',
    '<data:text/html,x>',
    'javascript:alert(1)',
    '&#106;avascript:alert(1)'
  ]) {
    const tree = parseInline(text);
    assert.ok(
      tree.every((node) => node.type === 'text'),
      `${text} → ${JSON.stringify(tree)}`
    );
    assert.equal(tree.map((node) => node.text).join(''), text);
    assert.ok(!render(text).includes('<a'), text);
  }
});

test('raw HTML stays text', () => {
  const text = '<script>alert(1)</script>\n<img src=x onerror="alert(1)"> <b>粗</b>\n\n<div>块</div>';
  assert.deepEqual(parseMarkdown(text), [
    p('<script>alert(1)</script>\n<img src=x onerror="alert(1)"> <b>粗</b>'),
    p('<div>块</div>')
  ]);
  assert.equal(
    render(text),
    '<p>&lt;script&gt;alert(1)&lt;/script&gt;\n&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &lt;b&gt;粗&lt;/b&gt;</p>' +
      '<p>&lt;div&gt;块&lt;/div&gt;</p>'
  );
  // In code, link text, table cells and code languages too.
  assert.equal(
    render('```<img src=x>\n<b>\n```\n\n| <i>x</i> |\n|---|\n\n[<b>a</b>](https://x.com)'),
    '<pre data-lang="&lt;img"><code>&lt;b&gt;</code></pre>' +
      '<div class="table-wrap"><table><thead><tr><th>&lt;i&gt;x&lt;/i&gt;</th></tr></thead><tbody></tbody></table></div>' +
      '<p><a href="https://x.com/" target="_blank" rel="noopener noreferrer">&lt;b&gt;a&lt;/b&gt;</a></p>'
  );
});

test('the renderer checks link targets again and skips unknown nodes', () => {
  // The parser never produces these; the renderer stays safe anyway.
  const tree = [
    p(
      link('javascript:alert(1)', '文字'),
      { type: 'image', src: 'https://x.com/a.png' },
      link('https://x.com', 'x')
    ),
    { type: 'html', value: '<script>alert(1)</script>' }
  ];
  assert.equal(
    html(renderBlocks(tree)),
    '<p>文字<a href="https://x.com/" target="_blank" rel="noopener noreferrer">x</a></p>'
  );
});

// ---------------------------------------------------------------- Robustness

test('hostile input is parsed in reasonable time', () => {
  const inputs = [
    '*a '.repeat(20000),
    '_a_ b_'.repeat(10000),
    '['.repeat(20000),
    '[a'.repeat(20000),
    '` '.repeat(20000),
    'https://a.com/' + ')'.repeat(20000),
    '<https://a.com'.repeat(5000),
    '- a\n'.repeat(20000),
    '- a\n' + 'b\n'.repeat(20000),
    '- a\n  ```\n'.repeat(2000),
    '- a\n  ```js\n'.repeat(5000),
    Array.from({ length: 2000 }, (_, level) => ' '.repeat(level) + '- a').join('\n'),
    'a' + ' '.repeat(50000) + 'b',
    '# a' + ' '.repeat(50000) + 'b',
    '` ' + 'a'.repeat(50000) + '`',
    '[a](b'.repeat(20000),
    '[a](<'.repeat(20000),
    'https://%'.repeat(10000)
  ];
  for (const text of inputs) {
    const started = performance.now();
    parseMarkdown(text);
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 2000, `${JSON.stringify(text.slice(0, 20))}… took ${Math.round(elapsed)} ms`);
  }
});
