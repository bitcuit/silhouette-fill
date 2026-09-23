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
  maskKey: '', maskCanvas: null,
  bgColor: null,           // 투명 없는 그림의 가장자리 색
  opaque: false,
  fonts: [],
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
  // 투명한 곳이 없으면: 가장자리가 한 색이면 그 배경색을 빼고(로고·일러스트), 아니면 그림 전체를 채운다(사진)
  const border = borderColor(rgba, mw, mh);
  state.bgColor = border.color;
  const mode = !opaque ? 'alpha' : border.uniform ? 'bg' : 'full';
  document.querySelector(`[name=maskMode][value=${mode}]`).checked = true;
  rebuildMask(true);

  // 저장 형식은 원본을 따르고, 저장 크기에 실제 픽셀 수를 적는다
  $('format').value = file.type === 'image/jpeg' ? 'jpg' : 'png';
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
  $('zoomOut').value = `${Math.round(z * 100)}%`;
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

// 가장자리 픽셀의 중앙값 색과, 가장자리가 거의 그 한 색인지
function borderColor(rgba, mw, mh) {
  const rs = [], gs = [], bs = [];
  const add = (x, y) => { const p = (y * mw + x) * 4; rs.push(rgba[p]); gs.push(rgba[p + 1]); bs.push(rgba[p + 2]); };
  const step = Math.max(1, Math.floor((mw + mh) / 800));
  for (let x = 0; x < mw; x += step) { add(x, 0); add(x, mh - 1); }
  for (let y = 0; y < mh; y += step) { add(0, y); add(mw - 1, y); }
  const med = a => a.slice().sort((p, q) => p - q)[a.length >> 1];
  const color = [med(rs), med(gs), med(bs)];
  let near = 0;
  for (let i = 0; i < rs.length; i++) {
    if ((rs[i] - color[0]) ** 2 + (gs[i] - color[1]) ** 2 + (bs[i] - color[2]) ** 2 < 40 * 40) near++;
  }
  return { color, uniform: near / rs.length >= 0.85 };
}

function rebuildMask(resetThreshold) {
  const { rgba, mw, mh } = state;
  if (!rgba) return;
  const mode = maskMode();
  const m = new Uint8Array(mw * mh);
  const bg = state.bgColor || [255, 255, 255];
  for (let i = 0, p = 0; i < m.length; i++, p += 4) {
    const a = rgba[p + 3];
    if (mode === 'full') { m[i] = 255; continue; }
    if (mode === 'alpha') { m[i] = a; continue; }
    // 배경색 제외: 배경색에서 얼마나 먼 색인지
    if (a < 128) { m[i] = 0; continue; }
    const d = Math.sqrt((rgba[p] - bg[0]) ** 2 + (rgba[p + 1] - bg[1]) ** 2 + (rgba[p + 2] - bg[2]) ** 2);
    m[i] = Math.min(255, Math.round(d));
  }
  state.mask = m;
  state.maskKey = '';
  state.paletteKey = '';
  if (resetThreshold) $('thr').value = mode === 'bg' ? Math.min(200, Math.max(24, otsu(m))) : 128;
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

function getMaskCanvas(thr) {
  const key = `${maskMode()}|${thr}`;
  if (state.maskKey === key) return state.maskCanvas;
  const { mask, mw, mh } = state;
  const c = document.createElement('canvas');
  c.width = mw; c.height = mh;
  const cx = c.getContext('2d');
  const id = cx.createImageData(mw, mh);
  for (let i = 0; i < mask.length; i++) id.data[i * 4 + 3] = mask[i] >= thr ? 255 : 0;
  cx.putImageData(id, 0, 0);
  state.maskKey = key;
  state.maskCanvas = c;
  return c;
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
      for (const ch of node.data) {
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
// 줄마다 글자 몸통 높이 전체가 모양 안에 드는 가로 구간을 찾아 글자 단위로 차례로 채운다.
// 줄 높이는 그 줄에 실제로 들어간 가장 큰 글자에 맞춘다.
function layout(src, base, o, onLine) {
  const { mask, mw, mh } = state;
  const n = src.length, thr = o.thr;
  const inside = new Uint8Array(mw);
  let idx = 0, y = 0, totalArea = 0, emptyArea = 0;

  const peekSize = () => {
    for (let k = 0; k < n; k++) {
      let j = idx + k;
      if (j >= n) { if (!o.repeat) break; j -= n; }
      if (src[j].ch !== ' ') return src[j].scale * base;
    }
    return base;
  };

  const scan = (top, h) => {
    const y0 = Math.max(0, Math.floor(top + h * 0.08));
    const y1 = Math.min(mh - 1, Math.ceil(top + h * 0.92));
    const step = Math.max(1, Math.floor(h / 6));
    inside.fill(1);
    for (let yy = y0; ; yy += step) {
      if (yy > y1) yy = y1;
      const row = yy * mw;
      for (let x = 0; x < mw; x++) if (mask[row + x] < thr) inside[x] = 0;
      if (yy === y1) break;
    }
  };

  const fill = (start, h) => {
    let i = start, maxH = 0, area = 0, empty = 0;
    const lines = [];
    const minW = Math.min(h, base) * 0.9;
    let x = 0;
    while (x < mw) {
      while (x < mw && !inside[x]) x++;
      const a = x;
      while (x < mw && inside[x]) x++;
      const runW = x - a;
      if (runW < minW) continue;
      area += runW;
      if (i >= n && !o.repeat) { empty += runW; continue; }

      const items = [], widths = [];
      let used = 0;
      while (items.length < 5000) {
        if (i >= n) { if (o.repeat) i = 0; else break; }
        const it = src[i];
        if (!items.length && it.ch === ' ') { i++; continue; }
        const w = charWidth100(o.family, it.bold, it.italic, it.ch) * it.scale * base / 100;
        if (used + w > runW) break;
        items.push(it); widths.push(w); used += w; i++;
      }
      while (items.length && items[items.length - 1].ch === ' ') { items.pop(); used -= widths.pop(); }
      if (!items.length) continue;
      for (const it of items) maxH = Math.max(maxH, it.scale * base);
      lines.push({ items, widths, a });
    }
    return { i, maxH, area, empty, lines };
  };

  for (;;) {
    let h = idx >= n && !o.repeat ? base : peekSize();
    let res = null, top = 0, pitch = 0;
    for (let iter = 0; iter < 4; iter++) {
      pitch = h * o.lh;
      top = y + (pitch - h) / 2;
      if (top + h * 0.92 > mh) { res = null; break; }
      scan(top, h);
      res = fill(idx, h);
      if (res.maxH <= h + 0.01 || iter === 3) break;
      h = res.maxH;
    }
    if (!res) break;
    totalArea += res.area;
    emptyArea += res.empty;
    idx = res.i;
    if (onLine) {
      const baseline = top + h * 0.86;
      for (const line of res.lines) onLine(line, baseline, h);
    }
    y += pitch;
  }
  return {
    remaining: o.repeat ? 0 : Math.max(0, n - idx),
    fillRatio: totalArea ? 1 - emptyArea / totalArea : 0,
    hasSpace: totalArea > 0,
  };
}

// 글이 딱 한 번 다 들어가는 가장 큰 기본 크기
function autoFitSize(src, o) {
  let lo = 3, hi = Math.max(4, Math.min(state.mw, state.mh));
  if (layout(src, lo, o).remaining > 0) return lo;
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2;
    if (layout(src, mid, o).remaining === 0) lo = mid; else hi = mid;
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
    colorMode: document.querySelector('[name=colorMode]:checked').value,
    color: $('color').value,
    quant: +$('quant').value,
    stroke: +$('stroke').value / 100,
    format: $('format').value,
    // JPG는 투명을 못 담으므로 투명 배경이면 흰색으로 채운다 (미리보기도 같게)
    bgMode: $('format').value === 'jpg' ? 'solid' : document.querySelector('[name=bgMode]:checked').value,
    bg: $('format').value === 'jpg' && document.querySelector('[name=bgMode]:checked').value === 'none' ? '#ffffff' : $('bg').value,
    ghost: +$('ghost').value / 100,
    clip: $('clip').checked,
    thr: +$('thr').value,
    outScale: +$('outScale').value,
  };
}

async function computeLayout(o) {
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
  const base = src.length && o.auto ? autoFitSize(src, o) : o.fs;
  return { src, base };
}

function paint(canvas, outW, outH, o, src, base) {
  const { img, mw, mh, rgba } = state;
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d');
  const r = outW / mw;
  let result = { remaining: 0, fillRatio: 0, hasSpace: true };

  if (src.length) {
    ctx.setTransform(r, 0, 0, r, 0, 0);
    ctx.textBaseline = 'alphabetic';
    ctx.lineJoin = 'round';
    let lastFont = '';
    const palette = o.colorMode === 'image' && o.quant <= 16 ? getPalette(o.quant, o.thr) : null;
    // 글자가 차지하는 칸의 평균색 (보이는 픽셀만) — 글자 하나에 한 색
    const sample = (x0, y0, w, h) => {
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
      let c = [r / cnt, g / cnt, b / cnt];
      if (palette) c = nearest(palette, c[0], c[1], c[2]);
      return `rgb(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])})`;
    };
    result = layout(src, base, o, (line, baseline) => {
      const { items, widths } = line;
      let x = line.a;
      for (let k = 0; k < items.length; k++) {
        const it = items[k], w = widths[k], px = it.scale * base;
        const f = fontStr(o.family, it.bold, it.italic, px);
        if (f !== lastFont) ctx.font = lastFont = f;
        ctx.fillStyle = it.color || (o.colorMode === 'image' ? sample(x, baseline - px * 0.8, w, px * 0.8) : o.color);
        ctx.fillText(it.ch, x, baseline);
        // 획을 두껍게 하면 글자 사이 빈틈이 줄어 멀리서 그림이 더 진하게 보인다
        if (o.stroke > 0) {
          ctx.strokeStyle = ctx.fillStyle;
          ctx.lineWidth = px * o.stroke;
          ctx.strokeText(it.ch, x, baseline);
        }
        if (it.underline) ctx.fillRect(x, baseline + px * 0.1, w, Math.max(0.5, px * 0.06));
        x += w;
      }
    });
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (o.clip) {
      ctx.globalCompositeOperation = 'destination-in';
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(getMaskCanvas(o.thr), 0, 0, outW, outH);
    }
  }

  // 글이 없을 땐 모양이 보이도록 원본을 옅게 깐다
  const ghost = src.length ? o.ghost : Math.max(o.ghost, 0.15);
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
  if (o.auto) $('fsOut').value = `${Math.round(base * 10) / 10}`;

  const [pw, ph] = previewSize(o.outScale);
  const res = paint($('preview'), pw, ph, o, src, base);

  if (!src.length) setStatus('채울 글을 입력하세요.');
  else if (!res.hasSpace) setStatus('글자가 들어갈 자리가 없습니다. 기본 글자 크기나 경계값을 낮추세요.', true);
  else if (res.remaining > 0) setStatus(`자리가 모자라 ${res.remaining.toLocaleString()}자가 빠졌습니다. 기본 글자 크기를 줄이세요.`, true);
  else if (!o.repeat && res.fillRatio < 0.97) setStatus(`글이 모자라 모양의 ${Math.round(res.fillRatio * 100)}%만 채워졌습니다.`);
  else setStatus('');
}

let timer = 0;
function schedule() { clearTimeout(timer); timer = setTimeout(render, 80); }

function syncControls() {
  const auto = $('autoFit').checked;
  $('fs').disabled = auto;
  $('repeatWrap').classList.toggle('disabled', auto);
  if (!auto) $('fsOut').value = $('fs').value;
  $('lhOut').value = (+$('lh').value).toFixed(2);
  $('ghostOut').value = `${$('ghost').value}%`;
  $('thrOut').value = $('thr').value;
  $('color').hidden = document.querySelector('[name=colorMode]:checked').value !== 'solid';
  $('bg').hidden = document.querySelector('[name=bgMode]:checked').value !== 'solid';
  const count = editor.textContent.replace(/\s+/g, '').length;
  $('charCount').value = count ? `${count.toLocaleString()}자` : '';
  editor.style.fontFamily = `"${currentFamily()}", "Malgun Gothic", sans-serif`;
  $('removeFont').hidden = !state.fonts[+$('font').value].user;
  $('quantWrap').hidden = document.querySelector('[name=colorMode]:checked').value === 'solid';
  $('thrWrap').hidden = maskMode() === 'full';
  $('strokeOut').value = +$('stroke').value ? `${$('stroke').value}%` : '없음';
  const q = +$('quant').value;
  $('quantOut').value = q > 16 ? '원본' : `${q}색`;
  const jpg = $('format').value === 'jpg';
  $('save').textContent = jpg ? 'JPG 저장' : 'PNG 저장';
  $('formatNote').hidden = !(jpg && document.querySelector('[name=bgMode]:checked').value === 'none');
  $('preview').classList.toggle('white', $('whiteView').checked);
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

for (const id of ['pick', 'pick2']) $(id).onclick = () => $('file').click();
$('file').onchange = e => { loadFile(e.target.files[0]); e.target.value = ''; };
$('save').onclick = save;
$('fontForm').onsubmit = e => { e.preventDefault(); if ($('fontUrl').value.trim()) addFontFromUrl($('fontUrl').value); };
$('removeFont').onclick = removeCurrentFont;

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
$('thr').addEventListener('input', () => { state.maskKey = ''; });

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
