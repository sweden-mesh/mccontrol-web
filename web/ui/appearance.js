// The display settings as a form: the theme (Amber, Green, Dark, Light) and the language,
// nothing else (W-20f, W-20g). Setup's display tab shows it; the settings screen may show the
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

// A change of language reaches the shell as a settings change (onPrefsChange), which redraws.
export function displaySettings({ t }) {
  const p = currentPrefs();
  const change = (name, value) => setPref(name, value);
  return h('div', { class: 'display-settings' },
    radios('theme', t('display.theme'), {
      amber: t('display.amber'), green: t('display.green'), dark: t('display.dark'), light: t('display.light'),
    }, p.theme, change),
    radios('lang', t('display.lang'), {
      browser: t('display.browserLang'), sv: { lang: 'sv', text: 'Svenska' }, en: { lang: 'en', text: 'English' },
    }, p.lang, change));
}
