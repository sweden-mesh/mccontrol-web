// Setup's area tab: find mesh-only nodes (W-24). A board without Wi-Fi never uses MQTT, so
// discovery's broadcast cannot reach it. "Look for them" reads, and sends nothing: the companion's
// contacts and Beacon's repeaters (not observers) placed inside the chosen county. Each is a
// possible mesh-only node, not confirmed. "Check" sends ONE signed `ver` over the mesh through the
// companion, only when the owner presses it; an answer adds the node to the list as mesh-only.
import { h } from '../dom.js';
import { automationState, checkMeshNode, findMeshNodes, onAutomation } from '../automation.js';
import { onCompanion, state as companionState } from '../companion-session.js';
import { companionChooser } from './road-kit.js';
import { CompanionError } from '../../lib/mesh/companion.js';

let outline = null;
const loadOutline = () => {
  if (!outline) outline = fetch(new URL('../tiles/se-lan.json', import.meta.url)).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  return outline;
};

const ago = (ctx, ms) => {
  if (!ms) return '';
  const h = Math.max(0, Math.round((Date.now() - ms) / 3600000));
  return h < 1 ? ctx.t('mesh.find.seenNow') : h < 48 ? ctx.t('mesh.find.seenH', { n: h }) : ctx.t('mesh.find.seenD', { n: Math.round(h / 24) });
};

export function meshFindBlock(ctx) {
  const { t } = ctx;
  const find = h('button', { type: 'button', class: 'button' }, t('mesh.find.look'));
  const status = h('p', { class: 'hint-line', role: 'status' });
  const list = h('ul', { class: 'mesh-found' });
  const note = h('p', { class: 'hint-line' });
  let busy = false;      // one check at a time

  const why = (err) => (err instanceof CompanionError ? t('send.why.companion', { detail: err.message })
    : err?.code ? t(`send.why.${err.code}`, err.vars) : err?.message || String(err));

  // What stands between the owner and a Check, as a sentence with its way out, or null.
  function gate() {
    const s = automationState();
    if (!s.owner) return [t('mesh.find.needKey')];
    if (!s.unlocked) return [t('send.locked')];
    if (companionState().status !== 'connected') {
      const b = h('button', { type: 'button', class: 'link-button' }, t('mesh.find.connect'));
      b.addEventListener('click', () => companionChooser(ctx));
      return [t('mesh.find.needCompanion'), ' ', b];
    }
    return null;
  }

  function drawGate() {
    const g = gate();
    note.replaceChildren(...(g || [t('mesh.find.airtime')]));
    for (const b of list.querySelectorAll('.mesh-check')) b.disabled = Boolean(g) || busy || b.dataset.done === '1';
  }

  function row(c) {
    const name = c.name || c.node;
    const where = c.source === 'companion'
      ? (c.hops >= 0 ? t('mesh.find.fromCompanionHops', { n: c.hops }) : t('mesh.find.fromCompanion'))
      : [t('mesh.find.fromBeacon'), ago(ctx, c.lastSeen)].filter(Boolean).join(', ');
    const out = h('p', { class: 'hint-line', role: 'status' });
    const check = h('button', { type: 'button', class: 'tool mesh-check', 'aria-describedby': `mf-${c.node}` }, t('mesh.find.check'));
    check.addEventListener('click', async () => {
      if (busy || gate()) { drawGate(); return; }
      busy = true;
      drawGate();
      out.textContent = t('mesh.find.waiting');
      try {
        const res = await checkMeshNode(c, {
          onProgress: (p) => { if (p.total) out.textContent = t('mesh.find.waitingFor', { s: Math.max(0, Math.round(p.total - p.elapsed)) }); },
        });
        if (res.answered) {
          check.dataset.done = '1';
          out.replaceChildren(t('mesh.find.answered'), ' ', h('a', { href: `#node/${res.device.node}` }, t('mesh.find.open')));
        } else {
          out.textContent = t('mesh.find.silent');
        }
      } catch (err) {
        out.textContent = why(err);
      } finally {
        busy = false;
        drawGate();
      }
    });
    return h('li', {},
      h('div', { class: 'row wrap mesh-found-row' },
        h('span', { class: 'mesh-found-name' }, name), ' ', h('code', { class: 'muted' }, c.node),
        h('span', { class: 'muted', id: `mf-${c.node}` }, where), check),
      out);
  }

  find.addEventListener('click', async () => {
    find.disabled = true;
    status.textContent = t('mesh.find.looking');
    try {
      const geo = await loadOutline();
      const r = await findMeshNodes(geo);
      const all = [...r.companion, ...r.beacon];
      list.replaceChildren(...all.map(row));
      const parts = [all.length ? t('mesh.find.found', { n: all.length }) : t('mesh.find.none')];
      if (!r.area) parts.push(t('mesh.find.noArea'));
      if (companionState().status !== 'connected') parts.push(t('mesh.find.noContacts'));
      if (r.beaconError) parts.push(t('mesh.find.beaconFailed', { reason: r.beaconError }));
      status.textContent = parts.join(' ');
      drawGate();
    } catch (err) {
      status.textContent = why(err);
    } finally {
      find.disabled = false;
    }
  });

  const offA = onAutomation(drawGate);
  const offC = onCompanion(drawGate);
  ctx.signal?.addEventListener('abort', () => { offA(); offC(); }, { once: true });
  drawGate();
  return [h('p', {}, t('mesh.find.lede')), h('p', { class: 'row wrap' }, find), status, list, note];
}
