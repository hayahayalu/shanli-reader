'use strict';

/* ============================================================
   取色器 — 自绘（HSV 面板 + 色相条 + HEX/RGB + 透明度 + 预设色）
   回传：{ hex: '#rrggbb', alpha: 0~1 }
   ============================================================ */

const $ = (id) => document.getElementById(id);
const sv = $('sv');
const knob = $('knob');
const hueEl = $('hue');
const hueKnob = $('hueKnob');
const preview = $('preview');
const strip = $('strip');

const PRESETS = [
  '#000000', '#1a1a1a', '#2b2b2b', '#4a4a4a', '#7a7a7a',
  '#ffffff', '#f7f5f0', '#f5ecd9', '#faf3e0', '#efe6d2',
  '#cce8cf', '#dce9f7', '#f7dce4', '#f0e6f7', '#e6f4f1',
  '#ffd9a0', '#ffc9c9', '#c9e4ff', '#d9ffd9', '#ffe9b3',
  '#8b6f47', '#5b7d5b', '#476b8b', '#8b476b', '#6b5b8b',
  '#2f2a22', '#1b3a4b', '#3a1b2e', '#1b3a2e', '#3a2e1b',
  '#e8e4dc', '#c9a227', '#a83c3c', '#3c5ea8', '#3ca87a',
];

let h = 40;      // 0-360
let s = 0.10;    // 0-1
let v = 0.96;    // 0-1
let alpha = 1;

function hsvToRgb(hh, ss, vv) {
  const c = vv * ss;
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
  const m = vv - c;
  let r = 0, g = 0, b = 0;
  if (hh < 60)       { r = c; g = x; b = 0; }
  else if (hh < 120) { r = x; g = c; b = 0; }
  else if (hh < 180) { r = 0; g = c; b = x; }
  else if (hh < 240) { r = 0; g = x; b = c; }
  else if (hh < 300) { r = x; g = 0; b = c; }
  else               { r = c; g = 0; b = x; }
  return [
    Math.round((r + m) * 255),
    Math.round((g + m) * 255),
    Math.round((b + m) * 255),
  ];
}

function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let hh = 0;
  if (d !== 0) {
    if (max === r) hh = 60 * (((g - b) / d) % 6);
    else if (max === g) hh = 60 * ((b - r) / d + 2);
    else hh = 60 * ((r - g) / d + 4);
  }
  if (hh < 0) hh += 360;
  return [hh, max === 0 ? 0 : d / max, max];
}

const hex2 = (n) => n.toString(16).padStart(2, '0');
function toHex(r, g, b) {
  return '#' + hex2(r) + hex2(g) + hex2(b);
}

function parseHex(str) {
  let s = String(str || '').trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(s)) s = s.split('').map((c) => c + c).join('');
  if (!/^[0-9a-f]{6}$/i.test(s)) return null;
  return [
    parseInt(s.slice(0, 2), 16),
    parseInt(s.slice(2, 4), 16),
    parseInt(s.slice(4, 6), 16),
  ];
}

/* ---- 渲染 ---- */

function render(source) {
  const [r, g, b] = hsvToRgb(h, s, v);
  const hex = toHex(r, g, b);

  // SV 面板色相底
  sv.style.background = `hsl(${h}, 100%, 50%)`;
  knob.style.left = (s * 100) + '%';
  knob.style.top = ((1 - v) * 100) + '%';

  hueKnob.style.left = (h / 360 * 100) + '%';
  preview.style.background = hex;
  strip.style.background = hex;

  if (source !== 'hex') $('hex').value = hex;
  if (source !== 'rgb') {
    $('r').value = r;
    $('g').value = g;
    $('b').value = b;
  }
  $('alpha').value = Math.round(alpha * 100);
  $('alphaVal').textContent = Math.round(alpha * 100) + '%';
  strip.style.opacity = alpha;
}

function setFromRgb(r, g, b) {
  const [hh, ss, vv] = rgbToHsv(r, g, b);
  // 灰色时保留原色相，避免跳动
  if (ss > 0.001) h = hh;
  s = ss;
  v = vv;
}

/* ---- SV 面板拖动 ---- */

let svDrag = false;
function svPick(e) {
  const r = sv.getBoundingClientRect();
  s = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  v = 1 - Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
  render();
}

sv.addEventListener('mousedown', (e) => {
  svDrag = true;
  svPick(e);
  e.preventDefault();
});
window.addEventListener('mousemove', (e) => { if (svDrag) svPick(e); });
window.addEventListener('mouseup', () => { svDrag = false; });

/* ---- 色相条 ---- */

let hueDrag = false;
function huePick(e) {
  const r = hueEl.getBoundingClientRect();
  h = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * 360;
  render();
}
hueEl.addEventListener('mousedown', (e) => {
  hueDrag = true;
  huePick(e);
  e.preventDefault();
});
window.addEventListener('mousemove', (e) => { if (hueDrag) huePick(e); });
window.addEventListener('mouseup', () => { hueDrag = false; });

/* ---- 输入框 ---- */

$('hex').addEventListener('input', () => {
  const rgb = parseHex($('hex').value);
  if (!rgb) return;
  setFromRgb(rgb[0], rgb[1], rgb[2]);
  render('hex');
});
$('hex').addEventListener('blur', () => render());

['r', 'g', 'b'].forEach((k) => {
  $(k).addEventListener('input', () => {
    const r = Math.min(255, Math.max(0, parseInt($('r').value, 10) || 0));
    const g = Math.min(255, Math.max(0, parseInt($('g').value, 10) || 0));
    const b = Math.min(255, Math.max(0, parseInt($('b').value, 10) || 0));
    setFromRgb(r, g, b);
    render('rgb');
  });
});

/* ---- 透明度 ---- */

$('alpha').addEventListener('input', (e) => {
  alpha = Math.min(1, Math.max(0, (parseInt(e.target.value, 10) || 0) / 100));
  $('alphaVal').textContent = Math.round(alpha * 100) + '%';
  strip.style.opacity = alpha;
});

/* ---- 预设色 ---- */

PRESETS.forEach((c) => {
  const d = document.createElement('div');
  d.className = 'sw';
  d.style.background = c;
  d.title = c;
  d.onclick = () => {
    const rgb = parseHex(c);
    setFromRgb(rgb[0], rgb[1], rgb[2]);
    render();
  };
  $('swatches').appendChild(d);
});

/* ---- 按钮 ---- */

function result() {
  const [r, g, b] = hsvToRgb(h, s, v);
  return { hex: toHex(r, g, b), alpha };
}

$('ok').onclick = () => window.colorPicker.done(result());
$('cancel').onclick = () => window.colorPicker.cancel();

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.colorPicker.cancel();
  if (e.key === 'Enter') window.colorPicker.done(result());
});

/* ---- 初始化 ---- */

window.colorPicker.onInit((init) => {
  if (init && init.hex) {
    const rgb = parseHex(init.hex);
    if (rgb) setFromRgb(rgb[0], rgb[1], rgb[2]);
  }
  if (init && typeof init.alpha === 'number') alpha = init.alpha;
  render();
});

render();
