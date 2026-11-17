// Battery and "last heard on MQTT" for each device, from Beacon (read-only HTTP, no
// credentials). A port of actions.refresh_fleet, through the statistics' Beacon client
// (lib/stats/beacon.js), so the page reads one Beacon, the one its CSP names: the node by the
// start of its key finds its observer id, then one /observers/<id> each. Nothing here transmits.
//
// The result is stored on the device as `fleet` { batteryMv, seen, firmware, fetched }; a
// device Beacon does not know keeps nothing stale: its fleet is cleared. A number is never
// shown without the age of the sample (`seen`).
export async function refreshFleet({ stores, client, nodes = null, now = () => Date.now() }) {
  const all = await stores.devices.list();
  const devices = nodes ? all.filter((d) => nodes.includes(d.node)) : all;
  let updated = 0; let failed = 0;
  for (const d of devices) {
    try {
      const oid = d.observerId || (await client.findNode(d.key || d.node)).observerId;
      if (!oid) throw new Error('no status on Beacon');
      const data = await client.observer(oid);
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
