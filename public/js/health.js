// Tool connections: the status pills in the top bar, the "工具连接" dialog and /api/health checks,
// which keep polling while a discussion started elsewhere is still running on the server.
import { api, normalError, token } from './api.js';
import { updateControls } from './composer.js';
import { $, closeOnBackdropClick, element } from './dom.js';
import { showError } from './notices.js';
import { loadRoom } from './rooms.js';
import { defaultParticipants, names, providers, state } from './state.js';

let healthPoll;

export function renderHealth() {
  for (const name of providers) {
    const agent = state.health?.[name];
    const pill = $(name + 'Pill');
    const status = state.checking
      ? 'checking'
      : agent?.available && agent?.authenticated && agent?.subscription
        ? 'ready'
        : agent?.available
          ? 'warning'
          : 'offline';
    pill.className = `connection-pill ${status}`;
    pill.title = state.checking ? '正在检查…' : agent?.message || '尚未连接';
  }
  const details = $('healthDetails');
  details.replaceChildren();
  for (const name of providers) {
    const agent = state.health?.[name],
      ok = agent?.available && agent?.authenticated && agent?.subscription;
    const box = element('section', 'health-agent');
    const title = element('div', 'health-title');
    title.append(element('span', '', names[name]));
    title.append(
      element(
        'span',
        `health-badge${ok ? ' ok' : ''}`,
        state.checking ? '检查中…' : ok ? '账号登录已就绪' : !agent?.available ? '未找到工具' : '未就绪'
      )
    );
    box.append(title);
    box.append(
      element(
        'p',
        'health-message',
        state.checking
          ? '正在确认工具及登录状态…'
          : agent?.message || '请确认本地服务正在运行，然后重新检查。'
      )
    );
    if (agent?.version) box.append(element('div', 'health-version', agent.version));
    details.append(box);
  }
  $('refreshHealth').disabled = state.checking;
  $('refreshHealth').textContent = state.checking ? '正在检查…' : '重新检查连接';
  updateControls();
}

export async function checkHealth(force = false) {
  if (state.checking || !token) return;
  state.checking = true;
  renderHealth();
  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), 65000);
  const wasBusy = state.serverBusy;
  try {
    const data = await (
      await api(force ? '/api/health?refresh=1' : '/api/health', { signal: controller.signal })
    ).json();
    state.health = data;
    defaultParticipants();
    state.serverBusy = Boolean(data.busy);
    // A discussion running on the server has finished: show its result.
    if (wasBusy && !state.serverBusy && !state.busy && state.roomId)
      await loadRoom(state.roomId, { silent: true });
  } catch (error) {
    state.health = null;
    showError(normalError(error));
  } finally {
    clearTimeout(timer);
    state.checking = false;
    renderHealth();
    clearTimeout(healthPoll);
    if (state.serverBusy && !state.busy) healthPoll = setTimeout(checkHealth, 12000);
  }
}

export function setupHealth() {
  for (const name of providers)
    $(name + 'Pill').addEventListener('click', () => {
      renderHealth();
      $('healthDialog').showModal();
    });
  $('closeHealth').addEventListener('click', () => $('healthDialog').close());
  $('refreshHealth').addEventListener('click', () => checkHealth(true));
  closeOnBackdropClick($('healthDialog'));
}
