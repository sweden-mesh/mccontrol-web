// The four themes (W-20f) meet WCAG AA: every text token 4.5:1 on --bg and on --surface, the
// control outline 3:1 (1.4.11). Read from styles/tokens.css, so a colour change is checked here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const CSS = readFileSync(new URL('../styles/tokens.css', import.meta.url), 'utf8');
const THEMES = ['amber', 'green', 'dark', 'light'];
const TEXT = ['--fg', '--strong', '--muted', '--accent', '--accent-2', '--online', '--warn', '--caution', '--danger', '--info'];

export function themeTokens(theme) {
  const block = CSS.match(new RegExp(`(?:^|\\n)[^\\n{]*:root\\[data-theme="${theme}"\\][^{]*\\{([^}]*)\\}`))?.[1];
  assert.ok(block, `no block for ${theme}`);
  return Object.fromEntries([...block.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(([, k, v]) => [k, v.trim()]));
}

function luminance(hex) {
  const [r, g, b] = hex.replace('#', '').match(/../g).map((x) => parseInt(x, 16) / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

test('Amber is the default: the plain :root block is Amber', () => {
  assert.match(CSS, /:root, :root\[data-theme="amber"\] \{/);
});

for (const theme of THEMES) {
  test(`${theme}: text 4.5:1 and outlines 3:1 on the background and the surface`, () => {
    const tk = themeTokens(theme);
    for (const ground of ['--bg', '--surface']) {
      for (const name of TEXT) {
        assert.match(tk[name] || '', /^#[0-9a-f]{6}$/i, `${theme} ${name}`);
        const ratio = contrast(tk[name], tk[ground]);
        assert.ok(ratio >= 4.5, `${theme} ${name} on ${ground}: ${ratio.toFixed(2)}`);
      }
      const outline = contrast(tk['--field-border'], tk[ground]);
      assert.ok(outline >= 3, `${theme} --field-border on ${ground}: ${outline.toFixed(2)}`);
    }
    // The inverse alert line (Amber, Green) or the danger colour on the ground (Dark, Light).
    const alertBg = tk['--alert-bg'] === 'transparent' ? tk['--bg'] : tk['--alert-bg'];
    assert.ok(contrast(tk['--alert-fg'], alertBg) >= 4.5, `${theme} alert line`);
  });
}

test('mono only in Amber and Green; Plex Sans in Dark and Light', () => {
  for (const theme of THEMES) {
    const font = themeTokens(theme)['--font-body'];
    assert.equal(font, ['amber', 'green'].includes(theme) ? 'var(--font-mono)' : 'var(--font-sans)', theme);
  }
});

test('the status colours of Dark and Light are Okabe-Ito (colour-blind safe), no red against green', () => {
  const okabe = new Set(['#0072b2', '#56b4e9', '#e69f00', '#a35a00', '#f0e442', '#7a6a00', '#a3446f', '#e48fc0']);
  for (const theme of ['dark', 'light']) {
    const tk = themeTokens(theme);
    for (const name of ['--online', '--warn', '--caution', '--danger']) assert.ok(okabe.has(tk[name]), `${theme} ${name} ${tk[name]}`);
  }
});

test('no retired setting is left in the styles or the scripts', () => {
  for (const file of ['../styles/tokens.css', '../styles/app.css', '../ui/prefs.js', '../ui/appearance.js']) {
    const src = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.ok(!/data-(cvd|motion|phosphor)/.test(src), file);
  }
});
