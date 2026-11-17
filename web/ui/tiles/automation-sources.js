// The page's automatic work (ui/automation.js: discovery by itself, the 15-minute Beacon refresh
// and the daily `ver`) as the STATUS tile's 'discovery' and 'refresh' lines (sources.js), and its
// "nodes changed" as a dataChanged('devices') so NODES and MAP reload after discovery adds or an
// undo removes nodes. No DOM; strings come from the getter `t`.
import { automationState, onAutomation, lookNow, refreshNow, undoDiscovery } from '../automation.js';
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

// lib/discovery's state as a status line: needs an area, running, or its last and next run.
export function discoveryLine(s) {
  const d = s?.discovery;
  if (!s?.owner || !d) return { state: 'unknown', last: null, next: null, detail: null, needsArea: false, canUndo: false };
  const failed = !d.running && d.last && !d.last.undone ? d.last.failed || [] : [];
  return {
    state: d.running ? 'running' : d.needsArea ? 'warn' : failed.length ? 'alert' : d.lastRun ? 'ok' : 'unknown',
    last: d.lastRun, next: d.nextRun, needsArea: d.needsArea, canUndo: d.canUndo,
    detail: failed.length ? failed.map((f) => `${f.region}: ${f.detail}`).join('; ') : null,
  };
}

export function useAutomation() {
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
