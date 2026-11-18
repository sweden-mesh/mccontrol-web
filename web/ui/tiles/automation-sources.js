// The page's automatic work (ui/automation.js: discovery by itself, the 15-minute Beacon refresh
// and the daily `ver`) as the STATUS tile's 'discovery' and 'refresh' lines (sources.js), and its
// "nodes changed" as a dataChanged('devices') so NODES and MAP reload after discovery adds or an
// undo removes nodes. Registration by itself (ui/screens/key-register.js) is the 'registration'
// line. No DOM.
import { automationState, onAutomation, lookNow, refreshNow, undoDiscovery } from '../automation.js';
import { onRegistration, registerNow, registration } from '../screens/key-register.js';
import { dataChanged, provideSource } from './sources.js';

const listeners = new Set();
const on = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

// lib/refresh's state as a status line: Beacon's last pass and the next.
export function refreshLine(s) {
  const r = s?.refresh;
  if (!s?.owner || !r) return { state: 'unknown', last: null, next: null, detail: null };
  if (r.running) return { state: 'running', last: r.beacon.lastRun, next: null, detail: null };
  return {
    state: r.beacon.error ? 'alert' : r.beacon.lastRun ? 'ok' : 'unknown',
    last: r.beacon.lastRun, next: r.beacon.nextRun, detail: r.beacon.error || null,
  };
}

// lib/discovery's state as a status line: running, or its last and next run. A failure names no
// region (IATA-2): it says what failed.
export function discoveryLine(s) {
  const d = s?.discovery;
  if (!s?.owner || !d) return { state: 'unknown', last: null, next: null, detail: null, canUndo: false };
  const failed = !d.running && d.last && !d.last.undone ? d.last.failed || [] : [];
  return {
    state: d.running ? 'running' : failed.length ? 'alert' : d.lastRun ? 'ok' : 'unknown',
    last: d.lastRun, next: d.nextRun, canUndo: d.canUndo,
    detail: failed.length ? [...new Set(failed.map((f) => f.detail))].join('; ') : null,
  };
}

// The registrar's state as a status line: ok, partial (some brokers), failed, running, not known.
const REG = Object.freeze({ ok: 'ok', partial: 'warn', failed: 'alert', running: 'running', none: 'unknown' });
export function registrationLine(r) {
  const hosts = r?.hosts || [];
  const bad = hosts.filter((x) => x.state === 'failed');
  return {
    state: REG[r?.state] || 'unknown',
    last: hosts.reduce((m, x) => (x.at && x.at > (m ?? 0) ? x.at : m), null),
    next: null,
    detail: bad.length ? bad.map((x) => `${x.host}: ${x.detail}`).join('; ') : null,
  };
}

export function useAutomation() {
  provideSource('registration', { state: () => registrationLine(registration()), on: (fn) => onRegistration(() => fn()), run: () => registerNow() });
  onAutomation((s) => {
    if (s.changed === 'nodes' || s.changed === 'refresh') dataChanged('devices');
    for (const fn of listeners) fn();
  });
  provideSource('refresh', { state: () => refreshLine(automationState()), on, run: () => refreshNow() });
  provideSource('discovery', {
    state: () => discoveryLine(automationState()), on, run: () => lookNow(),
    undo: () => undoDiscovery(),
  });
}
