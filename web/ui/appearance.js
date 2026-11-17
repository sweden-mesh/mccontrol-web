// The display settings as a form: colour scheme, phosphor theme, colour-blind palette, reduced
// motion and language. The header's "Display" panel shows it; the settings screen may show the
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

function checkbox(name, label, on, change) {
  const input = h('input', { type: 'checkbox', checked: on });
  input.addEventListener('change', () => change(name, input.checked ? CHOICES[name][1] : CHOICES[name][0]));
  return h('label', { class: 'check' }, input, ' ', label);
}

// A change of language reaches the shell as a settings change (onPrefsChange), which redraws.
export function displaySettings({ t }) {
  const p = currentPrefs();
  const change = (name, value) => setPref(name, value);
  return h('div', { class: 'display-settings' },
    radios('theme', t('display.theme'), {
      system: t('display.system'), light: t('display.light'), dark: t('display.dark'),
    }, p.theme, change),
    radios('phosphor', t('display.phosphor'), {
      off: t('display.off'), green: t('display.green'), amber: t('display.amber'),
    }, p.phosphor, change),
    h('p', { class: 'hint' }, t('display.phosphorHint')),
    h('fieldset', { class: 'choice' },
      h('legend', {}, t('display.access')),
      checkbox('cvd', t('display.cvd'), p.cvd === 'on', change),
      checkbox('motion', t('display.motion'), p.motion === 'reduce', change)),
    radios('lang', t('display.lang'), {
      browser: t('display.browserLang'), sv: { lang: 'sv', text: 'Svenska' }, en: { lang: 'en', text: 'English' },
    }, p.lang, change));
}
