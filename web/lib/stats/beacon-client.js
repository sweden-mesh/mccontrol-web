// Statistics for one node from a public Beacon server (the browser's mccontrol/beacon.py). Beacon
// ingests the MeshCore MQTT brokers and serves a read-only API with no credentials; every
// auto-reply node is an Observer, so Beacon holds the status block it publishes (battery, uptime,
// noise floor, airtime, packets) and the hourly history of it. Nothing here transmits.
//
// The shapes this relies on, verified against beacon.meshcore-jkp.se 2.2.0 on 2026-11-17:
//   GET /nodes?pubkeyPrefix=<hex>&limit=2   items[]: publicKey, name, observerId (absent when the
//                                            node has never published a status)
//   GET /nodes?limit=1000[&cursor=<n>]      every node, newest first; hasMore, nextCursor (an
//                                            integer) for the next page (1341 nodes in 2 pages on
//                                            beacon.meshcoresverige.se, 2026-11-17)
//   GET /observers/<id>                      statusMetadata.stats {...}, lastStatusAt (epoch ms)
//   GET /observers/<id>/telemetry?range=24h|168h&interval=1h
//                                            points[]: t, batteryMv, airtimeTxSecs, airtimeRxSecs,
//                                            uptimeSeconds; hourly, the counters as published
//                                            (running totals since boot). The 6h interval returns
//                                            per-bucket sums instead, so it is not used: the 7-day
//                                            view adds the hourly differences up itself.
//
// No DOM: the fetch is a parameter. A failure is a StatsError with a sentence; a number is never
// shown without the age of the sample it came from.

export const HOUR = 3600000;

// The two views: the hourly differences of the last 24 hours, and of the last 7 days summed into
// 6-hour bars.
export const PERIODS = Object.freeze({
  '24h': Object.freeze({ range: '24h', bucket: HOUR }),
  '7d': Object.freeze({ range: '168h', bucket: 6 * HOUR }),
});

export class StatsError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;          // 'unknown' | 'noStatus' | 'unreachable'
  }
}

let defaultBase = null;

// The Beacon this page reads from: lib/stats/beacon-source.json (an origin the CSP's connect-src names).
export function beaconBase(read = (url) => fetch(url).then((r) => r.json())) {
  if (!defaultBase) {
    defaultBase = Promise.resolve(read(new URL('./beacon-source.json', import.meta.url)))
      .then((cfg) => String(cfg.url).replace(/\/+$/, ''));
  }
  return defaultBase;
}

export function beaconClient({ base, fetch: get = globalThis.fetch, signal } = {}) {
  const json = async (path) => {
    let res;
    try {
      res = await get(`${base}${path}`, { headers: { Accept: 'application/json' }, signal });
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      throw new StatsError(`Beacon unreachable: ${err?.message || err}`, 'unreachable');
    }
    if (!res.ok) throw new StatsError(`Beacon answered ${res.status} for ${path.split('?')[0]}`, 'unreachable');
    try {
      return await res.json();
    } catch {
      throw new StatsError(`Beacon sent something that is not JSON for ${path.split('?')[0]}`, 'unreachable');
    }
  };
  return Object.freeze({
    // The node by the start of its public key (the 8-hex control id or the whole key).
    async findNode(nodeId) {
      const prefix = String(nodeId || '').toLowerCase();
      if (!/^[0-9a-f]{8,64}$/.test(prefix)) throw new StatsError(`${nodeId} is not a node id`, 'unknown');
      const data = await json(`/nodes?pubkeyPrefix=${prefix}&limit=2`);
      const hits = (data.items || []).filter((n) => String(n.publicKey || '').toLowerCase().startsWith(prefix));
      if (hits.length !== 1) throw new StatsError(`Beacon does not know ${nodeId}`, 'unknown');
      return hits[0];
    },
    // Every node Beacon knows, page by page, at most `maxPages` pages (W-24: the mesh-only search
    // filters them by position, since a node's IATA is only where observers heard it).
    async allNodes({ maxPages = 5, limit = 1000 } = {}) {
      const out = [];
      let cursor = null;
      for (let page = 0; page < maxPages; page += 1) {
        const data = await json(`/nodes?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
        out.push(...(Array.isArray(data?.items) ? data.items : []));
        if (!data?.hasMore || !Number.isFinite(Number(data.nextCursor))) break;
        cursor = String(data.nextCursor);
      }
      return out;
    },
    observer: (id) => json(`/observers/${encodeURIComponent(id)}`),
    telemetry: (id, range) => json(`/observers/${encodeURIComponent(id)}/telemetry?range=${range}&interval=1h`),
  });
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// Hourly points (running totals) -> bars of `bucket` ms from `start` to `end`: the airtime sent
// and received in each, or null where it is not known (no sample, a gap longer than the bar, or a
// reboot that reset the counters). A difference counts in the bar where it began.
export function airtimeBars(points, { bucket, start, end }) {
  const count = Math.max(0, Math.round((end - start) / bucket));
  const bars = Array.from({ length: count }, (_, i) => ({ t: start + i * bucket, tx: null, rx: null, batteryMv: null }));
  const sorted = [...(points || [])].filter((p) => num(p.t) !== null).sort((a, b) => a.t - b.t);
  for (let i = 0; i < sorted.length; i += 1) {
    const p = sorted[i];
    const slot = Math.floor((p.t - start) / bucket);
    if (slot >= 0 && slot < count && num(p.batteryMv) !== null) bars[slot].batteryMv = p.batteryMv;
    const next = sorted[i + 1];
    if (!next || slot < 0 || slot >= count) continue;
    if (next.t - p.t > Math.max(bucket, HOUR) * 1.5) continue;
    const tx = num(next.airtimeTxSecs) - num(p.airtimeTxSecs);
    const rx = num(next.airtimeRxSecs) - num(p.airtimeRxSecs);
    const rebooted = num(next.uptimeSeconds) !== null && num(p.uptimeSeconds) !== null
      && next.uptimeSeconds < p.uptimeSeconds;
    if ([p.airtimeTxSecs, next.airtimeTxSecs, p.airtimeRxSecs, next.airtimeRxSecs].some((v) => num(v) === null)
      || tx < 0 || rx < 0 || rebooted) continue;
    bars[slot].tx = (bars[slot].tx || 0) + tx;
    bars[slot].rx = (bars[slot].rx || 0) + rx;
  }
  return bars;
}

// Totals and the busiest bar, over the bars that are known.
export function summarize(bars) {
  const known = bars.filter((b) => b.tx !== null);
  if (!known.length) return { known: 0, tx: 0, rx: 0, peak: null };
  const peak = known.reduce((a, b) => (b.tx > a.tx ? b : a));
  return {
    known: known.length,
    tx: known.reduce((s, b) => s + b.tx, 0),
    rx: known.reduce((s, b) => s + b.rx, 0),
    peak,
  };
}

// Everything a view shows for one node and period. `now` is epoch ms. Rejects with a StatsError
// whose `code` says why there is nothing to show.
export async function nodeStats(client, nodeId, period = '24h', now = Date.now()) {
  const spec = PERIODS[period];
  if (!spec) throw new Error(`period is one of ${Object.keys(PERIODS).join(', ')}`);
  const node = await client.findNode(nodeId);
  if (!node.observerId) throw new StatsError(`${node.name || nodeId} has never published a status to Beacon`, 'noStatus');
  const [obs, tel] = await Promise.all([client.observer(node.observerId), client.telemetry(node.observerId, spec.range)]);
  const sampledAt = num(obs.lastStatusAt);
  const block = obs.statusMetadata?.stats || null;
  // Bars start on the local clock (00, 06, 12, 18), not on UTC's.
  const local = -new Date(now).getTimezoneOffset() * 60000;
  const end = Math.floor((now + local) / spec.bucket) * spec.bucket + spec.bucket - local;
  const start = end - (spec.range === '24h' ? 24 * HOUR : 168 * HOUR);
  const bars = airtimeBars(tel.points, { bucket: spec.bucket, start, end });
  return {
    name: node.name || obs.displayName || String(nodeId),
    publicKey: node.publicKey,
    period,
    stats: block && sampledAt ? block : null,
    sampledAt,
    ageSecs: sampledAt ? Math.max(0, Math.round((now - sampledAt) / 1000)) : null,
    model: obs.hardwareModel || '',
    firmware: obs.firmwareVersion || '',
    bars,
    summary: summarize(bars),
  };
}

// The age of a sample, as an i18n key and its value: stats.age.s|min|h|d (beacon.py age_text).
export function ageParts(secs) {
  if (secs < 90) return ['stats.age.s', secs];
  if (secs < 5400) return ['stats.age.min', Math.floor(secs / 60)];
  if (secs < 172800) return ['stats.age.h', Math.floor(secs / 3600)];
  return ['stats.age.d', Math.floor(secs / 86400)];
}

// A clean y-axis top and step for a maximum (1, 2 or 5 times a power of ten, 4 steps or fewer).
export function niceScale(max) {
  if (!(max > 0)) return { top: 1, step: 1 };
  const raw = max / 4;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw);
  return { top: Math.ceil(max / step) * step, step };
}
