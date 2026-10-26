import { icon } from './icons.js';
const menu = document.createElement('div');
menu.className = 'context-menu'; menu.id = 'context-menu'; menu.setAttribute('role', 'menu'); menu.setAttribute('popover', 'manual');
let previousFocus, sequence = 0;
export function hideMenu(restore = false) {
  sequence++;
  if (menu.matches(':popover-open')) menu.hidePopover();
  if (restore && previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
}
export async function showMenu(event, load, action, onError) {
  event.preventDefault(); hideMenu(); const request = sequence;
  previousFocus = document.activeElement;
  const rect = event.currentTarget.getBoundingClientRect();
  const x = event.clientX || rect.left + 15, y = event.clientY || rect.top + 15;
  try {
    const items = await load(); if (request !== sequence) return;
    menu.replaceChildren();
    for (const item of items) {
      if (item.type === 'separator') { const line = document.createElement('div'); line.className = 'menu-separator'; line.setAttribute('role', 'separator'); menu.append(line); continue; }
      const button = document.createElement('button'); button.type = 'button'; button.setAttribute('role', 'menuitem'); button.disabled = item.enabled === false; button.dataset.action = item.id;
      button.append(icon(item.icon), document.createTextNode(item.label));
      button.onclick = () => { hideMenu(true); Promise.resolve().then(() => action(item.id)).catch(onError); };
      menu.append(button);
    }
    (document.fullscreenElement || document.querySelector('dialog[open]') || document.body).append(menu);
    menu.showPopover();
    const bounds = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(x, innerWidth - bounds.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, innerHeight - bounds.height - 8))}px`;
    menu.querySelector('button:not(:disabled)')?.focus({ preventScroll: true });
  } catch (error) { onError(error); }
}
menu.addEventListener('keydown', event => {
  if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); event.stopPropagation(); hideMenu(true); return; }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault(); const buttons = [...menu.querySelectorAll('button:not(:disabled)')], index = buttons.indexOf(document.activeElement);
  buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
});
document.addEventListener('pointerdown', event => { if (!menu.contains(event.target)) hideMenu(); }, true);
document.addEventListener('scroll', event => { if (!menu.contains(event.target)) hideMenu(); }, true);
window.addEventListener('resize', () => hideMenu());
document.addEventListener('fullscreenchange', () => hideMenu());
