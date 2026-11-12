// "共同背景" dialog: facts and constraints sent along with the next question.
import { persistDraft, updateControls } from './composer.js';
import { $, closeOnBackdropClick } from './dom.js';
import { toast } from './notices.js';
import { state } from './state.js';

const countLabel = (length) => `${length.toLocaleString()} / 40,000 字符`;

export function setupContextDialog() {
  const dialog = $('contextDialog');
  $('contextButton').addEventListener('click', () => {
    $('contextInput').value = state.context;
    $('contextCount').textContent = countLabel(state.context.length);
    dialog.showModal();
  });
  $('closeContext').addEventListener('click', () => dialog.close());
  $('contextInput').addEventListener('input', () => {
    $('contextCount').textContent = countLabel($('contextInput').value.length);
  });
  $('saveContext').addEventListener('click', () => {
    state.context = $('contextInput').value.trim();
    dialog.close();
    updateControls();
    persistDraft();
    toast(state.context ? '共同背景会随下次提问一起发送。' : '已清空共同背景。');
  });
  closeOnBackdropClick(dialog);
}
