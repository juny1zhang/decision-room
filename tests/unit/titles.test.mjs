import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUGGESTION_OPENINGS, TITLE_LIMIT, clipTitle, defaultTitle, readTitle } from '../../src/titles.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const segmenter = new Intl.Segmenter('zh', { granularity: 'grapheme' });
const visibleLength = (text) => [...segmenter.segment(text)].length;

/** The prompts of the suggestion buttons on the empty page, as the composer fills them in. */
function suggestionTemplates() {
  const html = readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  return [...html.matchAll(/data-example="([^"]*)"/g)].map((match) => match[1].replace(/\\n/g, '\n'));
}

test('a default title is the first non-empty line with its whitespace collapsed', () => {
  assert.equal(defaultTitle('  \n\r\n \t \n  要不要   换工作？ \n 第二行'), '要不要 换工作？');
  assert.equal(defaultTitle('第一行\r\n第二行'), '第一行');
  assert.equal(defaultTitle('第一行\u2028第二行'), '第一行');
  assert.equal(defaultTitle('全角\u3000空格\u00a0和\ttab'), '全角 空格 和 tab');
  assert.equal(defaultTitle('响铃\u0007字符\u0000与\u0085控制'), '响铃 字符 与 控制');
  assert.equal(defaultTitle(''), '');
  assert.equal(defaultTitle(' \n\t\n '), '');
});

test('a long first line is cut to 38 visible characters, never inside one', () => {
  const exact = '决'.repeat(38);
  assert.equal(defaultTitle(exact), exact, 'Exactly 38 characters stay whole');
  assert.equal(defaultTitle('决'.repeat(39)), '决'.repeat(37) + '…');
  const family = '👨‍👩‍👧‍👦';
  const emoji = defaultTitle(family.repeat(50));
  assert.equal(emoji, family.repeat(37) + '…', 'An emoji sequence is one character');
  const accented = defaultTitle('e\u0301'.repeat(40));
  assert.equal(accented, 'e\u0301'.repeat(37) + '…', 'A combining mark stays with its letter');
  for (const title of [emoji, accented, defaultTitle('a'.repeat(500))])
    assert.equal(visibleLength(title), 38);
  // Spaces and separators the cut leaves at the end go before the ellipsis.
  assert.equal(defaultTitle('甲'.repeat(36) + ' / 乙乙乙'), '甲'.repeat(36) + '…');
  assert.equal(defaultTitle('甲'.repeat(36) + '，乙乙乙'), '甲'.repeat(36) + '…');
  assert.equal(clipTitle('一二三四五', 3), '一二…');
  assert.equal(clipTitle('一二三', 3), '一二三');
});

test('every suggestion on the page starts with an opening the titles know, and no other is listed', () => {
  const templates = suggestionTemplates();
  assert.ok(templates.length > 0, 'public/index.html has suggestions');
  const openings = templates.map((template) => template.split('\n')[0]);
  assert.deepEqual([...openings].sort(), [...SUGGESTION_OPENINGS].sort());
});

test('a question started from a suggestion is titled by what was filled in', () => {
  const [choice, trip, review] = suggestionTemplates();
  const filled = (template, ...values) => {
    let index = 0;
    return template.replace(/：$/gm, (colon) => colon + (values[index++] ?? ''));
  };
  assert.equal(
    defaultTitle(filled(choice, '去上海工作', '留在北京', '收入、家人、成长')),
    '去上海工作 / 留在北京 / 收入、家人、成长'
  );
  assert.equal(defaultTitle(filled(trip, '高铁去杭州', '自驾去黄山')), '高铁去杭州 / 自驾去黄山');
  assert.equal(
    defaultTitle(
      filled(review, '单体应用，日活十万，发布要两小时', '拆成三个服务', '三个人两个月，预算有限')
    ),
    '单体应用，日活十万，发布要两小时 / 拆成三个服务 / 三个人两个月，预算…'
  );
  // Two rooms started from the same suggestion get different titles.
  assert.notEqual(defaultTitle(filled(choice, '读博')), defaultTitle(filled(choice, '工作')));
  // Nothing filled in: the opening line is the title.
  assert.equal(
    defaultTitle(choice),
    SUGGESTION_OPENINGS.find((opening) => choice.startsWith(opening))
  );
  // Text written on the opening line, or below the fields instead of after them, counts as filled in.
  const opening = choice.split('\n')[0];
  assert.equal(defaultTitle(`${opening}我该不该换工作？\n\n选项 A：\n选项 B：`), '我该不该换工作？');
  assert.equal(defaultTitle(`${opening}\n\n选项 A：\n读研\n选项 B：\n工作`), '读研 / 工作');
  // An ASCII label is a field too; a web address or a time is not a label.
  assert.equal(
    defaultTitle(`${opening}\nOption A: stay\nhttps://a.cn/x\n10:30 出发`),
    'stay / https://a.cn/x / 10:30 出发'
  );
});

test('a new title is trimmed and must hold 1 to 80 visible characters without control characters', () => {
  assert.equal(readTitle('  新的标题  '), '新的标题');
  assert.equal(readTitle('\u3000全角空格\u3000'), '全角空格');
  assert.equal(readTitle('标题\n'), '标题', 'A line break at an end is trimmed away');
  assert.equal(readTitle('A   B'), 'A   B', 'Spaces inside stay as written');
  const longest = '题'.repeat(TITLE_LIMIT);
  assert.equal(readTitle(longest), longest);
  const family = '👨‍👩‍👧‍👦'.repeat(TITLE_LIMIT);
  assert.equal(readTitle(family), family, 'An emoji sequence counts as one character');

  const cases = [
    [undefined, '讨论标题不能为空。'],
    [null, '讨论标题不能为空。'],
    [42, '讨论标题不能为空。'],
    [['标题'], '讨论标题不能为空。'],
    ['', '讨论标题不能为空。'],
    [' \t\n\u3000', '讨论标题不能为空。'],
    ['第一行\n第二行', '讨论标题不能包含换行或其他控制字符。'],
    ['制表\t符', '讨论标题不能包含换行或其他控制字符。'],
    ['空\u0000字符', '讨论标题不能包含换行或其他控制字符。'],
    ['删除\u007f符', '讨论标题不能包含换行或其他控制字符。'],
    ['下一行\u0085符', '讨论标题不能包含换行或其他控制字符。'],
    ['行\u2028分隔', '讨论标题不能包含换行或其他控制字符。'],
    ['题'.repeat(TITLE_LIMIT + 1), '讨论标题不能超过 80 个字符。'],
    ['e' + '\u0301'.repeat(2000), '讨论标题不能超过 80 个字符。']
  ];
  for (const [value, message] of cases)
    assert.throws(() => readTitle(value), { message, status: 400 }, JSON.stringify(value));
});
