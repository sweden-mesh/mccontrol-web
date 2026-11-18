// The display settings as a form: the layout (standard or the retro board, W-29), the standard
// layout's dark or light and colour-blind mode, the retro board's theme (Amber, Green, Dark,
// Light) and the language (W-20f, W-20g). Setup's display tab shows it; the settings screen may show the
// same form with displaySettings(ctx). Every change applies at once (ui/prefs.js).
import { h } from './dom.js';
import { CHOICES, currentPrefs, setPref } from './prefs.js';

let serial = 0;

function radios(name, legend, labels, value, change) {
  const id = `pref-${name}-${++serial}`;
  return h('fieldset', { class: 'choice' },
    h('legend', {}, legend),
    CHOICES[name].map((choice) => {
      const input = h('input', { type: 'radio', name: id, value: choice, checked: choice === value });
      input.addEventListener('change', () => { if (input.checked) change(name, choice); });
      const text = labels[choice];
      return h('label', {}, input, ' ', typeof text === 'string' ? text : h('span', { lang: text.lang }, text.text));
    }));
}

// The colour-blind setting (W-29c) as one checkbox.
function checkbox(name, label, value, change) {
  const input = h('input', { type: 'checkbox', checked: value === 'on' });
  input.addEventListener('change', () => change(name, input.checked ? 'on' : 'off'));
  return h('label', { class: 'choice-check' }, input, ' ', label);
}

// The layout alone (W-29): Setup's display tab and the unlock gate's first start.
export function layoutChoice({ t }) {
  const p = currentPrefs();
  return radios('layout', t('display.layout'), { standard: t('display.standard'), retro: t('display.retro') }, p.layout, (n, v) => setPref(n, v));
}

// A change of language reaches the shell as a settings change (onPrefsChange), which redraws.
// The layout first; the standard layout's colours and colour-blind mode (W-29b, W-29c); the
// retro board's theme; the language.
export function displaySettings({ t }) {
  const p = currentPrefs();
  const change = (name, value) => setPref(name, value);
  return h('div', { class: 'display-settings' },
    layoutChoice({ t }),
    radios('scheme', t('display.scheme'), { dark: t('display.schemeDark'), light: t('display.schemeLight') }, p.scheme, change),
    checkbox('colorblind', t('display.cvd'), p.colorblind, change),
    radios('theme', t('display.retroTheme'), {
      amber: t('display.amber'), green: t('display.green'), dark: t('display.dark'), light: t('display.light'),
    }, p.theme, change),
    radios('lang', t('display.lang'), {
      browser: t('display.browserLang'), sv: { lang: 'sv', text: 'Svenska' }, en: { lang: 'en', text: 'English' },
    }, p.lang, change));
}
