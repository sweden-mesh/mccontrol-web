// The demo's banner (W-39d): on every screen, above the status line, saying that the nodes are
// invented and where the way out is (ui/modal.js puts a short tag in every modal's title bar, since a
// modal covers the page); and "Demo" first in the page's title. Only ui/app.js and ui/modal.js call this, and only on a
// demo page.
import { h } from '../dom.js';
import { demoAddress } from './mode.js';

export const BANNER_ID = 'demo-banner';

// `sending`: false while the demo is read-only (v1), true once its simulated nodes answer.
export function drawBanner(t, { sending = false } = {}) {
  const doc = globalThis.document;
  let el = doc.getElementById(BANNER_ID);
  if (!el) {
    el = h('aside', { id: BANNER_ID, class: 'demo-banner' });
    doc.body.insertBefore(el, doc.getElementById('statusline'));
  }
  el.setAttribute('aria-label', t('demo.label'));
  el.replaceChildren(
    h('strong', {}, t('demo.label')),
    h('span', { class: 'demo-banner-text' }, t(sending ? 'demo.bannerSending' : 'demo.banner')),
    h('a', { href: demoAddress(false) }, t('demo.leave')));
  return el;
}

// "Demo" first in the title, whatever screen sets it.
export function keepTitle(t) {
  const doc = globalThis.document;
  const fix = () => {
    const word = t('demo.label');
    if (!doc.title.startsWith(`${word} · `)) doc.title = `${word} · ${doc.title}`;
  };
  const title = doc.querySelector('title');
  if (title) new MutationObserver(fix).observe(title, { childList: true, characterData: true, subtree: true });
  fix();
}
