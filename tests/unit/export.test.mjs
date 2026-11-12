import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exportRoom } from '../../src/export.mjs';

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
    '# 旧讨论\n\n创建：2026-01-01T00:00:00.000Z\n\n' +
      '## 共享背景\n\n共同预算 200 元\n\n' +
      '## 你 · question\n\n原来的问题\n\n' +
      '## 决策归纳（Codex） · summary\n\n原来的归纳\n\n'
  );
});

test('a three-participant room exports each round setting, speaker and model', () => {
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
      message('user', 'question', '追问', { configuration: both }),
      message('codex', 'analysis', 'Codex 的回答', { provider: 'codex', model: 'gpt-5' })
    ]
  };
  assert.equal(
    exportRoom(room),
    '# 三方讨论\n\n创建：2026-02-02T00:00:00.000Z\n\n' +
      '## 你 · question\n\n' +
      '本轮设置 · 联合讨论 · 网页检索开启 · 主持人 Cursor\n\n' +
      '- Cursor · mock-cursor[context=1m] · 方案规划\n' +
      '- Claude · sonnet · 风险审查 · 推理强度 medium\n' +
      '- Codex · CLI 默认模型 · 事实核查 · 推理强度 high\n\n' +
      '第一个问题\n\n' +
      '## Cursor · analysis\n\n模型 · mock-cursor[context=1m]\n\nCursor 的分析\n\n' +
      '## Claude · review\n\n模型 · claude-sonnet-4-5\n\nClaude 的审查\n\n' +
      '## 状态说明 · error\n\nCodex 审查失败：超时\n\n' +
      '## 决策归纳（Cursor） · summary\n\n模型 · mock-cursor[context=1m]\n\n主持人归纳\n\n' +
      '## 你 · question\n\n' +
      '本轮设置 · 分别回答 · 网页检索关闭\n\n' +
      '- Codex · CLI 默认模型 · 方案比较\n' +
      '- Claude · CLI 默认模型 · 综合分析\n\n' +
      '追问\n\n' +
      '## Codex · analysis\n\n模型 · gpt-5\n\nCodex 的回答\n\n'
  );
});
