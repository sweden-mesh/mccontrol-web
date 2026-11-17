// Battery and "last heard on MQTT" for each device, from Beacon (read-only HTTP, no
// credentials; the URL is brokers.json's beacon_url, already in the CSP). A port of
// actions.refresh_fleet and beacon.observer_for/stats: one /nodes?iata= read per region finds
// every device's observer id, then one /observers/<id> each. Nothing here transmits.
//
// The result is stored on the device as `fleet` { batteryMv, seen, firmware, fetched }; a
// device Beacon does not know keeps nothing stale: its fleet is cleared. A number is never
// shown without the age of the sample (`seen`).
async function fetchJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Beacon answered ${res.status}`);
  return res.json();
}

export async function refreshFleet({ stores, brokers, nodes = null, read = fetchJson, now = () => Date.now() }) {
  const base = String(brokers.beacon_url || '').replace(/\/+$/, '');
  const all = await stores.devices.list();
  const devices = nodes ? all.filter((d) => nodes.includes(d.node)) : all;
  const ids = new Map();
  let updated = 0; let failed = 0;
  for (const region of [...new Set(devices.map((d) => d.region))]) {
    try {
      const data = await read(`${base}/nodes?iata=${encodeURIComponent(region)}&limit=200`);
      for (const item of data?.items || []) {
        const key = String(item.publicKey || '').toUpperCase();
        if (key.length >= 8 && item.observerId) ids.set(key.slice(0, 8), item.observerId);
      }
    } catch { /* this region's devices fail below */ }
  }
  for (const d of devices) {
    const oid = ids.get(d.node) || d.observerId;
    try {
      if (!oid) throw new Error('unknown to Beacon');
      const data = await read(`${base}/observers/${encodeURIComponent(oid)}`);
      const stats = data?.statusMetadata?.stats || {};
      if (!data?.lastStatusAt) throw new Error('no status');
      await stores.devices.update(d.node, {
        observerId: oid,
        fleet: {
          batteryMv: Number.isFinite(stats.battery_mv) ? stats.battery_mv : null,
          seen: new Date(Number(data.lastStatusAt)).toISOString(),
          firmware: data.firmwareVersion || '',
          fetched: new Date(now()).toISOString(),
        },
      });
      updated += 1;
    } catch {
      await stores.devices.update(d.node, { fleet: null });
      failed += 1;
    }
  }
  return { updated, failed };
}
