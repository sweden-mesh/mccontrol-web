// The Neighbours dialog (W-29f), #neighbours/<node>: every neighbour of the node with its name and
// key prefix, SNR (last and average over the stored `neighbors` replies), RSSI (neither source
// reports it, so it says so), when it was last heard, whether the node heard it directly (its own
// `neighbors` reply) or only Beacon's observers saw the link, the distance when both positions are
// known, and "Select" for one of the owner's own nodes. A modal like any other, in both layouts.
// Reading only: it sends nothing; `neighbors` in Send a command asks the node again.
import { h } from '../dom.js';
import { beaconBase } from '../../lib/stats/beacon.js';
import { setSelected } from '../board-state.js';
import { nameOf, screen, withServices, put } from '../screens/node-kit.js';
import { age } from '../tiles/kit.js';
import { neighbourRows } from './neighbours-data.js';

export const route = 'neighbours';
export const title = 'std.neighboursTitle';

async function beaconNeighbours(device) {
  const id = device.fleet?.beaconId;
  if (!id) return [];
  const base = await beaconBase();
  const res = await fetch(`${base}/nodes/${encodeURIComponent(id)}/neighbors`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Beacon answered ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : [];
}

export function render(ctx) {
  const id = String(ctx.args[0] || '').toUpperCase();
  const body = h('div', {});
  const el = screen('neighbours', ctx.t('std.neighboursTitle'), body);
  const heading = el.querySelector('h1');
  withServices(ctx, body, async (svc) => {
    const device = await svc.stores.devices.get(id);
    if (!device) { put(body, h('p', {}, ctx.t('node.missing'))); return; }
    heading.textContent = ctx.t('std.neighboursOf', { name: nameOf(device) });
    const [events, devices, beacon] = await Promise.all([
      svc.stores.history.list({ node: device.node, limit: 200 }),
      svc.stores.devices.list(),
      beaconNeighbours(device).then((rows) => ({ rows }), (e) => ({ rows: [], error: e.message })),
    ]);
    if (ctx.signal.aborted) return;
    const self = { lat: device.fleet?.lat, lng: device.fleet?.lng };
    const rows = neighbourRows({ events, beaconRows: beacon.rows, devices: devices.filter((d) => d.node !== device.node), self });
    const dB = (v) => (v === null ? '–' : `${v.toFixed(1)} dB`);
    const tr = rows.map((r) => {
      let pick = null;
      if (r.own) {
        pick = h('button', { type: 'button', class: 'tool std-small' }, ctx.t('std.select'));
        pick.addEventListener('click', () => { setSelected(r.own.node); ctx.close(); });
      }
      const heard = r.heardAt || r.beaconSeen;
      return h('tr', {},
        h('th', { scope: 'row' }, h('span', { class: 'nb-name' }, r.name || ctx.t('std.unnamed')), ' ', h('code', { class: 'muted' }, r.prefix)),
        h('td', {}, dB(r.snrLast), h('span', { class: 'muted' }, ` / ${dB(r.snrAvg)}`), r.samples > 1 ? h('span', { class: 'muted small' }, ` (${r.samples})`) : null),
        h('td', { class: 'muted' }, ctx.t('std.noRssi')),
        h('td', {}, heard ? age(ctx, heard) : '–'),
        h('td', {}, ctx.t(r.direct ? 'std.direct' : 'std.viaBeacon')),
        h('td', {}, r.km === null ? '–' : `${r.km.toFixed(r.km < 10 ? 1 : 0)} km`),
        h('td', {}, pick));
    });
    put(body,
      h('p', { class: 'muted' }, ctx.t('std.neighboursLede')),
      beacon.error ? h('p', { class: 'muted' }, ctx.t('std.beaconFailed', { reason: beacon.error })) : null,
      rows.length ? h('div', { class: 'nb-wrap' }, h('table', { class: 'std-table nb-table' },
        h('thead', {}, h('tr', {}, ...['std.nbName', 'std.nbSnr', 'std.nbRssi', 'std.nbHeard', 'std.nbHow', 'std.nbDistance', 'std.nbSelect']
          .map((k) => h('th', { scope: 'col' }, ctx.t(k))))),
        h('tbody', {}, tr))) : h('p', {}, ctx.t('std.noNeighbours')));
  });
  return el;
}
