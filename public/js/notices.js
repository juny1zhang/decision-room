// Error banner above the conversation and the short-lived toast at the bottom of the page.
import { $ } from './dom.js';

let toastTimer;

export function showError(message) {
  $('errorText').textContent = message;
  $('errorBanner').hidden = false;
}

export function clearError() {
  $('errorBanner').hidden = true;
  $('errorText').textContent = '';
}

export function toast(message) {
  $('toast').textContent = message;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    $('toast').hidden = true;
  }, 2800);
}

export function setupNotices() {
  $('dismissError').addEventListener('click', clearError);
}
