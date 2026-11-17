// Applies this device's display settings before the first paint: colour scheme, phosphor theme,
// colour-blind palette, reduced motion. A plain script, loaded without defer right after the
// colour-scheme <meta>, because a module would run after the page has painted in the wrong
// colours. The CSP's script-src 'self' allows it; there is no inline script. The settings are
// written by ui/prefs.js, which owns the keys; this file only reads them.
(function boot() {
  var root = document.documentElement;
  var get = function (name) {
    try { return localStorage.getItem('mccontrol.' + name); } catch (e) { return null; }
  };
  var phosphor = get('phosphor');
  var theme = get('theme');
  if (phosphor === 'green' || phosphor === 'amber') {
    root.setAttribute('data-phosphor', phosphor);
    theme = 'dark';
  }
  if (theme === 'light' || theme === 'dark') {
    document.querySelector('meta[name="color-scheme"]').setAttribute('content', theme);
  }
  if (get('cvd') === '1') root.setAttribute('data-cvd', '1');
  if (get('motion') === 'off') root.setAttribute('data-motion', 'off');
}());
