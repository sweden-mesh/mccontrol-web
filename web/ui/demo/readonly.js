// The read-only demo's visible gate (W-39e): the controls that would send are off, with the reason
// beside them. The jobs refuse on their own (lib/jobs/jobs.js `readOnly`); this is the half a person
// sees. One place, by what the controls are, so no screen carries a demo branch: the command line's
// and the send form's Send, a set's Run, and the companion's connect.
import { h } from '../dom.js';

export const SEND_CONTROLS = '.cmd-line .cmd-send, .send-form .row > button.button, .companion-brief, .mesh-check';
const REASON_ID = 'demo-send-off';

export function closeSendControls(t, root = globalThis.document) {
  const doc = root.ownerDocument || root;
  const apply = (scope) => {
    for (const el of scope.querySelectorAll?.(SEND_CONTROLS) || []) {
      if (el.dataset.demoOff) continue;
      el.dataset.demoOff = '1';
      el.disabled = true;
      el.title = t('demo.sendOff');
      el.setAttribute('aria-describedby', REASON_ID);
    }
  };
  if (!doc.getElementById(REASON_ID)) doc.body.append(h('p', { id: REASON_ID, class: 'visually-hidden' }, t('demo.sendOff')));
  apply(doc);
  // A screen may switch its own button back on after a check: the demo's word is the last one.
  new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'attributes') { if (r.target.dataset?.demoOff && !r.target.disabled) r.target.disabled = true; } else for (const n of r.addedNodes) if (n.nodeType === 1) { if (n.matches?.(SEND_CONTROLS)) apply(n.parentNode); else apply(n); }
    }
  }).observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });
}
