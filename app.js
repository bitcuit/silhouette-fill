'use strict';

const $ = id => document.getElementById(id);
const MASK_MAX = 1400;     // 윤곽 분석 해상도 상한 (긴 변, px)
const PREVIEW_CAP = 4096;  // 미리보기 캔버스 상한 (긴 변)
const OUT_MAX = 8000;      // 저장 캔버스 상한

const state = {
  img: null, name: 'image',
  dpi: null,               // 원본 파일에 적힌 해상도 {x, y} (없으면 null)
  zoom: null,              // 미리보기 배율 (원본 1px 기준). null이면 화면에 맞춤
  mw: 0, mh: 0,            // 분석 해상도
  rgba: null,              // 분석 해상도 원본 픽셀
  mask: null,              // 0~255, 경계값 이상이면 모양 안쪽
  down: null, downKey: '',  // 열마다 아래로 이어지는 모양 안쪽 길이 (getDownRuns)
  opaque: false,
  fonts: [],
  tiles: [],               // 포토 모자이크 타일 이미지 {bmp, sx, sy, side, avg, name, thumb}
};

// ---------- 글꼴 ----------
const USER_FONTS_KEY = 'silhouette-text.fonts';

// 웹폰트 CSS나 글꼴 파일을 문서에 붙인다
function attachFont(f) {
  if (f.css) {
    return new Promise((resolve, reject) => {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = f.css;
      link.onload = () => { resolve(); schedule(); };
      link.onerror = () => { link.remove(); reject(new Error('css')); };
      document.head.appendChild(link);
    });
  }
  if (f.file) {
    const face = new FontFace(f.family, `url("${f.file}")`);
    document.fonts.add(face);
    return face.load().then(schedule, err => { document.fonts.delete(face); throw err; });
  }
  return Promise.resolve();
}

function addFontOption(f) {
  state.fonts.push(f);
  const opt = new Option(f.name || f.family, String(state.fonts.length - 1));
  $('font').add(opt);
  return opt;
}

function saveUserFonts() {
  const list = state.fonts.filter(f => f && f.user).map(({ name, family, css, file }) => ({ name, family, css, file }));
  try { localStorage.setItem(USER_FONTS_KEY, JSON.stringify(list)); } catch {}
}

function setupFonts() {
  let list = Array.isArray(window.FONT_LIST) ? window.FONT_LIST.filter(f => f && f.family) : [];
  if (!list.length) list = [{ name: '맑은 고딕', family: 'Malgun Gothic' }];
  for (const f of list) {
    attachFont(f).catch(() => setStatus(`글꼴을 불러오지 못했습니다: ${f.name || f.family}`, true));
    addFontOption(f);
  }
  let saved = [];
  try { saved = JSON.parse(localStorage.getItem(USER_FONTS_KEY)) || []; } catch {}
  for (const f of saved) {
    if (!f || !f.family) continue;
    const font = { ...f, user: true };
    attachFont(font).catch(() => {});
    addFontOption(font);
  }
}

// 주소에서 font-family 이름을 알아낸다: Google Fonts는 주소에서, 그 밖의 CSS는 내용에서, 글꼴 파일은 파일 이름에서
async function detectFamily(u, isFile) {
  if (isFile) return decodeURIComponent(u.pathname.split('/').pop()).replace(/\.[^.]+$/, '');
  const fam = u.searchParams.get('family');
  if (fam) return fam.split(':')[0].trim();
  try {
    const css = await (await fetch(u.href)).text();
    const m = css.match(/font-family\s*:\s*['"]?([^;'"}]+)/i);
    if (m) return m[1].trim();
  } catch {}
  return null;
}

async function addFontFromUrl(raw) {
  let u;
  try { u = new URL(raw.trim()); } catch { setStatus('주소 형식이 아닙니다. https://로 시작하는 주소를 넣으세요.', true); return; }
  const isFile = /\.(woff2?|ttf|otf)$/i.test(u.pathname);
  setStatus('글꼴을 불러오는 중…');
  const family = await detectFamily(u, isFile);
  if (!family) { setStatus('글꼴 이름을 찾지 못했습니다. 웹폰트 CSS 주소인지 확인하세요.', true); return; }

  const existing = state.fonts.findIndex(f => f && f.family === family);
  if (existing >= 0) {
    $('font').value = String(existing);
    $('fontUrl').value = '';
    setStatus('이미 목록에 있는 글꼴이라 그 글꼴로 바꿨습니다.');
    schedule();
    return;
  }

  const font = { name: family, family, user: true, ...(isFile ? { file: u.href } : { css: u.href }) };
  try {
    await attachFont(font);
    if (!isFile) {
      const faces = await document.fonts.load(`16px "${family}"`, '가A');
      if (!faces.length) throw new Error('family');
    }
  } catch {
    setStatus('글꼴을 불러오지 못했습니다. 주소를 확인하세요. 글꼴 서버가 다른 사이트에서의 사용을 막았을 수도 있습니다.', true);
    return;
  }
  $('font').value = addFontOption(font).value;
  $('fontUrl').value = '';
  saveUserFonts();
  setStatus('');
  schedule();
}

function removeCurrentFont() {
  const i = +$('font').value;
  if (!state.fonts[i] || !state.fonts[i].user) return;
  state.fonts[i] = null;
  $('font').querySelector(`option[value="${i}"]`).remove();
  $('font').value = $('font').options[0].value;
  saveUserFonts();
  schedule();
}

const currentFamily = () => state.fonts[+$('font').value].family;
const fontStr = (family, bold, italic, px) =>
  `${italic ? 'italic ' : ''}${bold ? 700 : 400} ${px}px "${family}", "Malgun Gothic", sans-serif`;

const measureCtx = document.createElement('canvas').getContext('2d');
const widthCache = new Map();
// 100px 기준 폭을 재 두고 크기에 비례해 환산한다
function charWidth100(family, bold, italic, ch) {
  const key = `${family}|${bold}|${italic}|${ch}`;
  let w = widthCache.get(key);
  if (w === undefined) {
    measureCtx.font = fontStr(family, bold, italic, 100);
    w = measureCtx.measureText(ch).width;
    widthCache.set(key, w);
  }
  return w;
}

// ---------- 그림 불러오기 ----------
async function loadFile(file) {
  if (!file || !file.type.startsWith('image/')) {
    setStatus('이미지 파일이 아닙니다. PNG 같은 그림 파일을 넣어 주세요.', true);
    return;
  }
  let img;
  try { img = await createImageBitmap(file); }
  catch { setStatus('그림을 읽지 못했습니다. 다른 파일로 다시 시도하세요.', true); return; }

  const k = Math.min(1, MASK_MAX / Math.max(img.width, img.height));
  const mw = Math.max(1, Math.round(img.width * k));
  const mh = Math.max(1, Math.round(img.height * k));
  const c = document.createElement('canvas');
  c.width = mw; c.height = mh;
  const cx = c.getContext('2d', { willReadFrequently: true });
  cx.drawImage(img, 0, 0, mw, mh);
  const rgba = cx.getImageData(0, 0, mw, mh).data;
  let opaque = true;
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] < 250) { opaque = false; break; }

  let dpi = null;
  try { dpi = readDpi(await file.arrayBuffer()); } catch {}

  Object.assign(state, { img, mw, mh, rgba, opaque, dpi, zoom: null, name: (file.name || 'image').replace(/\.[^.]+$/, '') });
  $('fs').max = Math.max(8, Math.round(Math.min(mw, mh) / 2));
  // 타일 크기: 원본 px 기준, 기본은 짧은 변의 1/40
  const short = Math.min(img.width, img.height);
  $('tileSize').max = Math.max(8, Math.round(short / 4));
  $('tileSize').value = Math.max(6, Math.round(short / 40));
  // 투명한 곳이 없는 그림은 기본으로 흰색을 빼고 나머지를 모양으로 쓴다
  const mode = opaque ? 'white' : 'alpha';
  document.querySelector(`[name=maskMode][value=${mode}]`).checked = true;
  rebuildMask(true);

  // 저장 형식은 투명을 담을 수 있는 PNG가 기본 (흰색 제외로 바탕을 뺀 그림도 투명하게 저장되도록).
  // 저장 크기에는 실제 픽셀 수를 적는다
  $('format').value = 'png';
  for (const opt of $('outScale').options) {
    const [w, h] = outSize(+opt.value);
    opt.textContent = `${+opt.value === 1 ? '원본 크기' : `${opt.value}배`} · ${w}×${h}`;
  }
  $('imgInfo').textContent = `${file.name || '붙여넣은 그림'} · ${img.width}×${img.height}px${dpi ? ` · ${Math.round(dpi.x)}dpi` : ''}`;
  $('imgInfo').hidden = false;

  $('drop').hidden = true;
  $('preview').hidden = false;
  $('zoomBar').hidden = false;
  $('save').disabled = false;
  applyZoom();
  schedule();
}

// ---------- 해상도(DPI) 읽고 쓰기 ----------
function readDpi(buf) {
  const b = new Uint8Array(buf), dv = new DataView(buf);
  if (b[0] === 0x89 && b[1] === 0x50) {           // PNG: pHYs 청크
    for (let p = 8; p + 12 <= b.length;) {
      const len = dv.getUint32(p);
      const type = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
      if (type === 'pHYs' && len === 9) {
        if (b[p + 16] !== 1) return null;           // 단위가 미터가 아니면 비율 정보뿐
        return { x: dv.getUint32(p + 8) * 0.0254, y: dv.getUint32(p + 12) * 0.0254 };
      }
      if (type === 'IDAT' || type === 'IEND') break;
      p += 12 + len;
    }
  } else if (b[0] === 0xff && b[1] === 0xd8) {    // JPG: JFIF APP0
    for (let p = 2; p + 4 <= b.length && b[p] === 0xff;) {
      const marker = b[p + 1], len = dv.getUint16(p + 2);
      if (marker === 0xe0 && String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]) === 'JFIF') {
        const units = b[p + 11], x = dv.getUint16(p + 12), y = dv.getUint16(p + 14);
        if (units === 1) return { x, y };
        if (units === 2) return { x: x * 2.54, y: y * 2.54 };
        return null;
      }
      if (marker === 0xda) break;
      p += 2 + len;
    }
  }
  return null;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngWithDpi(buf, dpi) {
  const b = new Uint8Array(buf), dv = new DataView(buf);
  const chunk = new Uint8Array(21), cv = new DataView(chunk.buffer);
  cv.setUint32(0, 9);
  chunk.set([0x70, 0x48, 0x59, 0x73], 4);        // 'pHYs'
  cv.setUint32(8, Math.round(dpi.x / 0.0254));
  cv.setUint32(12, Math.round(dpi.y / 0.0254));
  chunk[16] = 1;
  cv.setUint32(17, crc32(chunk.subarray(4, 17)));
  // 이미 pHYs가 있으면 바꿔 끼우고, 없으면 IHDR 바로 뒤에 넣는다
  let insertAt = 8 + 12 + dv.getUint32(8), cut = 0;
  for (let p = insertAt; p + 12 <= b.length;) {
    const len = dv.getUint32(p);
    const type = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
    if (type === 'pHYs') { insertAt = p; cut = 12 + len; break; }
    if (type === 'IDAT') break;
    p += 12 + len;
  }
  const out = new Uint8Array(b.length - cut + 21);
  out.set(b.subarray(0, insertAt));
  out.set(chunk, insertAt);
  out.set(b.subarray(insertAt + cut), insertAt + 21);
  return out;
}

function jpegWithDpi(buf, dpi) {
  const b = new Uint8Array(buf);
  const x = Math.min(65535, Math.round(dpi.x)), y = Math.min(65535, Math.round(dpi.y));
  const hasJfif = b[2] === 0xff && b[3] === 0xe0 && String.fromCharCode(b[6], b[7], b[8], b[9]) === 'JFIF';
  if (hasJfif) {
    const out = b.slice();
    out[13] = 1;
    out[14] = x >> 8; out[15] = x & 255;
    out[16] = y >> 8; out[17] = y & 255;
    return out;
  }
  const app0 = new Uint8Array([0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 1, x >> 8, x & 255, y >> 8, y & 255, 0, 0]);
  const out = new Uint8Array(b.length + app0.length);
  out.set(b.subarray(0, 2));
  out.set(app0, 2);
  out.set(b.subarray(2), 2 + app0.length);
  return out;
}

// ---------- 미리보기 확대/축소 ----------
function fitZoom() {
  const st = $('stage');
  const pad = 64;
  const z = Math.min((st.clientWidth - pad) / state.img.width, (st.clientHeight - pad) / state.img.height);
  return Math.min(4, Math.max(0.05, z));
}
const currentZoom = () => state.zoom ?? fitZoom();

function applyZoom() {
  if (!state.img) return;
  const z = currentZoom();
  const c = $('preview');
  c.style.width = `${state.img.width * z}px`;
  c.style.height = `${state.img.height * z}px`;
  $('zoom').value = Math.round(z * 100);
  numFor('zoom').value = Math.round(z * 100);
  $('zoomFit').setAttribute('aria-pressed', String(state.zoom === null));
  // 확대해서 미리보기 해상도가 모자라면 다시 그린다
  const [pw] = previewSize(+$('outScale').value);
  if (pw > c.width * 1.2) schedule();
}

function setZoom(z) {
  state.zoom = Math.min(4, Math.max(0.05, z));
  applyZoom();
}

function maskMode() { return document.querySelector('[name=maskMode]:checked').value; }

function rebuildMask(resetThreshold) {
  const { rgba, mw, mh } = state;
  if (!rgba) return;
  const mode = maskMode();
  const m = new Uint8Array(mw * mh);
  for (let i = 0, p = 0; i < m.length; i++, p += 4) {
    const a = rgba[p + 3];
    if (mode === 'full') { m[i] = 255; continue; }
    if (mode === 'alpha') { m[i] = a; continue; }
    // 흰색 제외: 흰색에서 얼마나 먼 색인지 (투명한 곳도 뺀다)
    if (a < 128) { m[i] = 0; continue; }
    const d = Math.sqrt((255 - rgba[p]) ** 2 + (255 - rgba[p + 1]) ** 2 + (255 - rgba[p + 2]) ** 2);
    m[i] = Math.min(255, Math.round(d));
  }
  state.mask = m;
  state.downKey = '';
  state.paletteKey = '';
  if (resetThreshold) {
    // 흰색 제외의 기본 경계값 40: JPG 압축 등으로 생긴 거의 흰 색까지 흰색으로 본다
    $('thr').value = mode === 'white' ? 40 : 128;
    // '두 색'의 나누는 밝기: 모양 안쪽 밝기를 두 무리로 가장 잘 가르는 값
    const thr = +$('thr').value, lum = [];
    for (let i = 0, p = 0; i < m.length; i++, p += 4) {
      if (m[i] >= thr) lum.push(Math.round(0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2]));
    }
    if (lum.length) $('duoThr').value = otsu(lum);
    // '한 색'에서 명도를 펼칠 범위: 모양 안쪽 밝기의 하위·상위 2% (흐린 사진도 명도 차이가 또렷하게)
    if (lum.length) {
      lum.sort((p, q) => p - q);
      state.lumLo = lum[Math.floor(lum.length * 0.02)];
      state.lumHi = lum[Math.floor(lum.length * 0.98)];
    }
  }
}

// 명암 분포를 두 무리로 가장 잘 가르는 값 (Otsu)
function otsu(m) {
  const hist = new Float64Array(256);
  for (let i = 0; i < m.length; i++) hist[m[i]]++;
  const total = m.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = -1, t = 127;
  for (let i = 0; i < 256; i++) {
    wB += hist[i];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += i * hist[i];
    const d = sumB / wB - (sum - sumB) / wF;
    const between = wB * wF * d * d;
    if (between > best) { best = between; t = i; }
  }
  return Math.min(255, Math.max(1, t + 1));
}


// ---------- 색 단순화 ----------
// 모양 안쪽 픽셀에서 대표색 k개를 뽑는다 (k-means, 시드 고정이라 매번 같은 결과)
function getPalette(k, thr) {
  const key = `${k}|${maskMode()}|${thr}`;
  if (state.paletteKey === key) return state.palette;
  const { rgba, mask } = state;
  const total = mask.length;
  const step = Math.max(1, Math.floor(total / 20000));
  const pts = [];
  for (let i = 0; i < total; i += step) {
    const p = i * 4;
    if (mask[i] >= thr && rgba[p + 3] >= 128) pts.push(rgba[p], rgba[p + 1], rgba[p + 2]);
  }
  const m = pts.length / 3;
  if (!m) return null;

  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const dist = (j, c) => {
    const dr = pts[j * 3] - c[0], dg = pts[j * 3 + 1] - c[1], db = pts[j * 3 + 2] - c[2];
    return dr * dr + dg * dg + db * db;
  };
  const pick = j => [pts[j * 3], pts[j * 3 + 1], pts[j * 3 + 2]];
  const cents = [pick(Math.floor(rnd() * m))];
  const d2 = new Float64Array(m).fill(Infinity);
  while (cents.length < k) {
    const last = cents[cents.length - 1];
    let sum = 0;
    for (let j = 0; j < m; j++) { d2[j] = Math.min(d2[j], dist(j, last)); sum += d2[j]; }
    if (sum === 0) break;  // 서로 다른 색이 k개보다 적다
    let r = rnd() * sum, j = 0;
    for (; j < m - 1; j++) { r -= d2[j]; if (r <= 0) break; }
    cents.push(pick(j));
  }

  const assign = new Int32Array(m).fill(-1);
  for (let iter = 0; iter < 12; iter++) {
    let changed = false;
    for (let j = 0; j < m; j++) {
      let best = 0, bd = Infinity;
      for (let c = 0; c < cents.length; c++) { const d = dist(j, cents[c]); if (d < bd) { bd = d; best = c; } }
      if (assign[j] !== best) { assign[j] = best; changed = true; }
    }
    if (!changed) break;
    const acc = cents.map(() => [0, 0, 0, 0]);
    for (let j = 0; j < m; j++) {
      const a = acc[assign[j]];
      a[0] += pts[j * 3]; a[1] += pts[j * 3 + 1]; a[2] += pts[j * 3 + 2]; a[3]++;
    }
    acc.forEach((a, c) => { if (a[3]) cents[c] = [a[0] / a[3], a[1] / a[3], a[2] / a[3]]; });
  }
  state.palette = cents.map(c => c.map(Math.round));
  state.paletteKey = key;
  return state.palette;
}

// #rrggbb → [색상(0~360), 채도(%), 명도(%)]
function hexToHsl(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16 & 255) / 255, g = (n >> 8 & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return [0, 0, Math.round(l * 100)];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [Math.round(h * 60), Math.round(s * 100), Math.round(l * 100)];
}

const hexToRgb = hex => { const n = parseInt(hex.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; };
function hslToRgb(h, s, l) {
  s /= 100; l /= 100;
  const k = n => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

function nearest(palette, r, g, b) {
  let best = palette[0], bd = Infinity;
  for (const c of palette) {
    const d = (c[0] - r) ** 2 + (c[1] - g) ** 2 + (c[2] - b) ** 2;
    if (d < bd) { bd = d; best = c; }
  }
  return best;
}

// ---------- 글 편집기 ----------
const editor = $('editor');
let savedRange = null;

function editorPx() { return parseFloat(getComputedStyle(editor).fontSize) || 16; }

document.addEventListener('selectionchange', () => {
  const sel = getSelection();
  if (sel.rangeCount && editor.contains(sel.anchorNode)) {
    savedRange = sel.getRangeAt(0).cloneRange();
    syncToolbar();
  }
});

function restoreSelection() {
  editor.focus();
  if (savedRange) {
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(savedRange);
  }
}

function exec(cmd, value) {
  restoreSelection();
  document.execCommand('styleWithCSS', false, true);
  document.execCommand(cmd, false, value);
  syncToolbar();
  schedule();
}

// 글 전체의 서식을 지운다. execCommand로 해서 Ctrl+Z로 되돌릴 수 있다.
function clearAllFormat() {
  editor.focus();
  const sel = getSelection();
  const range = document.createRange();
  range.selectNodeContents(editor);
  sel.removeAllRanges();
  sel.addRange(range);
  document.execCommand('styleWithCSS', false, true);
  document.execCommand('removeFormat');
  sel.collapseToEnd();
  syncToolbar();
  schedule();
}

function applySize(mult) {
  restoreSelection();
  document.execCommand('styleWithCSS', false, true);
  document.execCommand('fontSize', false, '7');
  const px = `${mult * editorPx()}px`;
  // execCommand는 1~7 단계만 알아서, 7단계로 표시한 뒤 원하는 크기로 바꿔 끼운다
  editor.querySelectorAll('font[size="7"]').forEach(f => {
    const span = document.createElement('span');
    span.style.fontSize = px;
    while (f.firstChild) span.appendChild(f.firstChild);
    f.replaceWith(span);
  });
  editor.querySelectorAll('[style]').forEach(el => {
    if (el.style.fontSize === 'xxx-large') el.style.fontSize = px;
  });
  schedule();
}

function syncToolbar() {
  for (const b of document.querySelectorAll('.tool[data-cmd]')) {
    let on = false;
    try { on = document.queryCommandState(b.dataset.cmd); } catch {}
    b.setAttribute('aria-pressed', String(on));
  }
  const sel = getSelection();
  const node = sel.anchorNode;
  if (node && editor.contains(node)) {
    const el = node.nodeType === 1 ? node : node.parentElement;
    const mult = parseFloat(getComputedStyle(el).fontSize) / editorPx();
    let best = null, diff = Infinity;
    for (const o of $('size').options) {
      const d = Math.abs(+o.value - mult);
      if (d < diff) { diff = d; best = o; }
    }
    if (best) $('size').value = best.value;
  }
}

function hasUnderline(el) {
  for (; el && el !== editor; el = el.parentElement) {
    if (el.tagName === 'U') return true;
    const d = `${el.style.textDecorationLine} ${el.style.textDecoration}`;
    if (d.includes('underline')) return true;
  }
  return false;
}

function explicitColor(el) {
  for (let e = el; e && e !== editor; e = e.parentElement) {
    if (e.style.color || (e.tagName === 'FONT' && e.getAttribute('color'))) return getComputedStyle(el).color;
  }
  return null;
}

// 눈에 보이는 한 글자 단위로 나눈다.
// 조합형(NFD) 한글은 완성형으로 합치고, 피부색·가족 이모지처럼 여러 코드로 된 글자도 쪼개지 않는다.
const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter('ko', { granularity: 'grapheme' }) : null;
function graphemes(text) {
  const t = text.normalize('NFC');
  return segmenter ? Array.from(segmenter.segment(t), s => s.segment) : Array.from(t);
}

// 편집기 내용 → 글자 목록. 줄바꿈과 연속 공백은 공백 하나로 합친다 (그림이 줄 단위로 끊겨 보이지 않게).
function extractRuns() {
  const base = editorPx();
  const out = [];
  let pendingSpace = false;
  const walk = node => {
    if (node.nodeType === 3) {
      const el = node.parentElement;
      const cs = getComputedStyle(el);
      const style = {
        scale: parseFloat(cs.fontSize) / base,
        bold: (parseInt(cs.fontWeight, 10) || 400) >= 600,
        italic: cs.fontStyle !== 'normal',
        underline: hasUnderline(el),
        color: explicitColor(el),
      };
      for (const ch of graphemes(node.data)) {
        if (/\s/.test(ch)) { pendingSpace = true; continue; }
        if (pendingSpace && out.length) out.push({ ...style, ch: ' ' });
        pendingSpace = false;
        out.push({ ...style, ch });
      }
    } else if (node.nodeType === 1) {
      if (node.tagName === 'BR') { pendingSpace = true; return; }
      // 편집기에서 Enter를 치면 줄마다 <div>가 생긴다
      const block = getComputedStyle(node).display !== 'inline';
      if (block) pendingSpace = true;
      node.childNodes.forEach(walk);
      if (block) pendingSpace = true;
    }
  };
  editor.childNodes.forEach(walk);
  return out;
}

// ---------- 배치 ----------
// 열마다 '여기서부터 아래로 몇 px이 모양 안쪽인지'. 한 줄 높이가 통째로 안쪽인지 한 번에 알 수 있다.
function getDownRuns(thr) {
  const key = `${maskMode()}|${thr}`;
  if (state.downKey === key) return state.down;
  const { mask, mw, mh } = state;
  const down = new Uint16Array(mw * mh);
  for (let y = mh - 1; y >= 0; y--) {
    const row = y * mw, next = row + mw;
    for (let x = 0; x < mw; x++) {
      down[row + x] = mask[row + x] >= thr ? (y === mh - 1 ? 1 : down[next + x] + 1) : 0;
    }
  }
  state.down = down;
  state.downKey = key;
  return down;
}

// 글자 하나가 실제로 그려지는 범위 (100px 기준): 기준선 위·아래, 그리는 점 왼쪽·오른쪽
const inkCache = new Map();
function charInk(family, bold, italic, ch) {
  const key = `${family}|${bold}|${italic}|${ch}`;
  let m = inkCache.get(key);
  if (!m) {
    measureCtx.font = fontStr(family, bold, italic, 100);
    const t = measureCtx.measureText(ch);
    m = {
      asc: t.actualBoundingBoxAscent / 100,
      desc: t.actualBoundingBoxDescent / 100,
      left: t.actualBoundingBoxLeft / 100,
      right: t.actualBoundingBoxRight / 100,
    };
    inkCache.set(key, m);
  }
  return m;
}

// 줄 간격과 줄 위치를 잡는 데 쓰는 '보통 글자' 높이: 글 속 글자들의 가운데값.
// (이모지·괄호처럼 유난히 큰 글자 몇 개 때문에 모든 줄이 넓어지지 않게 최댓값이 아니라 가운데값)
function glyphMetrics(family, src) {
  const ascs = [], descs = [];
  const seen = new Set();
  for (const it of src) {
    const key = `${it.bold}|${it.italic}|${it.ch}`;
    if (it.ch === ' ' || seen.has(key)) continue;
    seen.add(key);
    const m = charInk(family, it.bold, it.italic, it.ch);
    ascs.push(m.asc);
    descs.push(m.desc);
  }
  const mid = a => a.sort((p, q) => p - q)[a.length >> 1];
  return ascs.length ? { asc: mid(ascs), desc: mid(descs) } : { asc: 0.88, desc: 0.12 };
}

// 일러스트레이터의 영역 문자처럼: 글자 하나하나가 (획 두께·밑줄까지) 윤곽 안에 완전히 들어가는 자리에만 놓는다.
// 위에서부터 줄마다 왼쪽→오른쪽으로 글자 단위로 채우고, 글자마다 자기 크기로 윤곽 안인지 검사한다.
// 줄 높이는 그 줄에 실제로 들어간 가장 큰 글자에 맞춘다.
function layout(src, base, o, onLine) {
  const { mw, mh } = state;
  const down = getDownRuns(o.thr);
  const { asc, desc } = o.metrics;
  const n = src.length;
  const tr = (o.tracking || 0) * base;   // 자간 (기본 글자 크기에 대한 비율)
  const inside = new Uint8Array(mw);
  let idx = 0, y = 0, totalArea = 0, emptyArea = 0, placedCount = 0;

  const peekSize = () => {
    for (let k = 0; k < n; k++) {
      let j = idx + k;
      if (j >= n) { if (!o.repeat) break; j -= n; }
      if (src[j].ch !== ' ') return src[j].scale * base;
    }
    return base;
  };

  // 줄 윗선이 top이고 가장 큰 글자가 h일 때의 기준선, 그리고 보통 글자가 차지하는 세로 범위
  const band = (top, h) => {
    const pitch = h * o.lh;
    const baseline = top + (pitch - (asc + desc) * h) / 2 + asc * h;
    return { pitch, baseline, y0: Math.floor(baseline - asc * h), y1: Math.ceil(baseline + desc * h) };
  };

  // 보통 글자 높이로 본 윤곽 안쪽 열 (글자를 놓을 후보 구간과 채움 비율 계산용)
  const scan = (y0, y1) => {
    const need = y1 - y0 + 1, row = y0 * mw;
    for (let x = 0; x < mw; x++) inside[x] = down[row + x] >= need ? 1 : 0;
  };

  // 글자 it를 x에 놓았을 때 획이 전부 윤곽 안인지. 밖이면 걸리는 가장 오른쪽 열을, 안이면 -1을 돌려준다.
  const blockedAt = (it, x, baseline, w) => {
    const s = it.scale * base, sw = s * o.stroke / 2;
    const m = charInk(o.family, it.bold, it.italic, it.ch);
    const d = it.underline ? Math.max(m.desc, 0.17) : m.desc;
    const y0 = Math.floor(baseline - m.asc * s - sw), y1 = Math.ceil(baseline + d * s + sw);
    let x0 = Math.floor(x - m.left * s - sw), x1 = Math.ceil(x + m.right * s + sw);
    if (it.underline) { x0 = Math.min(x0, Math.floor(x)); x1 = Math.max(x1, Math.ceil(x + w)); }
    if (y0 < 0 || y1 > mh - 1 || x0 < 0 || x1 > mw - 1) return x1;
    const need = y1 - y0 + 1, row = y0 * mw;
    for (let c = x1; c >= x0; c--) if (down[row + c] < need) return c;
    return -1;
  };

  // 가장자리 줄이기: 제 크기로 윤곽에 걸리는 자리에서 같은 글자를 이 비율들로 줄여 가며 넣어 본다
  const SHRINK = [0.8, 0.64, 0.5, 0.4];
  const scanSmall = (baseline, h) => {
    const f = SHRINK[SHRINK.length - 1];
    const y0 = Math.floor(baseline - asc * h * f), y1 = Math.ceil(baseline + desc * h * f);
    if (y0 < 0 || y1 > mh - 1) { inside.fill(0); return; }
    scan(y0, y1);
  };

  // ls: 줄 전체 크기 비율 (모양의 위아래 끝처럼 보통 줄이 안 들어가는 곳에서 작은 줄을 만들 때)
  const fill = (start, h, baseline, ls = 1) => {
    let i = start, maxH = 0, area = 0, empty = 0, placed = 0;
    const items = [], widths = [], xs = [];
    const minW = Math.min(h, base * ls) * (o.shrink ? 0.9 * SHRINK[SHRINK.length - 1] : 0.9);
    let x = 0;
    while (x < mw) {
      while (x < mw && !inside[x]) x++;
      const a = x;
      while (x < mw && inside[x]) x++;
      const runEnd = x;
      if (runEnd - a < minW) continue;
      area += runEnd - a;
      if (i >= n && !o.repeat) { empty += runEnd - a; continue; }

      // 구간 안에서 글자를 하나씩 놓는다. 윤곽에 걸리는 글자는 걸린 곳 너머로 옮겨 다시 시도한다.
      let cx = a, fresh = true, tries = 0, seg = items.length;
      while (cx < runEnd && tries++ < 5000) {
        if (i >= n) { if (o.repeat) i = 0; else break; }
        const src0 = src[i];
        if (fresh && src0.ch === ' ') { i++; continue; }     // 끊긴 자리 첫머리의 공백은 버린다
        const sc = src0.scale * ls;
        const w0 = charWidth100(o.family, src0.bold, src0.italic, src0.ch) * sc * base / 100;
        let it = ls === 1 ? src0 : { ...src0, scale: sc }, w = w0;
        let ok = cx + w0 <= runEnd + 0.5 && blockedAt(it, cx, baseline, w0) < 0;
        const canShrink = o.shrink && src0.ch !== ' ';
        if (!ok && canShrink) {
          for (const f of SHRINK) {
            const it2 = { ...src0, scale: sc * f }, w2 = w0 * f;
            if (cx + w2 <= runEnd + 0.5 && blockedAt(it2, cx, baseline, w2) < 0) { it = it2; w = w2; ok = true; break; }
          }
        }
        if (!ok) {
          const fMin = canShrink ? SHRINK[SHRINK.length - 1] : 1;
          if (cx + w0 * fMin > runEnd + 0.5) break;          // 가장 작게 해도 구간 끝을 넘는다: 다음 구간으로
          const hit = blockedAt({ ...src0, scale: sc * fMin }, cx, baseline, w0 * fMin);
          if (hit < 0) break;
          cx = Math.max(cx + 1, hit + 1);                    // 걸린 열 다음부터 다시
          fresh = true;
          seg = items.length;
          continue;
        }
        items.push(it); widths.push(w); xs.push(cx);
        maxH = Math.max(maxH, it.scale * base);
        if (it.ch !== ' ') placed++;
        cx += w + tr; i++; fresh = false;
      }
      // 줄 끝에 남은 자리(한 글자 폭보다 작음)를 글자 사이에 고르게 나눠, 줄이 윤곽 양 끝에 닿게 한다.
      // 글의 마지막 줄은 그대로 두고, 나눴을 때 윤곽에 걸리는 글자가 생기면 하지 않는다.
      if (!(i >= n && !o.repeat)) spread(items, widths, xs, seg, runEnd, baseline);
    }
    return { i, maxH, area, empty, placed, line: { items, widths, xs } };
  };

  const spread = (items, widths, xs, seg, runEnd, baseline) => {
    let last = items.length - 1;
    while (last > seg && items[last].ch === ' ') last--;
    const count = last - seg;
    if (count < 1) return;
    const extra = runEnd - (xs[last] + widths[last]);
    if (extra <= 0.5) return;
    for (const k of [1, 0.5]) {
      const gap = extra * k / count;
      let ok = true;
      for (let j = seg + 1; j <= last && ok; j++) {
        if (items[j].ch !== ' ' && blockedAt(items[j], xs[j] + gap * (j - seg), baseline, widths[j]) >= 0) ok = false;
      }
      if (ok) {
        for (let j = seg + 1; j < items.length; j++) xs[j] += gap * Math.min(j - seg, count);
        return;
      }
    }
  };

  for (;;) {
    let h = idx >= n && !o.repeat ? base : peekSize();
    let res = null, b = null;
    for (let iter = 0; iter < 4; iter++) {
      b = band(y, h);
      if (b.y1 > mh - 1) { res = null; break; }           // 그림 아래 끝
      if (b.y0 < 0) { res = { i: idx, maxH: 0, area: 0, empty: 0, placed: 0, line: null }; break; }
      // 가장자리 줄이기를 켜면 가장 작게 줄인 글자가 들어가는 곳까지 후보로 본다 (들어가면 제 크기부터 시도)
      if (o.shrink) scanSmall(b.baseline, h); else scan(b.y0, b.y1);
      res = fill(idx, h, b.baseline);
      if (res.maxH <= h + 0.01 || iter === 3) break;
      h = res.maxH;
    }
    // 보통 줄이 안 들어가는 곳(모양의 위아래 끝, 그림 아래 끝)은 작은 줄로 채워 본다
    if (o.shrink && !(idx >= n && !o.repeat) && (!res || res.placed === 0)) {
      for (const ls of [0.7, 0.5]) {
        const b2 = band(y, h * ls);
        if (b2.y1 > mh - 1 || b2.y0 < 0) continue;
        scanSmall(b2.baseline, h * ls);
        const r2 = fill(idx, h * ls, b2.baseline, ls);
        if (r2.placed > 0) { res = r2; b = b2; break; }
      }
    }
    if (!res) break;
    totalArea += res.area;
    emptyArea += res.empty;
    placedCount += res.placed;
    idx = res.i;
    if (onLine && res.line && res.line.items.length) onLine(res.line, b.baseline);
    // 글자가 들어갈 자리가 없는 줄은 조금씩만 내려가서, 모양이 시작되는 곳에서 바로 첫 줄이 시작되게 한다
    y += res.area > 0 || res.placed > 0 ? b.pitch : Math.max(1, h * 0.1);
  }
  return {
    remaining: o.repeat ? 0 : src.slice(idx).reduce((c, s) => c + (s.ch === ' ' ? 0 : 1), 0),  // 못 놓은 글자 수 (공백 제외)
    fillRatio: totalArea ? 1 - emptyArea / totalArea : 0,
    hasSpace: totalArea > 0,
    placed: placedCount,     // 실제로 놓인 글자 수 (공백 제외)
  };
}

// 글이 모자랄 때: 같은 글을 반복해 끝까지 채워 보고, 몇 자가 더 들어가는지 센다
function missingChars(src, base, o) {
  const full = layout([...src, { ...src[src.length - 1], ch: ' ' }], base, { ...o, repeat: true });
  const have = src.reduce((c, s) => c + (s.ch === ' ' ? 0 : 1), 0);
  return Math.max(0, full.placed - have);
}

// 글이 딱 한 번 다 들어가는 가장 큰 기본 크기
function autoFitSize(src, o) {
  let lo = 3, hi = Math.max(4, Math.min(state.mw, state.mh));
  if (layout(src, lo, o).remaining > 0) return lo;
  for (let i = 0; i < 16; i++) {
    const mid = (lo + hi) / 2;
    if (layout(src, mid, o).remaining === 0) lo = mid; else hi = mid;
  }
  return lo;
}

// 크기를 조금만 키워도 줄이 통째로 하나 빠지기 때문에, 크기만으로는 글이 끝난 뒤 한두 줄이 빈다.
// 그 남는 자리를 자간을 살짝 넓혀 채운다: 글이 여전히 다 들어가는 가장 넓은 자간.
function autoFitTracking(src, base, o) {
  if (layout(src, base, { ...o, tracking: 0 }).remaining > 0) return 0;   // 가장 작은 크기로도 넘치면 자간은 그대로
  let lo = 0, hi = 0.6;
  if (layout(src, base, { ...o, tracking: hi }).remaining === 0) return hi;
  for (let i = 0; i < 10; i++) {
    const mid = (lo + hi) / 2;
    if (layout(src, base, { ...o, tracking: mid }).remaining === 0) lo = mid; else hi = mid;
  }
  return lo;
}

// ---------- 그리기 ----------
function readOptions() {
  const auto = $('autoFit').checked;
  return {
    family: currentFamily(),
    auto,
    fs: +$('fs').value,
    repeat: !auto && $('repeat').checked,
    lh: +$('lh').value,
    shrink: $('shrink').checked,
    colorMode: document.querySelector('[name=colorMode]:checked').value,
    duoDark: $('duoDark').value,
    duoLight: $('duoLight').value,
    duoThr: +$('duoThr').value,
    monoHsl: hexToHsl($('monoColor').value),
    quant: +$('quant').value,
    stroke: +$('stroke').value / 100,
    format: $('format').value,
    // JPG는 투명을 못 담으므로 투명 배경이면 흰색으로 채운다 (미리보기도 같게)
    bgMode: $('format').value === 'jpg' ? 'solid' : document.querySelector('[name=bgMode]:checked').value,
    bg: $('format').value === 'jpg' && document.querySelector('[name=bgMode]:checked').value === 'none' ? '#ffffff' : $('bg').value,
    ghost: +$('ghost').value / 100,
    thr: +$('thr').value,
    outScale: +$('outScale').value,
    kind: document.querySelector('[name=kind]:checked').value,
    // 타일 크기는 원본 그림 px로 받고 분석 해상도로 바꿔 쓴다
    tileSize: state.img ? +$('tileSize').value * state.mw / state.img.width : 20,
    tileGap: +$('tileGap').value / 100,
    strength: +$('strength').value / 100,
  };
}

async function computeLayout(o) {
  if (o.kind === 'image') return { src: [], base: 0 };
  const src = extractRuns();
  // 반복할 때 글 끝과 처음이 붙지 않게 한 칸 띄운다
  if (o.repeat && src.length) src.push({ ...src[src.length - 1], ch: ' ', underline: false });
  if (src.length) {
    const text = [...new Set(src.map(s => s.ch))].join('');
    const combos = new Set(src.map(s => `${s.bold}|${s.italic}`));
    await Promise.all([...combos].map(c => {
      const [b, i] = c.split('|');
      return document.fonts.load(fontStr(o.family, b === 'true', i === 'true', 100), text).catch(() => {});
    }));
  }
  o.metrics = glyphMetrics(o.family, src);
  o.tracking = 0;
  const base = src.length && o.auto ? autoFitSize(src, o) : o.fs;
  if (src.length && o.auto) o.tracking = autoFitTracking(src, base, o);
  return { src, base };
}

// 그림의 한 칸(x0, y0, w, h — 분석 해상도 기준)에 칠할 색 [r, g, b].
// 칸의 평균색(보이는 픽셀만)을 구한 뒤 색 모드(그림 색·한 색·두 색)와 색 단순화를 적용한다.
function makeColorer(o) {
  const { mw, mh, rgba } = state;
  const palette = o.colorMode === 'image' && o.quant <= 16 ? getPalette(o.quant, o.thr) : null;
  const dark = hexToRgb(o.duoDark), light = hexToRgb(o.duoLight);
  return (x0, y0, w, h) => {
    const sx = Math.max(1, w / 4), sy = Math.max(1, h / 4);
    let r = 0, g = 0, b = 0, cnt = 0;
    for (let y = y0; y < y0 + h; y += sy) {
      for (let x = x0; x < x0 + w; x += sx) {
        const px = Math.min(mw - 1, Math.max(0, Math.round(x)));
        const py = Math.min(mh - 1, Math.max(0, Math.round(y)));
        const p = (py * mw + px) * 4;
        if (rgba[p + 3] < 128) continue;
        r += rgba[p]; g += rgba[p + 1]; b += rgba[p + 2]; cnt++;
      }
    }
    if (!cnt) {
      const p = (Math.min(mh - 1, Math.max(0, Math.round(y0 + h / 2))) * mw + Math.min(mw - 1, Math.max(0, Math.round(x0 + w / 2)))) * 4;
      r = rgba[p]; g = rgba[p + 1]; b = rgba[p + 2]; cnt = 1;
    }
    const c = [r / cnt, g / cnt, b / cnt];
    const lum = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
    // 두 색: 그 자리가 어두우면 어두운 곳 색, 밝으면 밝은 곳 색
    if (o.colorMode === 'duo') return lum < o.duoThr ? dark : light;
    // 한 색: 기준 색의 색상·채도는 두고 명도만 그 자리 밝기로 (가장 어두워도 색이 보이게 18%~90%)
    if (o.colorMode === 'mono') {
      const lo = state.lumLo ?? 0, hi = state.lumHi ?? 255;
      let t = Math.min(1, Math.max(0, (lum - lo) / Math.max(1, hi - lo)));
      if (o.quant <= 16) t = Math.round(t * (o.quant - 1)) / (o.quant - 1);
      const [hh, ss] = o.monoHsl;
      return hslToRgb(hh, ss, 18 + t * 72);
    }
    return palette ? nearest(palette, c[0], c[1], c[2]) : c;
  };
}
const cssRgb = c => `rgb(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])})`;

function paint(canvas, outW, outH, o, src, base) {
  const { img, mw } = state;
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d');
  const r = outW / mw;
  let result = { remaining: 0, fillRatio: 0, hasSpace: true };
  const colorAt = makeColorer(o);

  if (o.kind === 'image') {
    result = paintMosaic(ctx, outW, outH, o, colorAt);
  } else if (src.length) {
    ctx.setTransform(r, 0, 0, r, 0, 0);
    ctx.textBaseline = 'alphabetic';
    ctx.lineJoin = 'round';
    let lastFont = '';
    result = layout(src, base, o, (line, baseline) => {
      const { items, widths, xs } = line;
      for (let k = 0; k < items.length; k++) {
        const it = items[k], w = widths[k], px = it.scale * base, x = xs[k];
        const f = fontStr(o.family, it.bold, it.italic, px);
        // 글자 하나에 한 색: 글자가 차지하는 칸의 색
        const color = it.color || cssRgb(colorAt(x, baseline - px * 0.8, w, px * 0.8));
        if (EMOJI.test(it.ch)) {
          drawTintedEmoji(ctx, it.ch, x, baseline, w, px, f, color, o.stroke, r);
        } else {
          if (f !== lastFont) ctx.font = lastFont = f;
          ctx.fillStyle = color;
          ctx.fillText(it.ch, x, baseline);
          // 획을 두껍게 하면 글자 사이 빈틈이 줄어 멀리서 그림이 더 진하게 보인다
          if (o.stroke > 0) {
            ctx.strokeStyle = color;
            ctx.lineWidth = px * o.stroke;
            ctx.strokeText(it.ch, x, baseline);
          }
        }
        ctx.fillStyle = color;
        if (it.underline) ctx.fillRect(x, baseline + px * 0.1, w, Math.max(0.5, px * 0.06));
      }
    });
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  // 채울 것이 없을 땐 모양이 보이도록 원본을 옅게 깐다
  const empty = o.kind === 'image' ? !state.tiles.length : !src.length;
  const ghost = empty ? Math.max(o.ghost, 0.15) : o.ghost;
  if (ghost > 0) {
    ctx.globalCompositeOperation = 'destination-over';
    ctx.globalAlpha = ghost;
    ctx.drawImage(img, 0, 0, outW, outH);
    ctx.globalAlpha = 1;
  }
  if (o.bgMode === 'solid') {
    ctx.globalCompositeOperation = 'destination-over';
    ctx.fillStyle = o.bg;
    ctx.fillRect(0, 0, outW, outH);
  }
  ctx.globalCompositeOperation = 'source-over';
  return result;
}

// ---------- 포토 모자이크 ----------
// 모양 안을 정사각형 칸으로 나누고, 칸마다 평균색이 가장 가까운 타일 이미지를 골라
// 그 칸의 색에 맞게 색을 보정해 넣는다. 칸 전체가 윤곽 안에 들 때만 놓는다(글자와 같은 규칙).
function paintMosaic(ctx, outW, outH, o, colorAt) {
  const { mw, mh, tiles } = state;
  if (!tiles.length) return { hasSpace: true, placed: 0, noTiles: true };
  const r = outW / mw;
  const down = getDownRuns(o.thr);
  const T = o.tileSize, gap = T * o.tileGap, pitch = T + gap;
  const cols = Math.floor((mw + gap) / pitch), rows = Math.floor((mh + gap) / pitch);
  const ox = (mw - (cols * pitch - gap)) / 2, oy = (mh - (rows * pitch - gap)) / 2;
  const scaled = new Map();   // 타일 번호|폭|높이 → 그 크기로 줄인 픽셀
  const scaledData = (ti, w, h) => {
    const key = `${ti}|${w}|${h}`;
    let d = scaled.get(key);
    if (!d) {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const cx = c.getContext('2d');
      const t = tiles[ti];
      cx.drawImage(t.bmp, t.sx, t.sy, t.side, t.side, 0, 0, w, h);
      d = cx.getImageData(0, 0, w, h);
      scaled.set(key, d);
    }
    return d;
  };
  const above = new Int32Array(cols).fill(-1);
  let placed = 0;
  for (let row = 0; row < rows; row++) {
    let left = -1;
    for (let col = 0; col < cols; col++) {
      const x0 = ox + col * pitch, y0 = oy + row * pitch;
      const cx0 = Math.floor(x0), cx1 = Math.ceil(x0 + T) - 1, cy0 = Math.floor(y0), need = Math.ceil(y0 + T) - cy0;
      let inside = cx0 >= 0 && cx1 < mw && cy0 >= 0 && cy0 + need <= mh;
      for (let c = cx0; inside && c <= cx1; c++) if (down[cy0 * mw + c] < need) inside = false;
      if (!inside) { above[col] = -1; left = -1; continue; }

      const want = colorAt(x0, y0, T, T);
      // 평균색이 가장 가까운 타일. 바로 왼쪽·위와 같은 타일이면 조금 불리하게 해서 같은 사진이 뭉치지 않게 한다.
      let best = 0, bd = Infinity;
      for (let ti = 0; ti < tiles.length; ti++) {
        const a = tiles[ti].avg;
        let d = (a[0] - want[0]) ** 2 + (a[1] - want[1]) ** 2 + (a[2] - want[2]) ** 2;
        if (tiles.length > 2 && (ti === left || ti === above[col])) d += 2500;
        if (d < bd) { bd = d; best = ti; }
      }
      left = above[col] = best;

      const X0 = Math.round(x0 * r), Y0 = Math.round(y0 * r);
      const w = Math.round((x0 + T) * r) - X0, h = Math.round((y0 + T) * r) - Y0;
      if (w < 1 || h < 1) continue;
      const src = scaledData(best, w, h);
      // 색 보정: 타일의 평균색을 칸의 색 쪽으로 옮긴다 (무늬는 그대로, 강도만큼)
      const a = tiles[best].avg, k = o.strength;
      const dr = (want[0] - a[0]) * k, dg = (want[1] - a[1]) * k, db = (want[2] - a[2]) * k;
      const out = ctx.createImageData(w, h);
      const s = src.data, d = out.data;
      for (let p = 0; p < s.length; p += 4) {
        d[p] = s[p] + dr; d[p + 1] = s[p + 1] + dg; d[p + 2] = s[p + 2] + db; d[p + 3] = s[p + 3];
      }
      ctx.putImageData(out, X0, Y0);
      placed++;
    }
  }
  return { hasSpace: placed > 0, placed };
}

// 타일 이미지 불러오기: 가운데를 정사각형으로 잘라 쓰고, 평균색을 미리 구해 둔다
async function addTiles(files) {
  const list = [...files].filter(f => f.type.startsWith('image/'));
  if (!list.length) { setStatus('이미지 파일이 아닙니다. 타일로 쓸 그림 파일을 넣어 주세요.', true); return; }
  let failed = 0;
  for (const f of list) {
    let bmp;
    try { bmp = await createImageBitmap(f); } catch { failed++; continue; }
    const side = Math.min(bmp.width, bmp.height);
    const sx = (bmp.width - side) / 2, sy = (bmp.height - side) / 2;
    const c = document.createElement('canvas');
    c.width = c.height = 16;
    const cx = c.getContext('2d', { willReadFrequently: true });
    cx.drawImage(bmp, sx, sy, side, side, 0, 0, 16, 16);
    const px = cx.getImageData(0, 0, 16, 16).data;
    let r = 0, g = 0, b = 0, n = 0;
    for (let p = 0; p < px.length; p += 4) { if (px[p + 3] < 128) continue; r += px[p]; g += px[p + 1]; b += px[p + 2]; n++; }
    if (!n) n = 1;
    const t = { bmp, sx, sy, side, avg: [r / n, g / n, b / n], name: f.name };
    const thumb = document.createElement('canvas');
    thumb.width = thumb.height = 96;
    thumb.getContext('2d').drawImage(bmp, sx, sy, side, side, 0, 0, 96, 96);
    t.thumb = thumb.toDataURL('image/jpeg', 0.8);
    state.tiles.push(t);
  }
  renderTileList();
  if (failed) setStatus(`${failed}개는 읽지 못했습니다. 다른 파일로 다시 시도하세요.`, true);
  schedule();
}

function renderTileList() {
  const box = $('tileList');
  box.textContent = '';
  state.tiles.forEach((t, i) => {
    const el = document.createElement('div');
    el.className = 'tile';
    const im = new Image();
    im.src = t.thumb;
    im.alt = t.name;
    const del = document.createElement('button');
    del.textContent = '×';
    del.setAttribute('aria-label', `${t.name} 빼기`);
    del.onclick = () => { state.tiles.splice(i, 1); renderTileList(); schedule(); };
    el.append(im, del);
    box.append(el);
  });
  $('tileCount').value = state.tiles.length ? `${state.tiles.length}개` : '';
  $('clearTiles').hidden = !state.tiles.length;
}

// 컬러 이모지는 fillStyle을 무시하고 제 색으로 그려진다.
// 따로 그린 뒤 그 모양만 남기고 원하는 색으로 덮어 다른 글자처럼 한 색으로 만든다.
const EMOJI = /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u;
const emojiCanvas = document.createElement('canvas');
function drawTintedEmoji(ctx, ch, x, baseline, w, px, font, color, stroke, r) {
  const pad = px * (0.3 + stroke);
  const bx = x - pad, by = baseline - px * 1.2 - pad;
  const bw = w + pad * 2, bh = px * 1.5 + pad * 2;
  const cw = Math.max(1, Math.ceil(bw * r)), ch2 = Math.max(1, Math.ceil(bh * r));
  if (emojiCanvas.width < cw || emojiCanvas.height < ch2) {
    emojiCanvas.width = Math.max(emojiCanvas.width, cw);
    emojiCanvas.height = Math.max(emojiCanvas.height, ch2);
  }
  const t = emojiCanvas.getContext('2d');
  t.setTransform(1, 0, 0, 1, 0, 0);
  t.globalCompositeOperation = 'source-over';
  t.clearRect(0, 0, cw, ch2);
  t.setTransform(r, 0, 0, r, -bx * r, -by * r);
  t.font = font;
  t.textBaseline = 'alphabetic';
  t.fillStyle = '#000';
  t.fillText(ch, x, baseline);
  if (stroke > 0) {
    t.lineJoin = 'round';
    t.strokeStyle = '#000';
    t.lineWidth = px * stroke;
    t.strokeText(ch, x, baseline);
  }
  t.setTransform(1, 0, 0, 1, 0, 0);
  t.globalCompositeOperation = 'source-in';
  t.fillStyle = color;
  t.fillRect(0, 0, cw, ch2);
  ctx.drawImage(emojiCanvas, 0, 0, cw, ch2, bx, by, cw / r, ch2 / r);
}

// 저장 크기: 원본 픽셀 × 배율 (상한을 넘으면 비율 유지하며 줄인다)
function outSize(scale) {
  const { width: w, height: h } = state.img;
  const k = Math.min(scale, OUT_MAX / Math.max(w, h));
  return [Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k))];
}

// 미리보기 캔버스 크기: 화면에 보이는 크기만큼만 (저장 크기보다 크게는 안 그린다)
function previewSize(scale) {
  const [ow, oh] = outSize(scale);
  const want = state.img.width * currentZoom() * (window.devicePixelRatio || 1);
  const w = Math.min(ow, PREVIEW_CAP * ow / Math.max(ow, oh), Math.max(200, Math.ceil(want)));
  const k = w / ow;
  return [Math.max(1, Math.round(ow * k)), Math.max(1, Math.round(oh * k))];
}

let renderToken = 0;
async function render() {
  syncControls();
  if (!state.img) return;
  const token = ++renderToken;
  const o = readOptions();
  const { src, base } = await computeLayout(o);
  if (token !== renderToken) return;
  if (o.auto && o.kind === 'text') numFor('fs').value = Math.round(base * 10) / 10;

  const [pw, ph] = previewSize(o.outScale);
  const res = paint($('preview'), pw, ph, o, src, base);

  if (o.kind === 'image') {
    if (res.noTiles) setStatus('타일로 쓸 이미지를 추가하세요.');
    else if (!res.placed) setStatus('타일이 들어갈 자리가 없습니다. 타일 크기를 줄이세요.', true);
    else setStatus('');
    return;
  }
  // 저장했을 때 글자가 몇 px인지: 너무 작으면 뭉개져 보인다
  const [ow] = outSize(o.outScale);
  const glyphPx = base * ow / state.mw;
  const MIN_PX = 9;
  const smallWarning = () => {
    const perScale = base * state.img.width / state.mw;       // 저장 배율 1일 때 글자 px
    const k = [1, 2, 3, 4, 6, 8].find(s => perScale * s >= MIN_PX && Math.max(state.img.width, state.img.height) * s <= OUT_MAX);
    return `저장하면 글자가 약 ${glyphPx.toFixed(1)}px로 작아 뭉개집니다. ` + (k ? `저장 크기를 ${k}배로 키우세요.` : '글을 줄이거나 더 큰 그림을 쓰세요.');
  };

  if (!src.length) setStatus('채울 글을 입력하세요.');
  else if (o.auto && res.remaining > 0) setStatus(`글이 너무 길어 가장 작은 글자로도 ${res.remaining.toLocaleString()}자가 들어가지 않습니다. 글을 줄이거나 더 큰 그림을 쓰세요.`, true);
  else if (!res.hasSpace) setStatus('글자가 들어갈 자리가 없습니다. 기본 글자 크기나 경계값을 낮추세요.', true);
  else if (res.remaining > 0) setStatus(`이 글자 크기로는 ${res.remaining.toLocaleString()}자가 들어가지 않습니다. 크기를 줄이거나 '글 길이에 맞춰 그림 꽉 채우기'를 켜세요.`, true);
  else if (!o.auto && !o.repeat && res.fillRatio < 0.97) {
    const more = missingChars(src, base, o);
    setStatus(`글이 모자라 모양의 ${Math.round(res.fillRatio * 100)}%만 채워졌습니다. 약 ${more.toLocaleString()}자 더 쓰면 꽉 찹니다.`);
  }
  else if (glyphPx < MIN_PX) setStatus(smallWarning(), true);
  else setStatus('');
}

let timer = 0;
function schedule() { clearTimeout(timer); timer = setTimeout(render, 120); }

// 슬라이더 옆 숫자 칸 (data-for로 짝지은 슬라이더)
const numFor = id => document.querySelector(`.num[data-for="${id}"]`);

function bindNumbers() {
  document.querySelectorAll('.num').forEach(num => {
    const range = $(num.dataset.for);
    num.addEventListener('input', () => {
      const v = parseFloat(num.value);
      if (!Number.isFinite(v)) return;
      range.value = Math.min(+range.max, Math.max(+range.min, v));
      range.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // 칸을 벗어나면 범위 밖 값은 슬라이더 값으로 되돌린다
    num.addEventListener('change', () => { num.value = range.value; });
    range.addEventListener('input', () => { if (document.activeElement !== num) num.value = range.value; });
  });
}

function syncNumbers() {
  document.querySelectorAll('.num').forEach(num => {
    const range = $(num.dataset.for);
    num.min = range.min; num.max = range.max; num.step = range.step;
    num.disabled = range.disabled;
    const skip = document.activeElement === num || (num.dataset.for === 'fs' && range.disabled) || num.dataset.for === 'zoom';
    if (!skip) num.value = range.value;
  });
}

function syncControls() {
  const auto = $('autoFit').checked;
  $('fs').disabled = auto;
  $('repeatWrap').classList.toggle('disabled', auto);
  syncNumbers();
  const colorMode = document.querySelector('[name=colorMode]:checked').value;
  $('duoWrap').hidden = colorMode !== 'duo';
  // 채울 것(글자/이미지)에 따라 해당 설정만 보인다
  const image = document.querySelector('[name=kind]:checked').value === 'image';
  document.querySelectorAll('.text-only').forEach(el => { el.hidden = image; });
  document.querySelectorAll('.image-only').forEach(el => { el.hidden = !image; });
  $('tileSection').hidden = !image;
  $('bg').hidden = document.querySelector('[name=bgMode]:checked').value !== 'solid';
  const count = editor.textContent.replace(/\s+/g, '').length;
  $('charCount').value = count ? `${count.toLocaleString()}자` : '';
  editor.style.fontFamily = `"${currentFamily()}", "Malgun Gothic", sans-serif`;
  $('removeFont').hidden = !state.fonts[+$('font').value].user;
  $('quantWrap').hidden = colorMode === 'duo';
  $('monoWrap').hidden = colorMode !== 'mono';
  $('thrWrap').hidden = maskMode() === 'full';
  const q = +$('quant').value;
  $('quantOut').value = q > 16 ? '원본' : colorMode === 'mono' ? `${q}단계` : `${q}색`;
  const jpg = $('format').value === 'jpg';
  $('save').textContent = jpg ? 'JPG 저장' : 'PNG 저장';
  $('formatNote').hidden = !(jpg && document.querySelector('[name=bgMode]:checked').value === 'none');
  // 투명한 부분이 없을 때(JPG 저장·단색 배경)는 흰색 보기가 아무 효과가 없으므로 잠근다
  const noTransparency = jpg || document.querySelector('[name=bgMode]:checked').value === 'solid';
  $('whiteView').disabled = noTransparency;
  $('whiteView').closest('label').classList.toggle('disabled', noTransparency);
  $('preview').classList.toggle('white', $('whiteView').checked && !noTransparency);
}

function setStatus(msg, warn = false) {
  $('status').textContent = msg;
  $('status').classList.toggle('warn', warn);
}

// ---------- 저장 ----------
// 흰색으로 보고 있던 투명 배경을 PNG로 저장할 때 어떻게 할지 묻는다
function askBackground() {
  const dlg = $('askBg');
  return new Promise(resolve => {
    dlg.addEventListener('close', () => resolve(dlg.returnValue || 'cancel'), { once: true });
    dlg.returnValue = '';
    dlg.showModal();
  });
}

async function save() {
  if (!state.img) return;
  const o = readOptions();
  if (o.format === 'png' && o.bgMode === 'none' && $('whiteView').checked) {
    const answer = await askBackground();
    if (answer === 'cancel') return;
    if (answer === 'white') { o.bgMode = 'solid'; o.bg = '#ffffff'; }
  }
  $('save').disabled = true;
  try {
    const { src, base } = await computeLayout(o);
    const [ow, oh] = outSize(o.outScale);
    const c = document.createElement('canvas');
    paint(c, ow, oh, o, src, base);
    const mime = o.format === 'jpg' ? 'image/jpeg' : 'image/png';
    let blob = await new Promise(res => c.toBlob(res, mime, 0.95));
    if (!blob) throw new Error('toBlob');
    // 원본 해상도(DPI)를 옮겨 적는다. 크기를 키웠으면 인쇄 크기가 같도록 DPI도 같은 배율로.
    if (state.dpi) {
      const k = ow / state.img.width;
      const dpi = { x: state.dpi.x * k, y: state.dpi.y * k };
      const buf = await blob.arrayBuffer();
      blob = new Blob([o.format === 'jpg' ? jpegWithDpi(buf, dpi) : pngWithDpi(buf, dpi)], { type: mime });
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${state.name}-글채움.${o.format}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  } catch {
    setStatus('저장하지 못했습니다. 저장 크기를 낮춰 다시 시도하세요.', true);
  } finally {
    $('save').disabled = false;
  }
}

// ---------- 이벤트 ----------
setupFonts();
bindNumbers();

for (const id of ['pick', 'pick2']) $(id).onclick = () => $('file').click();
$('file').onchange = e => { loadFile(e.target.files[0]); e.target.value = ''; };
$('save').onclick = save;
$('fontForm').onsubmit = e => { e.preventDefault(); if ($('fontUrl').value.trim()) addFontFromUrl($('fontUrl').value); };
$('removeFont').onclick = removeCurrentFont;

// 포토 모자이크 타일
$('pickTiles').onclick = () => $('tileFile').click();
$('tileFile').onchange = e => { addTiles(e.target.files); e.target.value = ''; };
$('clearTiles').onclick = () => { state.tiles = []; renderTileList(); schedule(); };
const tileSection = $('tileSection');
tileSection.addEventListener('dragover', e => { e.preventDefault(); e.stopPropagation(); tileSection.classList.add('dragging'); });
tileSection.addEventListener('dragleave', () => tileSection.classList.remove('dragging'));
tileSection.addEventListener('drop', e => {
  e.preventDefault();
  e.stopPropagation();
  tileSection.classList.remove('dragging');
  addTiles(e.dataTransfer.files);
});

// 탭
document.querySelectorAll('[role=tab]').forEach(tab => tab.addEventListener('click', () => {
  document.querySelectorAll('[role=tab]').forEach(t => t.setAttribute('aria-selected', String(t === tab)));
  document.querySelectorAll('.tab-panel').forEach(p => { p.hidden = p.dataset.panel !== tab.dataset.tab; });
  document.querySelector('.panel-body').scrollTop = 0;
}));

// 확대/축소
$('zoom').addEventListener('input', e => setZoom(+e.target.value / 100));
$('zoomFit').onclick = () => { state.zoom = null; applyZoom(); };
$('whiteView').addEventListener('change', syncControls);
$('outScale').addEventListener('change', applyZoom);
window.addEventListener('resize', () => { if (state.zoom === null) applyZoom(); });
$('stage').addEventListener('wheel', e => {
  if (!state.img || !(e.ctrlKey || e.metaKey)) return;
  e.preventDefault();
  setZoom(currentZoom() * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
}, { passive: false });

document.querySelectorAll('.panel input, .panel select').forEach(el => {
  if (['file', 'spanColor', 'size', 'fontUrl'].includes(el.id)) return;
  el.addEventListener('input', schedule);
});
document.querySelectorAll('[name=maskMode]').forEach(el => el.addEventListener('change', () => rebuildMask(true)));

// 서식 도구: 누를 때 편집기 선택이 풀리지 않게
document.querySelectorAll('.tool[data-cmd], #clearFmt, #clearAllFmt').forEach(b => b.addEventListener('mousedown', e => e.preventDefault()));
document.querySelectorAll('.tool[data-cmd]').forEach(b => b.addEventListener('click', () => exec(b.dataset.cmd)));
$('clearFmt').onclick = () => exec('removeFormat');
$('clearAllFmt').onclick = clearAllFormat;
$('size').onchange = e => applySize(+e.target.value);
$('spanColor').addEventListener('input', e => document.documentElement.style.setProperty('--swatch', e.target.value));
$('spanColor').addEventListener('change', e => exec('foreColor', e.target.value));

editor.addEventListener('input', schedule);
editor.addEventListener('paste', e => {
  if ([...e.clipboardData.items].some(i => i.type.startsWith('image/'))) return; // 그림은 아래에서 처리
  e.preventDefault();
  document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
});
editor.addEventListener('drop', e => {
  if (e.dataTransfer.files.length) { e.preventDefault(); e.stopPropagation(); loadFile(e.dataTransfer.files[0]); }
});

const main = $('main');
main.addEventListener('dragover', e => { e.preventDefault(); main.classList.add('dragging'); });
main.addEventListener('dragleave', e => { if (!main.contains(e.relatedTarget)) main.classList.remove('dragging'); });
main.addEventListener('drop', e => {
  e.preventDefault();
  main.classList.remove('dragging');
  loadFile(e.dataTransfer.files[0]);
});
document.addEventListener('paste', e => {
  const item = [...e.clipboardData.items].find(i => i.type.startsWith('image/'));
  if (item) { e.preventDefault(); loadFile(item.getAsFile()); }
});

syncControls();
