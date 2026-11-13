import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exportRoom, localDateTime } from '../../src/export.mjs';
import { stageName } from '../../src/messages.mjs';
import { savedConfiguration } from '../../src/validation.mjs';

// Exports show local times; this test process uses a fixed time zone.
process.env.TZ = 'Asia/Shanghai';

/** Runs `callback` with the process in time zone `zone`. */
function inTimeZone(zone, callback) {
  const previous = process.env.TZ;
  process.env.TZ = zone;
  try {
    callback();
  } finally {
    process.env.TZ = previous;
  }
}

test('a version 1 room exports with its Codex summary and no stray model line', () => {
  const date = '2026-01-01T00:00:00.000Z';
  const room = {
    id: '00000000-0000-4000-8000-000000000001',
    createdAt: date,
    updatedAt: date,
    title: '旧讨论',
    context: '共同预算 200 元',
    messages: [
      { id: '1', role: 'user', stage: 'question', text: '原来的问题', createdAt: date },
      { id: '2', role: 'summary', stage: 'summary', text: '原来的归纳', model: 'codex', createdAt: date }
    ]
  };
  assert.equal(
    exportRoom(room),
    '# 旧讨论\n\n创建：2026-01-01 08:00（UTC+08:00）\n\n' +
      '## 共享背景\n\n共同预算 200 元\n\n' +
      '## 你 · 问题 · 2026-01-01 08:00（UTC+08:00）\n\n原来的问题\n\n' +
      '## 决策归纳（Codex） · 讨论总结 · 2026-01-01 08:00（UTC+08:00）\n\n原来的归纳\n\n'
  );
});

test('a three-participant room exports each round setting, speaker, stage, time and model', () => {
  const date = '2026-02-02T00:00:00.000Z';
  const debate = {
    mode: 'debate',
    participants: ['cursor', 'claude', 'codex'],
    moderator: 'cursor',
    settings: {
      cursor: { model: 'mock-cursor[context=1m]', reasoning: '', capability: 'plan' },
      claude: { model: 'sonnet', reasoning: 'medium', capability: 'risk' },
      codex: { model: '', reasoning: 'high', capability: 'verify' }
    },
    webSearch: true
  };
  const both = {
    mode: 'both',
    participants: ['codex', 'claude'],
    moderator: 'codex',
    settings: {
      codex: { model: '', reasoning: '', capability: 'compare' },
      claude: { model: '', reasoning: '', capability: 'general' }
    },
    webSearch: false
  };
  const message = (role, stage, text, extra = {}) => ({
    id: text,
    role,
    stage,
    text,
    createdAt: date,
    ...extra
  });
  const room = {
    id: '00000000-0000-4000-8000-000000000002',
    createdAt: date,
    updatedAt: date,
    title: '三方讨论',
    context: '',
    configuration: both,
    messages: [
      message('user', 'question', '第一个问题', { configuration: debate }),
      message('cursor', 'analysis', 'Cursor 的分析', {
        provider: 'cursor',
        model: 'mock-cursor[context=1m]'
      }),
      message('claude', 'review', 'Claude 的审查', { provider: 'claude', model: 'claude-sonnet-4-5' }),
      message('system', 'error', 'Codex 审查失败：超时'),
      message('summary', 'summary', '主持人归纳', { provider: 'cursor', model: 'mock-cursor[context=1m]' }),
      message('user', 'question', '追问', { configuration: both, createdAt: '2026-02-02T13:45:30.000Z' }),
      message('codex', 'analysis', 'Codex 的回答', { provider: 'codex', model: 'gpt-5' })
    ]
  };
  const time = '2026-02-02 08:00（UTC+08:00）';
  assert.equal(
    exportRoom(room),
    `# 三方讨论\n\n创建：${time}\n\n` +
      `## 你 · 问题 · ${time}\n\n` +
      '本轮设置 · 联合讨论 · 网页检索开启 · 主持人 Cursor\n\n' +
      '- Cursor · mock-cursor[context=1m] · 方案规划\n' +
      '- Claude · sonnet · 风险审查 · 推理强度 medium\n' +
      '- Codex · CLI 默认模型 · 事实核查 · 推理强度 high\n\n' +
      '第一个问题\n\n' +
      `## Cursor · 独立分析 · ${time}\n\n模型 · mock-cursor[context=1m]\n\nCursor 的分析\n\n` +
      `## Claude · 交叉审查 · ${time}\n\n模型 · claude-sonnet-4-5\n\nClaude 的审查\n\n` +
      `## 状态说明 · 提示 · ${time}\n\nCodex 审查失败：超时\n\n` +
      `## 决策归纳（Cursor） · 讨论总结 · ${time}\n\n模型 · mock-cursor[context=1m]\n\n主持人归纳\n\n` +
      '## 你 · 问题 · 2026-02-02 21:45（UTC+08:00）\n\n' +
      '本轮设置 · 分别回答 · 网页检索关闭\n\n' +
      '- Codex · CLI 默认模型 · 方案比较\n' +
      '- Claude · CLI 默认模型 · 综合分析\n\n' +
      '追问\n\n' +
      `## Codex · 独立分析 · ${time}\n\n模型 · gpt-5\n\nCodex 的回答\n\n`
  );
});

test('a goal-mode room exports its proposals, each version of the plan, the verdicts and the final plan', () => {
  const date = '2026-02-02T00:00:00.000Z';
  const time = '2026-02-02 08:00（UTC+08:00）';
  const goal = {
    mode: 'goal',
    participants: ['codex', 'claude'],
    moderator: 'claude',
    settings: {
      codex: { model: '', reasoning: '', capability: 'plan' },
      claude: { model: 'sonnet', reasoning: '', capability: 'general' }
    },
    webSearch: false,
    maxRounds: 4
  };
  const turnId = '00000000-0000-4000-8000-0000000000aa';
  const message = (role, stage, text, extra = {}) => ({
    id: text,
    turnId,
    role,
    stage,
    text,
    createdAt: date,
    ...extra
  });
  const answer = (provider, stage, text, extra) =>
    message(provider, stage, text, { provider, model: `${provider}-m`, ...extra });
  const draft = (version, text) =>
    message('summary', 'draft', text, { provider: 'claude', model: 'sonnet', version, cap: 4 });
  const room = {
    id: '00000000-0000-4000-8000-000000000004',
    createdAt: date,
    title: '目标',
    context: '',
    messages: [
      { ...message('user', 'question', '三个月内上线', { configuration: goal }), id: turnId },
      answer('codex', 'proposal', 'Codex 的方案'),
      answer('claude', 'proposal', 'Claude 的方案'),
      draft(1, '方案一'),
      answer('codex', 'feedback', '还缺测试\n结论：需修改', { version: 1, verdict: 'revise' }),
      draft(2, '方案二'),
      answer('codex', 'feedback', '可以\n结论：认可', { version: 2, verdict: 'approve' }),
      message('system', 'notice', '全员认可方案 v2，目标模式结束。')
    ]
  };
  assert.equal(
    exportRoom(room),
    `# 目标\n\n创建：${time}\n\n` +
      `## 你 · 问题 · ${time}\n\n` +
      '本轮设置 · 目标模式 · 网页检索关闭 · 主持人 Claude · 最多 4 版\n\n' +
      '- Codex · CLI 默认模型 · 方案规划\n- Claude · sonnet · 综合分析\n\n三个月内上线\n\n' +
      `## Codex · 独立方案 · ${time}\n\n模型 · codex-m\n\nCodex 的方案\n\n` +
      `## Claude · 独立方案 · ${time}\n\n模型 · claude-m\n\nClaude 的方案\n\n` +
      `## 主持人（Claude） · 方案 v1 · ${time}\n\n模型 · sonnet\n\n方案一\n\n` +
      `## Codex · 评审方案 v1（需修改） · ${time}\n\n模型 · codex-m\n\n还缺测试\n结论：需修改\n\n` +
      `## 主持人（Claude） · 最终方案 v2 · ${time}\n\n模型 · sonnet\n\n方案二\n\n` +
      `## Codex · 评审方案 v2（认可） · ${time}\n\n模型 · codex-m\n\n可以\n结论：认可\n\n` +
      `## 状态说明 · 提示 · ${time}\n\n全员认可方案 v2，目标模式结束。\n\n`
  );
  // Without the approval, no version is final; a version or verdict edited away falls back to the stage.
  const open = { ...room, messages: room.messages.slice(0, -2) };
  assert.ok(!exportRoom(open).includes('最终方案'));
  assert.ok(exportRoom(open).includes('## 主持人（Claude） · 方案 v2 · '));
  const edited = {
    ...room,
    messages: [message('summary', 'draft', '无版本'), answer('codex', 'feedback', '无结论', { version: 3 })]
  };
  assert.ok(exportRoom(edited).includes('## 主持人（Codex） · 方案 · '));
  assert.ok(exportRoom(edited).includes('## Codex · 评审方案 v3（需修改） · '));
});

test('stages are named in Chinese; unknown stages keep their stored name', () => {
  const names = ['question', 'analysis', 'review', 'summary', 'notice', 'error'].map(stageName);
  assert.deepEqual(names, ['问题', '独立分析', '交叉审查', '讨论总结', '提示', '提示']);
  assert.deepEqual(['proposal', 'draft', 'feedback'].map(stageName), ['独立方案', '方案', '评审']);
  assert.equal(stageName('custom'), 'custom');
  assert.equal(stageName('toString'), 'toString');
  assert.equal(stageName(undefined), '');
});

test('times are local with their UTC offset, including half hours and daylight saving time', () => {
  assert.equal(localDateTime('2026-03-02T01:15:59.000Z'), '2026-03-02 09:15（UTC+08:00）');
  inTimeZone('America/New_York', () => {
    assert.equal(localDateTime('2026-01-15T17:05:00.000Z'), '2026-01-15 12:05（UTC-05:00）');
    assert.equal(localDateTime('2026-07-15T17:05:00.000Z'), '2026-07-15 13:05（UTC-04:00）');
  });
  inTimeZone('Asia/Kolkata', () => {
    assert.equal(localDateTime('2026-03-01T20:00:00.000Z'), '2026-03-02 01:30（UTC+05:30）');
  });
  inTimeZone('UTC', () => {
    assert.equal(localDateTime('2026-03-02T01:15:00.000Z'), '2026-03-02 01:15（UTC+00:00）');
  });
  for (const invalid of [undefined, null, '', 'yesterday', 0, {}]) assert.equal(localDateTime(invalid), '');
});

test('each question that changed the shared context exports the context it was asked with', () => {
  const date = '2026-03-02T01:15:00.000Z';
  const message = (role, stage, text, extra = {}) => ({
    id: text,
    role,
    stage,
    text,
    createdAt: date,
    ...extra
  });
  const room = {
    id: '00000000-0000-4000-8000-000000000003',
    createdAt: date,
    updatedAt: date,
    title: '背景变化',
    context: '',
    messages: [
      message('user', 'question', 'Q1', { context: '预算 200 元' }),
      message('codex', 'analysis', 'A1', { provider: 'codex', model: 'gpt-5' }),
      message('user', 'question', 'Q2'),
      message('user', 'question', 'Q3', { context: '预算 300 元' }),
      message('user', 'question', 'Q4', { context: '' })
    ]
  };
  const time = '2026-03-02 09:15（UTC+08:00）';
  assert.equal(
    exportRoom(room),
    `# 背景变化\n\n创建：${time}\n\n` +
      '## 共享背景\n\n预算 200 元\n\n' +
      `## 你 · 问题 · ${time}\n\nQ1\n\n` +
      `## Codex · 独立分析 · ${time}\n\n模型 · gpt-5\n\nA1\n\n` +
      `## 你 · 问题 · ${time}\n\nQ2\n\n` +
      `## 你 · 问题 · ${time}\n\nQ3\n\n### 共享背景（本轮更新）\n\n预算 300 元\n\n` +
      `## 你 · 问题 · ${time}\n\nQ4\n\n### 共享背景（本轮更新）\n\n（已清空）\n\n`
  );

  // A room saved before snapshots, whose context a later question changed, still shows its old context first.
  const legacy = {
    ...room,
    context: '预算 300 元',
    legacyContext: '旧预算',
    messages: [
      message('user', 'question', 'Q1'),
      message('user', 'question', 'Q2', { context: '预算 300 元' })
    ]
  };
  const exported = exportRoom(legacy);
  assert.ok(exported.includes('## 共享背景\n\n旧预算\n\n## 你 · 问题'));
  assert.ok(exported.includes('Q2\n\n### 共享背景（本轮更新）\n\n预算 300 元\n\n'));
});

test('hand-edited rooms export without errors and with default settings where they are missing', () => {
  assert.equal(exportRoom({}), '# 未命名讨论\n\n');
  assert.equal(
    exportRoom({ title: '空', createdAt: 'never', messages: 'none', context: '背景' }),
    '# 空\n\n## 共享背景\n\n背景\n\n'
  );
  const room = {
    title: '手改',
    messages: [
      null,
      {
        role: 'user',
        stage: 'question',
        text: '缺少设置',
        configuration: { mode: 'debate', participants: ['claude', 'codex', 'other'] }
      },
      { role: 'user', text: '设置无效', configuration: { mode: 'codex', settings: { codex: null } } },
      {
        role: 'user',
        stage: 'question',
        text: '未知模式',
        configuration: { mode: 'nope', participants: ['codex'] }
      },
      { role: 'codex', stage: 'custom', model: 5 },
      { role: 'summary', stage: 'summary', provider: 'retired', text: '归纳' }
    ]
  };
  assert.equal(
    exportRoom(room),
    '# 手改\n\n' +
      '## 你 · 问题\n\n本轮设置 · 联合讨论 · 网页检索关闭 · 主持人 Claude\n\n' +
      '- Claude · CLI 默认模型 · 综合分析\n- Codex · CLI 默认模型 · 综合分析\n\n缺少设置\n\n' +
      '## 你\n\n本轮设置 · Codex · 网页检索关闭\n\n- Codex · CLI 默认模型 · 综合分析\n\n设置无效\n\n' +
      '## 你 · 问题\n\n未知模式\n\n' +
      '## Codex · custom\n\n\n\n' +
      '## 决策归纳（retired） · 讨论总结\n\n归纳\n\n'
  );
});

test('savedConfiguration completes saved settings and drops what is unknown', () => {
  const defaults = { model: '', reasoning: '', capability: 'general' };
  assert.deepEqual(savedConfiguration({ mode: 'both' }), {
    mode: 'both',
    participants: ['codex', 'claude'],
    moderator: 'codex',
    settings: { codex: defaults, claude: defaults },
    webSearch: false,
    maxRounds: 3
  });
  assert.deepEqual(
    savedConfiguration({
      mode: 'debate',
      participants: ['cursor', 'cursor', 'unknown', 'claude'],
      moderator: 'claude',
      settings: {
        cursor: { model: 'auto', reasoning: 'x'.repeat(40), capability: 'retired' },
        claude: { model: '--flag', reasoning: 'high', capability: 'risk' }
      },
      webSearch: 'yes'
    }),
    {
      mode: 'debate',
      participants: ['cursor', 'claude'],
      moderator: 'claude',
      settings: {
        cursor: { model: 'auto', reasoning: '', capability: 'general' },
        claude: { model: '', reasoning: 'high', capability: 'risk' }
      },
      webSearch: false,
      maxRounds: 3
    }
  );
  assert.deepEqual(savedConfiguration({ mode: 'cursor', participants: ['codex'], webSearch: true }), {
    mode: 'cursor',
    participants: ['cursor'],
    moderator: 'cursor',
    settings: { cursor: defaults },
    webSearch: true,
    maxRounds: 3
  });
  for (const saved of [
    undefined,
    null,
    [],
    'debate',
    { mode: 'hasOwnProperty' },
    { mode: 'both', participants: [] }
  ])
    assert.equal(savedConfiguration(saved), null, JSON.stringify(saved));
});
