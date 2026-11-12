// Small DOM helpers shared by every module.

/** Shorthand for document.getElementById. */
export const $ = (id) => document.getElementById(id);

/** Creates an element. Text is always assigned through textContent, never parsed as HTML. */
export function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Closes a modal <dialog> when the user clicks its backdrop, i.e. outside the dialog box. */
export function closeOnBackdropClick(dialog) {
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom
    )
      dialog.close();
  });
}
