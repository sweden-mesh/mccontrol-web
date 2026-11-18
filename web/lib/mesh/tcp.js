// The companion over the network (W-31c), through mccontrol-bridge: one WebSocket to the bridge,
// which holds the TCP connection to a Wi-Fi companion (or a mux in front of it). The same shape
// as ble.js: one binary WebSocket message is one companion frame, each way, with no '<'/'>'
// header. With a token (the bridge runs with TLS) it is sent as the first, text, message.
//
//   const link = await connectNetwork('ws://192.168.1.20:8765')   // from a click: Chrome asks
//   const companion = await openCompanion(link)                    // about the local network
//
// An https page may open plain ws:// only to a private IP literal (Chrome/Edge 147+, behind the
// one-time "local network" prompt); a name over ws:// is mixed content and blocked, so it needs
// wss://. The bridge refuses an origin, a Host or a second page at the handshake, which a browser
// reports only as "closed before it opened"; what is known is said, and the likely causes when not.
// A thrown error carries `code` (below) and a sentence a person can read.

// codes: 'badUrl', 'mixedContent', 'unreachable' (closed before open: the local-network prompt
// refused, the bridge not running, or it refused this page's origin or address), 'token' (1008),
// 'busy' (1013: another page attached), 'companion' (1011: the bridge cannot reach the companion),
// 'tooBig' (1009), 'text' (1003).
const CLOSE_CODES = Object.freeze({
  1003: ['text', 'the bridge takes binary frames only'],
  1008: ['token', 'the bridge refused the token'],
  1009: ['tooBig', 'a frame was larger than the bridge takes'],
  1011: ['companion', 'the bridge cannot reach the companion'],
  1013: ['busy', 'another page is already attached to the bridge'],
});

export class NetworkError extends Error {
  constructor(code, message) { super(message); this.name = 'NetworkError'; this.code = code; }
}

const PRIVATE_V4 = [/^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^127\./, /^169\.254\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./];

// Is `host` an address Chrome lets an https page reach over plain ws:// (a private or loopback
// IP literal)? A name is not, whatever it resolves to.
export function privateLiteral(host) {
  const h = String(host || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return PRIVATE_V4.some((r) => r.test(h));
  if (h.includes(':')) return h === '::1' || /^f[cd]/.test(h) || /^fe[89ab]/.test(h);
  return false;
}

// The bridge's address, checked: ws:// or wss://, a host and a port, nothing after the port.
// From an https page, ws:// must name a private IP literal. Returns the normalised URL text.
export function bridgeUrl(text, { pageSecure = globalThis.isSecureContext !== false && globalThis.location?.protocol === 'https:' } = {}) {
  let url;
  try { url = new URL(String(text || '').trim()); } catch { throw new NetworkError('badUrl', 'give the bridge as ws://IP:port or wss://name:port'); }
  if (!['ws:', 'wss:'].includes(url.protocol) || !url.hostname || !url.port || (url.pathname && url.pathname !== '/') || url.search || url.hash || url.username) {
    throw new NetworkError('badUrl', 'give the bridge as ws://IP:port or wss://name:port');
  }
  if (url.protocol === 'ws:' && pageSecure && !privateLiteral(url.hostname)) {
    throw new NetworkError('mixedContent', 'ws:// reaches only a private IP address from this page; use the bridge\'s IP, or wss:// with a certificate');
  }
  return `${url.protocol}//${url.host}`;
}

export const networkAvailable = (g = globalThis) => typeof g.WebSocket === 'function';

export async function connectNetwork(address, { token = '', WebSocket: Socket = globalThis.WebSocket, timeoutMs = 10000, pageSecure } = {}) {
  if (typeof Socket !== 'function') throw new NetworkError('unreachable', 'this browser has no WebSocket');
  const url = bridgeUrl(address, pageSecure === undefined ? {} : { pageSecure });
  let ws;
  try {
    ws = new Socket(url);
  } catch (e) {
    // Chrome throws SecurityError for mixed content it will not even try
    throw new NetworkError(e?.name === 'SecurityError' ? 'mixedContent' : 'unreachable', e?.message || String(e));
  }
  ws.binaryType = 'arraybuffer';
  let frameFn = () => {};
  let closeFn = () => {};
  let opened = false;
  let closed = false;
  let failure = null;          // why the bridge closed, from its close code

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { try { ws.close(); } catch { /* not open */ } reject(new NetworkError('unreachable', `no answer from ${url} in ${Math.round(timeoutMs / 1000)} s`)); }, timeoutMs);
    ws.onopen = () => { clearTimeout(timer); opened = true; resolve(); };
    ws.onclose = (e) => {
      clearTimeout(timer);
      closed = true;
      const known = CLOSE_CODES[e?.code];
      failure = known ? new NetworkError(known[0], known[1]) : null;
      if (!opened) {
        reject(failure || new NetworkError('unreachable', `${url} closed before it opened: the browser's local-network permission was refused, the bridge is not running there, or it refused this page (its origin or address)`));
      } else {
        closeFn(failure);
      }
    };
    ws.onerror = () => { /* the close that follows says why */ };
  });

  ws.onmessage = (e) => {
    if (typeof e.data === 'string') return;          // the bridge sends frames only
    frameFn(new Uint8Array(e.data));
  };
  if (token) ws.send(String(token));

  const host = new URL(url).host;
  return {
    kind: 'network',
    label: host,
    get failure() { return failure; },
    onFrame(fn) { frameFn = fn; },
    onClose(fn) { closeFn = fn; if (closed) fn(failure); },
    async write(bytes) {
      if (closed || ws.readyState !== 1) throw failure || new NetworkError('unreachable', 'the bridge connection is closed');
      ws.send(bytes);
    },
    async close() { if (!closed) ws.close(1000); },
  };
}
