// The USB debug capture's panel (W-25b), only with ?usbdebug=1 in the address: a small box in the
// corner, closed until opened, that shows what lib/mesh/usblog.js recorded and copies it whole for
// the owner to paste into a message. In English only: it is a bench tool, and the text it copies
// is read by whoever looks into the fault, not by the owner.
import { h } from './dom.js';
import { usbLog } from '../lib/mesh/usblog.js';

export function mountUsbDebug(log = usbLog, root = document.body) {
  if (!log.enabled) return null;
  const pre = h('pre', { class: 'usb-debug-log', tabindex: '0' });
  const count = h('span', {});
  const copy = h('button', { type: 'button', class: 'tool' }, 'Copy');
  const clear = h('button', { type: 'button', class: 'tool' }, 'Clear');
  const said = h('span', { role: 'status', class: 'muted' });
  copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(log.text()); said.textContent = 'Copied.'; } catch {
      getSelection()?.selectAllChildren(pre);
      said.textContent = 'Selected: press Ctrl+C.';
    }
  });
  clear.addEventListener('click', () => { log.clear(); said.textContent = ''; });
  const draw = () => {
    count.textContent = `USB log, ${log.lines.length} ${log.lines.length === 1 ? 'line' : 'lines'}`;
    const atEnd = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 4;
    pre.textContent = log.lines.join('\n') || 'Nothing yet: connect the companion by USB.';
    if (atEnd) pre.scrollTop = pre.scrollHeight;
  };
  const panel = h('details', { class: 'usb-debug', open: true }, h('summary', {}, count),
    h('p', { class: 'row wrap' }, copy, clear, said), pre);
  log.onChange(draw);
  draw();
  root.append(panel);
  return panel;
}
