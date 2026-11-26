// What the board's tiles share besides the selection (ui/board-state.js): the states the STATUS
// tile shows, the jobs HISTORY draws as bars, and a "the stores changed" signal. No DOM, so a
// test or another module can drive it. One store for the page.
//
// STATUS lines (W-20e, W-20a). Whoever owns a line provides it; until then the STATUS tile draws
// its own stand-in (said in ui/tiles/status.js):
//
//   provideSource(name, src)      name: 'broker' | 'registration' | 'refresh' | 'discovery'
//       src.state()  -> { state: 'ok' | 'warn' | 'alert' | 'unknown' | 'running',
//                         last: epoch ms | null,     when it last ran or answered
//                         next: epoch ms | null,     when it runs by itself next (refresh, discovery)
//                         detail: string | null }    a sentence for the line's title (already translated)
//       src.on(fn)   -> unsubscribe; fn() whenever state() changes
//       src.run()    -> Promise (optional): the line's action ("Refresh now", "Look now", "Register")
//     returns a function that withdraws it. The discovery and refresh work (lib/) provides
//     'refresh' and 'discovery'; automatic registration provides 'registration'.
//   source(name)                  the provided source, or null
//   onSources(fn)                 fn() after a provide or a withdraw; returns unsubscribe
//
//   reportBroker({ ok, detail })  what the last connection to the broker did; the stand-in
//                                 'broker' line shows it (a send, a test, discovery may all report)
//   brokerReport()                { ok, detail, at } | null
//
// Jobs (HISTORY's bars):
//   startJob({ label, command, nodes })  -> { progress(fraction | null, text), done() }; label is the line;
//                                 command and nodes let a node's own view show it as pending
//   jobs()                        [{ id, label, fraction, text }] running now
//   onJobs(fn)                    returns unsubscribe
//
// Stores changed (a send landed, discovery adopted a node, Beacon refreshed):
//   dataChanged(what)             what: 'history' | 'devices' | 'seen' | anything
//   onDataChanged(fn)             fn(what); returns unsubscribe

export const SOURCE_NAMES = Object.freeze(['broker', 'registration', 'refresh', 'discovery']);

const sources = new Map();
const sourceListeners = new Set();
const tellSources = () => { for (const fn of sourceListeners) fn(); };

export function provideSource(name, src) {
  if (!SOURCE_NAMES.includes(name)) throw new Error(`no status line ${name}: ${SOURCE_NAMES.join(', ')}`);
  if (typeof src?.state !== 'function') throw new Error(`source ${name}: state must be a function`);
  sources.set(name, src);
  tellSources();
  return () => { if (sources.get(name) === src) { sources.delete(name); tellSources(); } };
}

export const source = (name) => sources.get(name) || null;

export function onSources(fn) {
  sourceListeners.add(fn);
  return () => sourceListeners.delete(fn);
}

let broker = null;
export function reportBroker({ ok, detail = null }, at = Date.now()) {
  broker = Object.freeze({ ok: Boolean(ok), detail, at });
  tellSources();
}
export const brokerReport = () => broker;

// -- jobs -------------------------------------------------------------------------------------

const running = new Map();
const jobListeners = new Set();
let serial = 0;
const tellJobs = () => { for (const fn of jobListeners) fn(); };

export function startJob({ label, command = '', nodes = [] }) {
  const id = `j${serial += 1}`;
  const base = { id, label, command, nodes: [...nodes], at: Date.now() };
  running.set(id, { ...base, fraction: null, text: '' });
  tellJobs();
  return Object.freeze({
    id,
    // `until` (ms): when the wait gives up, where the sender knows; a node's view counts down to it.
    progress(fraction, text = '', until = null) {
      if (!running.has(id)) return;
      running.set(id, { ...base, fraction: Number.isFinite(fraction) ? Math.max(0, Math.min(1, fraction)) : null, text,
        until: Number.isFinite(until) ? until : null });
      tellJobs();
    },
    done() { if (running.delete(id)) tellJobs(); },
  });
}

export const jobs = () => [...running.values()];

export function onJobs(fn) {
  jobListeners.add(fn);
  return () => jobListeners.delete(fn);
}

// -- stores changed ---------------------------------------------------------------------------

const dataListeners = new Set();
export function dataChanged(what = 'any') { for (const fn of dataListeners) fn(what); }
export function onDataChanged(fn) {
  dataListeners.add(fn);
  return () => dataListeners.delete(fn);
}
