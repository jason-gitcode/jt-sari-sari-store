// Per-tenant OpenGraph card renderer (name + optional logo on the Pabili Mart
// brand card). Used by the ogImage HTTP function. Satori (HTML/CSS-ish → SVG)
// + resvg (SVG → PNG). Satori is ESM-only, so it's loaded via dynamic import
// from this CommonJS module.
const fs = require('fs');
const path = require('path');
const { Resvg } = require('@resvg/resvg-js');

// Fonts bundled with the function (Roboto, Apache-2.0). Loaded once per instance.
const FONT_BOLD = fs.readFileSync(path.join(__dirname, 'assets', 'Roboto-Bold.ttf'));
const FONT_REG = fs.readFileSync(path.join(__dirname, 'assets', 'Roboto-Regular.ttf'));

let _satori = null;
async function getSatori() {
  if (!_satori) _satori = (await import('satori')).default;
  return _satori;
}

// Minimal hyperscript so we can describe the card without JSX in CommonJS.
function h(type, style, children) {
  return { type, props: { style, children } };
}

// First letters of the first two words, uppercased — the no-logo fallback badge.
function initialsOf(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return 'PM';
  const a = words[0][0] || '';
  const b = words.length > 1 ? (words[words.length - 1][0] || '') : '';
  return (a + b).toUpperCase().slice(0, 2) || 'PM';
}

// Bigger type for short names, smaller for long ones; the container wraps.
function nameFontSize(name) {
  const n = String(name || '').length;
  if (n <= 14) return 88;
  if (n <= 22) return 68;
  if (n <= 32) return 52;
  return 42;
}

// Build the card element tree. logoDataUrl is optional (data: URL).
function buildCard(name, logoDataUrl) {
  let badge;
  if (logoDataUrl) {
    badge = h('img', { width: 168, height: 168, borderRadius: 84, objectFit: 'cover',
      border: '4px solid rgba(255,255,255,0.85)' }, undefined);
    badge.props.src = logoDataUrl; // img needs src on props, not style
  } else {
    badge = h('div', {
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      width: 168, height: 168, borderRadius: 84,
      background: 'rgba(255,255,255,0.16)', border: '4px solid rgba(255,255,255,0.4)',
      fontSize: 72, fontWeight: 700, color: '#ffffff'
    }, initialsOf(name));
  }

  return h('div', {
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    width: '100%', height: '100%', padding: '60px',
    backgroundImage: 'linear-gradient(135deg, #2563eb 0%, #1e40af 100%)',
    fontFamily: 'Roboto', textAlign: 'center'
  }, [
    badge,
    h('div', {
      display: 'flex', marginTop: 36, maxWidth: 1040,
      fontSize: nameFontSize(name), fontWeight: 700, color: '#ffffff',
      lineHeight: 1.1, letterSpacing: -1, textAlign: 'center'
    }, name),
    h('div', {
      display: 'flex', marginTop: 22, fontSize: 30, fontWeight: 400,
      color: 'rgba(255,255,255,0.92)'
    }, 'Order online — delivery or pick-up'),
    h('div', {
      display: 'flex', position: 'absolute', bottom: 40,
      fontSize: 22, color: 'rgba(255,255,255,0.7)', letterSpacing: 1
    }, 'Powered by Pabili Mart')
  ]);
}

// Render the card to a PNG Buffer. Throws on failure (caller falls back).
async function renderOgCardPng({ name, logoDataUrl }) {
  const satori = await getSatori();
  const svg = await satori(buildCard(name || 'Pabili Mart', logoDataUrl || null), {
    width: 1200, height: 630,
    fonts: [
      { name: 'Roboto', data: FONT_BOLD, weight: 700, style: 'normal' },
      { name: 'Roboto', data: FONT_REG, weight: 400, style: 'normal' }
    ]
  });
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: 1200 } }).render().asPng();
  return png;
}

module.exports = { renderOgCardPng };
