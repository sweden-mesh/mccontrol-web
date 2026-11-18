// Runs before the first paint, as a plain script loaded without defer right after the
// colour-scheme <meta> (a module would run after the page has painted in the wrong colours). The
// CSP's script-src 'self' allows it; there is no inline script. Two jobs:
//
// 1. The theme (W-20f): html[data-theme] = amber | green | dark | light, amber when nothing is
//    stored. Settings from before the one theme setting are moved over once: a terminal screen
//    (phosphor green/amber) wins, then colours light/dark, else amber; the colour-blind and
//    reduced-motion keys are removed. ui/prefs.js owns the keys and does the same (themeFrom,
//    migratePrefs); test/shell-boot.test.js runs this file against both.
//
// 2. The start guard (W-20k): if a module fails to load or to run before ui/app.js has drawn the
//    board (html[data-started]), say so in <main> instead of leaving a blank page. app.js catches
//    its own failures; this catches the ones that stop app.js from running at all. Plain text in
//    both languages, since the strings may be what failed.
(function boot() {
  var root = document.documentElement;
  var store = null;
  try { store = localStorage; } catch (e) { store = null; }
  var get = function (name) {
    try { return store ? store.getItem('mccontrol.' + name) : null; } catch (e) { return null; }
  };
  var THEMES = ['amber', 'green', 'dark', 'light'];
  var RETIRED = ['phosphor', 'cvd', 'motion'];

  var phosphor = get('phosphor');
  var theme = get('theme');
  if (phosphor === 'green' || phosphor === 'amber') theme = phosphor;
  if (THEMES.indexOf(theme) < 0) theme = 'amber';
  var old = RETIRED.some(function (name) { return get(name) !== null; });
  if (old) {
    try {
      if (theme === 'amber') store.removeItem('mccontrol.theme');
      else store.setItem('mccontrol.theme', theme);
      RETIRED.forEach(function (name) { store.removeItem('mccontrol.' + name); });
    } catch (e) { /* blocked: read again next time */ }
  }
  root.setAttribute('data-theme', theme);
  // The unlock gate (W-28b) until ui/app.js knows the key is unlocked: the page behind is not shown
  // before then, so it never flashes up under the unlock dialog.
  root.setAttribute('data-gate', '');
  // The layout (W-29): standard, the default, or the retro board; the standard layout's colours
  // (dark, the default, or light) and colour-blind mode. ui/prefs.js applies the same.
  var layout = get('layout') === 'retro' ? 'retro' : 'standard';
  var scheme = get('scheme') === 'light' ? 'light' : 'dark';
  root.setAttribute('data-layout', layout);
  root.setAttribute('data-scheme', scheme);
  if (get('colorblind') === 'on') root.setAttribute('data-colorblind', '');
  var meta = document.querySelector('meta[name="color-scheme"]');
  var light = layout === 'standard' ? scheme === 'light' : theme === 'light';
  if (meta) meta.setAttribute('content', light ? 'light' : 'dark');

  var fail = function (reason) {
    if (root.hasAttribute('data-started') || root.hasAttribute('data-start-failed')) return;
    var main = document.getElementById('main');
    if (!main) return;
    root.setAttribute('data-start-failed', '');
    var sv = /^sv\b/i.test(navigator.language || '');
    var el = function (tag, cls, text) {
      var e = document.createElement(tag);
      if (cls) e.className = cls;
      if (text) e.textContent = text;
      return e;
    };
    var box = el('section', 'start-error');
    box.setAttribute('aria-labelledby', 'start-error-title');
    var title = el('h1', null, sv ? 'mccontrol kunde inte starta i den här webbläsaren'
      : 'mccontrol could not start in this browser');
    title.id = 'start-error-title';
    var what = el('textarea', 'start-error-reason');
    what.readOnly = true;
    what.rows = 3;
    what.value = String(reason);
    what.setAttribute('aria-label', sv ? 'Orsaken' : 'The reason');
    box.append(title,
      el('p', null, sv ? 'Orsaken, att kopiera till en felrapport:' : 'The reason, to copy into a bug report:'),
      what,
      el('p', null, sv ? 'Prova att ladda om sidan, eller öppna den i ett privat fönster.'
        : 'Try reloading the page, or open it in a private window.'));
    main.replaceChildren(box);
  };
  addEventListener('error', function (e) {
    var target = e.target;
    if (target && target.tagName === 'SCRIPT') fail('could not load ' + (target.src || 'a script'));
    else if (target === window || !target || !target.tagName) fail(e.error && e.error.stack ? e.error.stack : e.message);
  }, true);
}());
