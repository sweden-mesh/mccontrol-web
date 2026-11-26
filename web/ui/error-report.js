// The status lines as text for the clipboard: what a person pastes when asking for help. Clicking
// a status line that shows an error copies every line, the errors first-marked, with the app's
// version, the browser and the time. No key, no node and no passphrase is in it.
import { readVersion } from './update.js';
import { keyStatus } from './screens/key-session.js';
import { state as companionState } from './companion-session.js';
import { source } from './tiles/sources.js';

const MARK = { ok: 'ok', alert: 'ERROR', warn: 'warning', running: 'running', unknown: 'unknown' };

// Pure: `lines` are { name, state, detail, hosts, last }.
export function reportText({ version, now, userAgent, online, address, lines }) {
  const head = [`mccontrol ${version}`, new Date(now).toISOString(), userAgent, `address: ${address}`, `browser online: ${online}`];
  const body = lines.map((l) => {
    const more = [l.hosts?.length ? `hosts: ${l.hosts.join(', ')}` : null, l.detail || null,
      Number.isFinite(l.last) ? `last: ${new Date(l.last).toISOString()}` : null].filter(Boolean).join(' | ');
    return `[${MARK[l.state] || l.state || 'unknown'}] ${l.name}${more ? `: ${more}` : ''}`;
  });
  return [...head, '', ...body].join('\n');
}

export async function currentReport() {
  const lines = ['broker', 'registration', 'refresh', 'discovery'].map((name) => {
    const st = source(name)?.state?.() || { state: 'unknown', detail: 'no source' };
    return { name, state: st.state, detail: st.detail || (st.word ? String(st.word) : null), hosts: st.hosts, last: st.last ?? st.at ?? null };
  });
  const k = keyStatus();
  lines.splice(1, 0, { name: 'key', state: k.locked ? 'warn' : k.exists ? 'ok' : 'unknown', detail: k.locked ? 'locked' : k.exists ? 'unlocked' : 'none' });
  const c = companionState();
  lines.push({ name: 'companion', state: c.status === 'error' ? 'alert' : c.status === 'connected' ? 'ok' : 'unknown', detail: [c.status, c.kind, c.error].filter(Boolean).join(' ') });
  const v = await readVersion();
  return reportText({ version: v.version, now: Date.now(), userAgent: navigator.userAgent, online: navigator.onLine,
    address: location.origin + location.pathname, lines });
}

// Copies the report and says so; a browser that refuses the clipboard gets the text in a message.
export async function copyReport(ctx) {
  const text = await currentReport();
  try {
    await navigator.clipboard.writeText(text);
    ctx.notify(ctx.t('report.copied'));
  } catch {
    ctx.notify(`${ctx.t('report.refused')}\n${text}`, { kind: 'warning' });
  }
}
