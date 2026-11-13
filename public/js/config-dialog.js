// "模型与能力" dialog: choose participants and, per provider, model, reasoning effort and capability.
// One card per provider of the server's registry. Edits go to a draft copy that is applied to the shared
// state only on submit.
import { persistDraft, updateControls } from './composer.js';
import { $, closeOnBackdropClick, element } from './dom.js';
import {
  MODERATED_MODES,
  activeCapabilities,
  isSingle,
  providerName,
  providers,
  ready,
  state
} from './state.js';

let configDraft;
/** The status check the dialog opened with (see renderProviderFields). */
let configHealth = null;

const COUNTS = ['零', '一', '两', '三', '四', '五', '六', '七', '八', '九', '十'];
/** "两", "三"… as in "两到三位"; digits past ten. */
const count = (number) => COUNTS[number] ?? String(number);

function addOption(select, value, label) {
  const option = element('option', '', label);
  option.value = value;
  select.append(option);
}

/**
 * A labelled `control` of provider `provider`. Every card has the same fields, so the label also names the
 * provider for screen readers ("Codex 模型").
 */
function field(parent, provider, labelText, id, control, extraClass = '') {
  const wrap = element('div', ('option-field ' + extraClass).trim());
  const label = element('label', 'option-label');
  label.append(element('span', 'sr-only', providerName(provider) + ' '), labelText);
  control.id = id;
  label.htmlFor = id;
  wrap.append(label, control);
  parent.append(wrap);
  return wrap;
}

function renderProviderFields(id, card) {
  // A failed status check clears state.health, also while this dialog is open: the fields keep the models,
  // reasoning levels and capabilities of the check the dialog opened with, so that no choice is dropped.
  const health = state.health || configHealth;
  const info = health?.[id] || {};
  const choice = (configDraft.settings[id] ||= { model: '', reasoning: '', capability: 'general' });
  const fields = element('div', 'provider-fields');
  const modelSelect = element('select');
  const modelField = field(fields, id, '模型', 'model-' + id, modelSelect, 'model-field');
  addOption(modelSelect, '', 'CLI 默认模型');
  for (const model of info.models || []) addOption(modelSelect, model, model);
  addOption(modelSelect, '__custom', '手动输入模型 ID…');
  const isCustom = choice.model && !(info.models || []).includes(choice.model);
  modelSelect.value = isCustom ? '__custom' : choice.model;
  const custom = element('input');
  custom.type = 'text';
  custom.id = 'custom-' + id;
  custom.maxLength = 240;
  custom.spellcheck = false;
  custom.autocomplete = 'off';
  custom.setAttribute('aria-label', providerName(id) + ' 自定义模型 ID');
  custom.placeholder = '输入此 CLI 支持的模型 ID';
  custom.value = isCustom ? choice.model : '';
  custom.hidden = !isCustom;
  custom.required = Boolean(isCustom);
  modelField.append(custom);

  const capability = element('select');
  field(fields, id, '分析能力', 'capability-' + id, capability);
  const options = health?.capabilities || activeCapabilities();
  for (const item of options) addOption(capability, item.id, item.label);
  capability.value = options.some((item) => item.id === choice.capability) ? choice.capability : 'general';
  choice.capability = capability.value;
  const reasoning = element('select');
  const reasoningField = field(fields, id, '推理强度', 'reasoning-' + id, reasoning);
  function refreshReasoning() {
    const perModel = info.reasoningByModel || {};
    const levels = Object.hasOwn(perModel, choice.model)
      ? perModel[choice.model]
      : info.reasoningLevels || [];
    reasoning.replaceChildren();
    addOption(reasoning, '', 'CLI 默认强度');
    for (const level of levels) addOption(reasoning, level, level);
    if (!levels.includes(choice.reasoning)) choice.reasoning = '';
    reasoning.value = choice.reasoning;
    reasoningField.hidden = !levels.length;
  }
  refreshReasoning();
  reasoning.addEventListener('change', () => {
    choice.reasoning = reasoning.value;
  });
  const note = element('p', 'capability-note');
  function describeCapability() {
    choice.capability = capability.value;
    note.textContent = options.find((item) => item.id === choice.capability)?.description || '';
    note.hidden = !note.textContent;
  }
  describeCapability();
  capability.addEventListener('change', describeCapability);
  fields.append(note);
  modelSelect.addEventListener('change', () => {
    const manual = modelSelect.value === '__custom';
    custom.hidden = !manual;
    custom.required = manual;
    custom.setCustomValidity('');
    choice.model = manual ? custom.value.trim() : modelSelect.value;
    refreshReasoning();
    if (manual) custom.focus();
  });
  custom.addEventListener('input', () => {
    choice.model = custom.value.trim();
    custom.setCustomValidity(choice.model ? '' : '请输入模型 ID。');
    refreshReasoning();
  });
  card.append(fields);
}

function renderConfiguration() {
  const single = isSingle();
  const cards = $('providerCards');
  cards.replaceChildren();
  $('participantHint').textContent = single
    ? '选择一位参与者，并设置本轮回答使用的模型和能力。'
    : `选择${providers.length > 2 ? '两到' + count(providers.length) : '两'}位参与者，可分别设置模型和能力。`;
  for (const id of providers) {
    const selected = configDraft.participants.includes(id);
    const card = element('section', 'provider-card' + (selected ? ' selected' : ''));
    card.dataset.provider = id;
    const label = element('label', 'provider-row');
    const input = element('input');
    input.type = single ? 'radio' : 'checkbox';
    input.name = 'provider';
    input.id = 'participant-' + id;
    input.checked = selected;
    const status = ready(id) ? '已登录' : state.health?.[id]?.available ? '未就绪' : '未连接';
    label.append(
      input,
      element('span', 'provider-name', providerName(id)),
      element('span', 'provider-state' + (ready(id) ? ' ready' : ''), status)
    );
    input.addEventListener('change', () => {
      const members = configDraft.participants;
      configDraft.participants = single
        ? [id]
        : input.checked
          ? [...members, id]
          : members.filter((member) => member !== id);
      if (!configDraft.participants.includes(configDraft.moderator))
        configDraft.moderator = configDraft.participants[0] || '';
      renderConfiguration();
      $('participant-' + id).focus({ preventScroll: true });
    });
    card.append(label);
    if (selected) renderProviderFields(id, card);
    cards.append(card);
  }
  const members = configDraft.participants;
  const moderator = $('moderator');
  moderator.replaceChildren();
  for (const id of members) addOption(moderator, id, providerName(id));
  moderator.value = configDraft.moderator;
  // The debate's moderator sums it up; goal mode's merges the proposals and revises the plan.
  $('moderatorField').hidden = !MODERATED_MODES.includes(state.mode);
  $('moderatorLabel').textContent = state.mode === 'goal' ? '方案主持人' : '归纳主持人';
  const valid = members.length >= (single ? 1 : 2);
  $('configCount').textContent = valid
    ? '已选 ' + members.length + ' 位参与者'
    : single
      ? '请选择一位参与者'
      : '此模式至少需要两位参与者';
  $('applyConfig').disabled = !valid;
}

function openConfiguration() {
  configHealth = state.health;
  configDraft = {
    participants: [...state.participants],
    moderator: state.moderator,
    settings: structuredClone(state.settings)
  };
  renderConfiguration();
  $('configDialog').showModal();
}

function applyConfiguration(event) {
  event.preventDefault();
  if ($('applyConfig').disabled || !configDraft) return;
  const single = isSingle();
  state.participants = [...configDraft.participants];
  if (single) state.mode = state.participants[0];
  state.moderator = configDraft.moderator;
  state.settings = configDraft.settings;
  state.selectionRestored = true;
  $('configDialog').close();
  updateControls();
  persistDraft();
}

export function setupConfigDialog() {
  $('configureButton').addEventListener('click', openConfiguration);
  $('closeConfig').addEventListener('click', () => $('configDialog').close());
  $('configForm').addEventListener('submit', applyConfiguration);
  $('moderator').addEventListener('change', () => {
    configDraft.moderator = $('moderator').value;
  });
  closeOnBackdropClick($('configDialog'));
}
