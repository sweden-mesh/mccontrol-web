// What a demo node answers (W-39j): the firmware's own formats for the commands the tool offers,
// from the node's state in the demo. A `set` the plane admits changes that state, so the next `get`
// shows it, for as long as the page lives. Anything the table below does not know gets the
// firmware's answer to an unknown command. No DOM.
//
//   newState(world, node)          a node's settings as it starts
//   answer(state, command, ctx)    { code: 0, reply } ; ctx: { now (ms), neighbours: [{ key, secsAgo, snr4 }] }
//   KNOWN                          the command texts the answers cover (test/demo-answers.test.js
//                                  holds them against lib/data/commands.json)
import { DEMO_REGION } from './world.js';

export const UNKNOWN = 'Unknown command';

export function newState(world, n) {
  return {
    name: n.name, version: n.fw, boot: 40 + n.i, started: null, rebootUntil: 0,
    settings: {
      radio: '869.618,62.5,8,8', repeat: 'on', 'flood.max': '64', 'flood.max.unscoped': '16', txdelay: '0.5', 'direct.txdelay': '0.2',
      rxdelay: '0', af: '1.0', cad: 'on', 'int.thresh': '14', 'path.hash.mode': '2', 'loop.detect': 'on', 'multi.acks': '0',
      autoreply: 'on', 'autoreply.mode': 'channel', 'autoreply.hops': '2', 'autoreply.direct.flood': 'off', 'autoreply.private': 'off',
      'autoreply.region': DEMO_REGION, 'autoreply.slot': '1', 'autoreply.slots': '4', 'autoreply.window': '300',
      'mqtt.status': 'on', 'mqtt.packets': 'on', 'mqtt.raw': 'off', 'mqtt.neighbors': 'on', 'mqtt.iata': 'JKG', 'mqtt.interval': '300',
      'relay': n.kind === 'relay' ? 'own' : 'off', 'cmd': 'on demo.invalid',
    },
    switches: { powersaving: 'off', gps: 'off' },
    regions: { home: DEMO_REGION, default: 'se', list: ['*', DEMO_REGION, 'se'] },
    stats: { rx: 18000 + n.i * 911, tx: 4200 + n.i * 173, floods: 2600 + n.i * 87, direct: 900 + n.i * 31 },
  };
}

const two = (v) => String(v).padStart(2, '0');
// The firmware's clock line: "12:05 - 23/11/2026 UTC".
export const clockLine = (ms) => { const d = new Date(ms); return `${two(d.getUTCHours())}:${two(d.getUTCMinutes())} - ${d.getUTCDate()}/${d.getUTCMonth() + 1}/${d.getUTCFullYear()} UTC`; };

const SET_VALUE = /^[\x21-\x7e][\x20-\x7e]{0,60}$/;

// The reads, by their whole text.
const READS = {
  ver: (s) => s.version,
  board: () => 'Heltec V4 (demo)',
  memory: (s) => `free ${180000 - s.boot * 512} min ${96000 - s.boot * 128}`,
  clock: (s, c) => clockLine(c.now),
  region: (s) => `home ${s.regions.home}, default ${s.regions.default}: ${s.regions.list.join(' ')}`,
  neighbors: (s, c) => (c.neighbours.length ? c.neighbours.slice(0, 8).map((m) => `${m.key.slice(0, 8)}:${m.secsAgo}:${m.snr4}`).join('\n') : '-none-'),
  'get sensors': (s) => `batt=${3700 + (s.stats.rx % 400)}mV mcu=${18 + (s.stats.tx % 9)}.5C`,
  'get stats': (s, c) => `rx ${s.stats.rx} tx ${s.stats.tx} floods ${s.stats.floods} direct ${s.stats.direct} up ${Math.floor((c.now - s.started) / 1000)}s`,
  'get name': (s) => s.name,
  'get mqtt.presets': () => 'meshat, analyzer-eu, analyzer-us, mccontrol, custom',
  'ota check': (s) => `${s.version} is the newest for this board`,
  'clear stats': (s) => { s.stats = { rx: 0, tx: 0, floods: 0, direct: 0 }; return 'OK'; },
  'region save': () => 'OK',
};

export const KNOWN = Object.freeze([...Object.keys(READS), 'get', 'set', 'set name', 'region put', 'region allowf', 'region denyf', 'region remove',
  'region default', 'region home', 'powersaving', 'gps', 'reboot', 'clkreboot', 'ota update', 'trigger test', 'trigger private', 'neighbor.remove']);

export function answer(state, command, ctx) {
  const text = String(command || '').trim().replace(/\s+/g, ' ');
  const ok = (reply) => ({ code: 0, reply });
  if (text in READS) return ok(READS[text](state, ctx));
  const [verb, name = '', ...rest] = text.split(' ');
  const value = rest.join(' ');
  if (verb === 'get') return name in state.settings ? ok(state.settings[name]) : ok(UNKNOWN);
  if (verb === 'set' && name === 'name' && SET_VALUE.test(value)) { state.name = value.slice(0, 31); return ok('OK'); }
  if (verb === 'set' && name in state.settings && SET_VALUE.test(value)) { state.settings[name] = value; return ok('OK'); }
  if (verb === 'set' && /^mqtt[1-6]\.(preset|server|username|password)$/.test(name) && SET_VALUE.test(value)) return ok('OK');
  if (verb === 'region' && ['put', 'allowf', 'denyf'].includes(name) && value) {
    const r = value.split(' ')[0].toLowerCase();
    if (!state.regions.list.includes(r)) state.regions.list.push(r);
    return ok('OK');
  }
  if (verb === 'region' && name === 'remove' && value) { state.regions.list = state.regions.list.filter((r) => r !== value.toLowerCase()); return ok('OK'); }
  if (verb === 'region' && (name === 'home' || name === 'default') && value) { state.regions[name] = value.toLowerCase(); return ok('OK'); }
  // The bare switches: `powersaving on`, `gps off`; alone, the word reads it.
  if (verb in state.switches && !value) {
    if (!name) return ok(state.switches[verb]);
    if (name === 'on' || name === 'off') { state.switches[verb] = name; return ok('OK'); }
  }
  if (text === 'reboot' || text === 'clkreboot') { state.rebootUntil = ctx.now + 20000; return ok('OK - rebooting'); }
  if (verb === 'ota' && name === 'update') return ok(`${state.version} is the newest for this board`);
  // The plane does not let a remote command transmit: these never reach here from MQTT, and are
  // answered for the roads that admit them.
  if (verb === 'trigger') return ok('OK');
  if (verb === 'neighbor.remove' && name) return ok('OK');
  return ok(UNKNOWN);
}
