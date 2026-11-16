// The app shell: picks the language, then draws the screen the address names into <main>.
// Hash routes (#/nodes, #/node/4AC61A7F) keep every screen working from a static host and
// from a local file server alike.
import { pickLanguage, translator, loadStrings } from '../i18n/i18n.js';
import { SCREENS, NOT_FOUND } from './screens/index.js';

export function routeOf(hash) {
  const path = String(hash || '').replace(/^#\/?/, '');
  const [name, ...args] = path.split('/');
  return { name: name || '', args: args.map(decodeURIComponent) };
}

export function screenFor(name) {
  return SCREENS.find((s) => s.route === name) || NOT_FOUND;
}

async function start() {
  const lang = pickLanguage(navigator.languages || [navigator.language]);
  document.documentElement.lang = lang;
  const t = translator(await loadStrings(lang));
  document.getElementById('subtitle').textContent = t('app.subtitle');
  document.getElementById('skip').textContent = t('app.skip');
  const main = document.getElementById('main');

  const draw = () => {
    if (location.hash && !location.hash.startsWith('#/')) return;   // an in-page anchor, not a route
    const { name, args } = routeOf(location.hash);
    main.replaceChildren(screenFor(name).render({ t, lang, args }));
  };
  addEventListener('hashchange', draw);
  draw();
}

if (typeof document !== 'undefined') start();
