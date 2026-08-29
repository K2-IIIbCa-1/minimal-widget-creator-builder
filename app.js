const W = 200;
const H = 40;
const FONT_FAMILY = 'Galmuri9';
const FONT_PX = 10;
const LEFT_PAD = 5;
const RIGHT_PAD = 5;
const TOP_BASELINE = 13;
const BOTTOM_BASELINE = 35;
const MASK_THRESHOLD = 96;
const MAX_CONFIG_BYTES = 60 * 1024;
const DEFAULT_TRACKING = 1;
const WIDGET_ID_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;

// Service operator: replace this once with the public Worker template repository.
const TEMPLATE_REPO_URL = 'https://github.com/K2-IIIbCa-1/minimal-widget-creator-worker';

const CORNER_LAYOUT = {
  tl: { anchor: LEFT_PAD, baseline: TOP_BASELINE, align: 'left' },
  tr: { anchor: W - RIGHT_PAD, baseline: TOP_BASELINE, align: 'right' },
  bl: { anchor: LEFT_PAD, baseline: BOTTOM_BASELINE, align: 'left' },
  br: { anchor: W - RIGHT_PAD, baseline: BOTTOM_BASELINE, align: 'right' },
};

const $ = (id) => document.getElementById(id);
const els = {
  widgetId: $('widgetIdInput'),
  tlText: $('tlTextInput'), tlColor: $('tlColorInput'),
  trText: $('trTextInput'), trColor: $('trColorInput'),
  blText: $('blTextInput'), blColor: $('blColorInput'),
  brText: $('brTextInput'), brColor: $('brColorInput'),
  endedAt: $('endedAtInput'),
  timezone: $('timezoneInput'),
  bgUrl: $('backgroundUrlInput'),
  bgFile: $('backgroundFileInput'),
  downloadBg: $('downloadBgButton'),
  clearBg: $('clearBgButton'),
  fallbackColor: $('fallbackColorInput'),
  shadowColor: $('shadowColorInput'),
  borderColor: $('borderColorInput'),
  frameLight: $('frameLightInput'),
  frameDark: $('frameDarkInput'),
  dim: $('dimInput'),
  dimOutput: $('dimOutput'),
  tracking: $('trackingInput'),
  preview: $('previewCanvas'),
  zoom: $('zoomCanvas'),
  daysNow: $('daysNow'),
  endedIso: $('endedIso'),
  configSize: $('configSize'),
  widgetUrl: $('widgetUrl'),
  warning: $('warningBox'),
  workerUrl: $('workerUrlInput'),
  adminToken: $('adminTokenInput'),
  generateToken: $('generateTokenButton'),
  copyToken: $('copyTokenButton'),
  deploy: $('deployButton'),
  publish: $('publishButton'),
  load: $('loadButton'),
  delete: $('deleteButton'),
  refreshList: $('refreshListButton'),
  widgetList: $('widgetListInput'),
  deployStatus: $('deployStatus'),
  templateRepoDisplay: $('templateRepoDisplay'),
  configOutput: $('configOutput'),
  generate: $('generateButton'),
  copy: $('copyButton'),
};

const cornerInputs = {
  tl: { text: els.tlText, color: els.tlColor },
  tr: { text: els.trText, color: els.trColor },
  bl: { text: els.blText, color: els.blColor },
  br: { text: els.brText, color: els.brColor },
};

let localBackgroundUrl = null;
let localBackgroundImage = null;
let hostedBackgroundImage = null;
let lastConfig = '';
let renderGeneration = 0;

function populateTimezones() {
  for (let mins = -12 * 60; mins <= 14 * 60; mins += 30) {
    const sign = mins >= 0 ? '+' : '-';
    const abs = Math.abs(mins);
    const hh = String(Math.floor(abs / 60)).padStart(2, '0');
    const mm = String(abs % 60).padStart(2, '0');
    const value = `${sign}${hh}:${mm}`;
    const option = document.createElement('option');
    option.value = value;
    option.textContent = `UTC${value}`;
    if (value === '+09:00') option.selected = true;
    els.timezone.append(option);
  }
}

function buildIsoString() {
  const local = els.endedAt.value;
  if (!local) throw new Error('Ended at is required.');
  return `${local}:00${els.timezone.value}`;
}

function elapsedDays(iso) {
  const ended = Date.parse(iso);
  if (!Number.isFinite(ended)) throw new Error('Invalid end date.');
  return Math.floor((Date.now() - ended) / 86400000);
}

function validateWidgetId() {
  const id = els.widgetId.value.trim();
  if (!WIDGET_ID_RE.test(id)) {
    throw new Error('Widget ID must start with a lowercase letter/digit and use only a-z, 0-9, _ or -.');
  }
  return id;
}

function validateDaysPattern(text) {
  const count = (text.match(/\{days\}/g) || []).length;
  if (count > 1) throw new Error('Each corner may contain {days} at most once.');
  return count === 1;
}

async function ensureFont() {
  await document.fonts.load(`${FONT_PX}px ${FONT_FAMILY}`, '한글ABC0123');
  await document.fonts.ready;
}

function createTextRaster(text, baseline = 12) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 18;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const drawX = 4;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.font = `${FONT_PX}px ${FONT_FAMILY}`;
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#fff';
  ctx.imageSmoothingEnabled = false;
  if ('fontKerning' in ctx) ctx.fontKerning = 'none';
  ctx.fillText(text, drawX, baseline);
  const blankAdvance = Math.max(1, Math.round(ctx.measureText(text).width));
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { data, blankAdvance, baseline };
}

function scanBoundingBox(imageData, threshold = MASK_THRESHOLD) {
  const { width, height, data } = imageData;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const a = data[(y * width + x) * 4 + 3];
      if (a >= threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < minX || maxY < minY) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

function packMask(imageData, box, threshold = MASK_THRESHOLD) {
  if (!box) return new Uint8Array(0);
  const out = new Uint8Array(Math.ceil((box.w * box.h) / 8));
  let bit = 0;
  for (let y = 0; y < box.h; y++) {
    for (let x = 0; x < box.w; x++, bit++) {
      const srcX = box.x + x;
      const srcY = box.y + y;
      const a = imageData.data[(srcY * imageData.width + srcX) * 4 + 3];
      if (a >= threshold) out[bit >> 3] |= 1 << (7 - (bit & 7));
    }
  }
  return out;
}

function bytesToBase64Url(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
}

function utf8ToBase64Url(text) {
  return bytesToBase64Url(new TextEncoder().encode(text));
}

function base64UrlToBytes(s) {
  const padded = s.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - s.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

function base64UrlToUtf8(s) {
  return new TextDecoder().decode(base64UrlToBytes(s));
}

function maskHas(bits, index) {
  return (bits[index >> 3] & (1 << (7 - (index & 7)))) !== 0;
}

function bakeGlyph(char) {
  const raster = createTextRaster(char, 12);
  const box = scanBoundingBox(raster.data);
  if (!box) {
    return { advance: raster.blankAdvance, dx: 0, dy: 0, w: 0, h: 0, bits: '' };
  }
  return {
    advance: box.w,
    dx: 0,
    dy: box.y - raster.baseline,
    w: box.w,
    h: box.h,
    bits: bytesToBase64Url(packMask(raster.data, box)),
  };
}

function buildGlyphAtlasFromText(text) {
  const glyphs = {};
  for (const ch of new Set([...text])) glyphs[ch] = bakeGlyph(ch);
  return glyphs;
}

function buildDynamicGlyphAtlas(pattern) {
  const chars = new Set([...pattern.replace('{days}', ''), ...'0123456789-']);
  const glyphs = {};
  for (const ch of chars) glyphs[ch] = bakeGlyph(ch);
  return glyphs;
}

function trackingValue() {
  const value = Number(els.tracking.value);
  return Number.isInteger(value) ? Math.min(3, Math.max(0, value)) : DEFAULT_TRACKING;
}

function hasInk(glyph) {
  return glyph.w > 0 && glyph.h > 0 && Boolean(glyph.bits);
}

function needsPixelGap(current, next) {
  return hasInk(current) && hasInk(next);
}

function measureGlyphText(text, glyphs, tracking = 0) {
  const chars = [...text];
  let width = 0;
  for (let i = 0; i < chars.length; i++) {
    const glyph = glyphs[chars[i]];
    if (!glyph) throw new Error(`Glyph missing: ${JSON.stringify(chars[i])}`);
    width += glyph.advance;
    if (i < chars.length - 1) {
      const next = glyphs[chars[i + 1]];
      if (next && needsPixelGap(glyph, next)) width += tracking;
    }
  }
  return width;
}

function layoutGlyphText(text, glyphs, anchorX, baseline, color, tracking = 0, align = 'left') {
  const chars = [...text];
  const width = measureGlyphText(text, glyphs, tracking);
  let cx = align === 'right' ? anchorX - width : anchorX;
  const layers = [];

  for (let i = 0; i < chars.length; i++) {
    const glyph = glyphs[chars[i]];
    if (!glyph) throw new Error(`Glyph missing: ${JSON.stringify(chars[i])}`);
    if (hasInk(glyph)) {
      layers.push({ x: cx, y: baseline + glyph.dy, w: glyph.w, h: glyph.h, bits: glyph.bits, color });
    }
    cx += glyph.advance;
    if (i < chars.length - 1) {
      const next = glyphs[chars[i + 1]];
      if (next && needsPixelGap(glyph, next)) cx += tracking;
    }
  }

  return { width, layers };
}

function mergeGlyphLayers(layers, advance, color, fallbackX, baseline) {
  if (!layers.length) return { x: fallbackX, y: baseline, w: 0, h: 0, bits: '', color, advance };

  const minX = Math.min(...layers.map((layer) => layer.x));
  const minY = Math.min(...layers.map((layer) => layer.y));
  const maxX = Math.max(...layers.map((layer) => layer.x + layer.w));
  const maxY = Math.max(...layers.map((layer) => layer.y + layer.h));
  const w = maxX - minX;
  const h = maxY - minY;
  const packed = new Uint8Array(Math.ceil((w * h) / 8));
  const setBit = (index) => { packed[index >> 3] |= 1 << (7 - (index & 7)); };

  for (const layer of layers) {
    const bits = base64UrlToBytes(layer.bits);
    for (let y = 0; y < layer.h; y++) {
      for (let x = 0; x < layer.w; x++) {
        if (!maskHas(bits, y * layer.w + x)) continue;
        setBit((layer.y - minY + y) * w + (layer.x - minX + x));
      }
    }
  }

  return { x: minX, y: minY, w, h, bits: bytesToBase64Url(packed), color, advance };
}

function makeBakedLayer(text, anchor, baseline, color, tracking, align) {
  const glyphs = buildGlyphAtlasFromText(text);
  const layout = layoutGlyphText(text, glyphs, anchor, baseline, color, tracking, align);
  return mergeGlyphLayers(layout.layers, layout.width, color, anchor, baseline);
}

function drawPackedMask(ctx, layer, color = layer.color, shadow = true) {
  if (!layer.w || !layer.h || !layer.bits) return;
  const bits = base64UrlToBytes(layer.bits);
  const paint = (dx, dy, fill) => {
    ctx.fillStyle = fill;
    for (let y = 0; y < layer.h; y++) {
      let runStart = -1;
      for (let x = 0; x <= layer.w; x++) {
        const on = x < layer.w && maskHas(bits, y * layer.w + x);
        if (on && runStart < 0) runStart = x;
        if ((!on || x === layer.w) && runStart >= 0) {
          ctx.fillRect(layer.x + runStart + dx, layer.y + y + dy, x - runStart, 1);
          runStart = -1;
        }
      }
    }
  };
  if (shadow) paint(1, 1, els.shadowColor.value);
  paint(0, 0, color);
}

function drawFrame(ctx) {
  ctx.strokeStyle = els.borderColor.value;
  ctx.strokeRect(0.5, 0.5, W - 1, H - 1);
  ctx.fillStyle = els.frameLight.value;
  ctx.fillRect(1, 1, W - 2, 1);
  ctx.fillRect(1, 1, 1, H - 2);
  ctx.fillStyle = els.frameDark.value;
  ctx.fillRect(1, H - 2, W - 2, 1);
  ctx.fillRect(W - 2, 1, 1, H - 2);
}

function drawFallbackBackground(ctx) {
  ctx.fillStyle = els.fallbackColor.value;
  ctx.fillRect(0, 0, W, H);
  const grad = ctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, 'rgba(255,255,255,.12)');
  grad.addColorStop(1, 'rgba(0,0,0,.12)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);
}

function drawImageCover(ctx, image) {
  const scale = Math.max(W / image.naturalWidth, H / image.naturalHeight);
  const dw = image.naturalWidth * scale;
  const dh = image.naturalHeight * scale;
  ctx.drawImage(image, (W - dw) / 2, (H - dh) / 2, dw, dh);
}

function currentBackgroundImage() {
  return localBackgroundImage || hostedBackgroundImage || null;
}

async function loadHostedBackground() {
  const src = els.bgUrl.value.trim();
  if (!src) { hostedBackgroundImage = null; return; }
  const image = new Image();
  hostedBackgroundImage = await new Promise((resolve) => {
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = src;
  });
}

function optimizedBackgroundBlob() {
  return new Promise((resolve, reject) => {
    const img = localBackgroundImage;
    if (!img) return reject(new Error('Choose a local image first.'));
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    drawImageCover(ctx, img);
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('WebP export failed.')), 'image/webp', 0.86);
  });
}

function buildCorner(name, days, tracking) {
  const input = cornerInputs[name];
  const layout = CORNER_LAYOUT[name];
  const text = input.text.value;
  const color = input.color.value;
  const dynamic = validateDaysPattern(text);

  if (dynamic) {
    const glyphs = buildDynamicGlyphAtlas(text);
    const currentText = text.replace('{days}', String(days));
    const preview = layoutGlyphText(currentText, glyphs, layout.anchor, layout.baseline, color, tracking, layout.align);
    return {
      width: preview.width,
      layers: preview.layers,
      config: {
        text, color, align: layout.align, anchor: layout.anchor, baseline: layout.baseline,
        tracking, mode: 'days', glyphs,
      },
    };
  }

  const layer = makeBakedLayer(text, layout.anchor, layout.baseline, color, tracking, layout.align);
  return {
    width: layer.advance || 0,
    layers: layer.bits ? [layer] : [],
    config: {
      text, color, align: layout.align, anchor: layout.anchor, baseline: layout.baseline,
      tracking, mode: 'static', layer,
    },
  };
}

async function buildBakedState() {
  await ensureFont();
  const iso = buildIsoString();
  const days = elapsedDays(iso);
  const tracking = trackingValue();
  const corners = {};
  for (const name of ['tl', 'tr', 'bl', 'br']) corners[name] = buildCorner(name, days, tracking);
  return { iso, days, tracking, corners };
}

async function renderPreview() {
  const generation = ++renderGeneration;
  try {
    const baked = await buildBakedState();
    if (generation !== renderGeneration) return;

    const ctx = els.preview.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, W, H);
    const bg = currentBackgroundImage();
    if (bg) drawImageCover(ctx, bg); else drawFallbackBackground(ctx);
    ctx.fillStyle = `rgba(0,0,0,${Number(els.dim.value) / 100})`;
    ctx.fillRect(0, 0, W, H);
    drawFrame(ctx);
    for (const name of ['tl', 'tr', 'bl', 'br']) {
      for (const layer of baked.corners[name].layers) drawPackedMask(ctx, layer, layer.color);
    }

    const zctx = els.zoom.getContext('2d');
    zctx.imageSmoothingEnabled = false;
    zctx.clearRect(0, 0, 800, 160);
    zctx.drawImage(els.preview, 0, 0, 800, 160);

    els.daysNow.textContent = String(baked.days);
    els.endedIso.textContent = baked.iso;
    els.dimOutput.value = `${els.dim.value}%`;
    updateWidgetUrl();

    const warnings = [];
    const usableWidth = W - LEFT_PAD - RIGHT_PAD;
    if (baked.corners.tl.width > usableWidth) warnings.push('Top-left text is wider than the card.');
    if (baked.corners.tr.width > usableWidth) warnings.push('Top-right text is wider than the card.');
    if (baked.corners.bl.width > usableWidth) warnings.push('Bottom-left text is wider than the card.');
    if (baked.corners.br.width > usableWidth) warnings.push('Bottom-right text is wider than the card.');
    if (baked.corners.tl.width + baked.corners.tr.width + 6 > usableWidth) warnings.push('Top-left and top-right text may overlap.');
    if (baked.corners.bl.width + baked.corners.br.width + 6 > usableWidth) warnings.push('Bottom-left and bottom-right text may overlap.');
    if (els.bgUrl.value.trim() && !hostedBackgroundImage && !localBackgroundImage) {
      warnings.push('Background URL could not be previewed. It may still work in the Worker if the host blocks browser CORS.');
    }
    showWarnings(warnings);
  } catch (error) {
    showWarnings([error instanceof Error ? error.message : String(error)]);
  }
}

function showWarnings(items) {
  if (!items.length) {
    els.warning.hidden = true;
    els.warning.textContent = '';
    return;
  }
  els.warning.hidden = false;
  els.warning.innerHTML = items.map((value) => `• ${escapeHtml(value)}`).join('<br>');
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
}

async function generateConfig() {
  validateWidgetId();
  const baked = await buildBakedState();
  const backgroundUrl = els.bgUrl.value.trim();
  if (backgroundUrl && !/^https:\/\//i.test(backgroundUrl)) throw new Error('Hosted background URL must use HTTPS.');

  const config = {
    v: 3,
    size: [W, H],
    endedAt: baked.iso,
    backgroundUrl,
    fallbackColor: els.fallbackColor.value,
    dim: Number(els.dim.value) / 100,
    shadowColor: els.shadowColor.value,
    frame: {
      border: els.borderColor.value,
      light: els.frameLight.value,
      dark: els.frameDark.value,
    },
    corners: Object.fromEntries(['tl', 'tr', 'bl', 'br'].map((name) => [name, baked.corners[name].config])),
  };

  const encoded = utf8ToBase64Url(JSON.stringify(config));
  const byteSize = new TextEncoder().encode(encoded).length;
  els.configSize.textContent = `${byteSize} bytes`;
  if (byteSize > MAX_CONFIG_BYTES) throw new Error(`Card payload is ${byteSize} bytes; shorten text or simplify the card.`);
  lastConfig = encoded;
  els.configOutput.value = encoded;
  els.copy.disabled = false;
  return encoded;
}

function applyConfig(encoded) {
  const config = JSON.parse(base64UrlToUtf8(encoded));
  if (config.v !== 3) throw new Error('This widget was made with an incompatible Builder version.');

  const match = String(config.endedAt).match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}):\d{2}([+-]\d{2}:\d{2})$/);
  if (match) {
    els.endedAt.value = match[1];
    els.timezone.value = match[2];
  }
  els.bgUrl.value = config.backgroundUrl || '';
  els.fallbackColor.value = config.fallbackColor || '#6f7188';
  els.shadowColor.value = config.shadowColor || '#000000';
  els.borderColor.value = config.frame?.border || '#23232a';
  els.frameLight.value = config.frame?.light || '#cdCDD2';
  els.frameDark.value = config.frame?.dark || '#414149';
  els.dim.value = String(Math.round((config.dim ?? 0.32) * 100));

  const firstTracking = config.corners?.tl?.tracking ?? 1;
  els.tracking.value = String(firstTracking);
  for (const name of ['tl', 'tr', 'bl', 'br']) {
    const corner = config.corners?.[name];
    if (!corner) continue;
    cornerInputs[name].text.value = corner.text || '';
    cornerInputs[name].color.value = corner.color || '#f7f7f3';
  }

  lastConfig = encoded;
  els.configOutput.value = encoded;
  els.configSize.textContent = `${new TextEncoder().encode(encoded).length} bytes`;
  els.copy.disabled = false;
}

function debounce(fn, delay = 100) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

function invalidateAndRender() {
  lastConfig = '';
  els.copy.disabled = true;
  rerender();
}

const rerender = debounce(renderPreview, 80);

function normalizeWorkerUrl() {
  const raw = els.workerUrl.value.trim();
  if (!raw) throw new Error('Worker base URL is required.');
  const url = new URL(raw);
  if (!/^https?:$/.test(url.protocol)) throw new Error('Worker URL must use HTTP(S).');
  url.pathname = url.pathname.replace(/\/$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function updateWidgetUrl() {
  const id = els.widgetId.value.trim();
  if (!WIDGET_ID_RE.test(id)) {
    els.widgetUrl.textContent = '-';
    return;
  }
  const raw = els.workerUrl.value.trim();
  if (!raw) {
    els.widgetUrl.textContent = `/<${id}>.svg`.replace('<', '').replace('>', '');
    return;
  }
  try {
    els.widgetUrl.textContent = `${normalizeWorkerUrl()}/${id}.svg`;
  } catch {
    els.widgetUrl.textContent = '-';
  }
}

function setDeployStatus(message, isError = false) {
  els.deployStatus.textContent = message;
  els.deployStatus.classList.toggle('error', isError);
}

async function adminRequest(method, path, body) {
  const base = normalizeWorkerUrl();
  const token = els.adminToken.value;
  if (!token) throw new Error('Admin token is required.');
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(text || `${response.status} ${response.statusText}`);
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

async function publishWidget() {
  try {
    const id = validateWidgetId();
    const config = await generateConfig();
    setDeployStatus(`Publishing ${id}...`);
    const result = await adminRequest('PUT', `/api/widgets/${id}`, { config });
    const url = `${normalizeWorkerUrl()}${result.path}`;
    setDeployStatus(`Published: ${url}`);
    els.widgetUrl.textContent = url;
    await refreshWidgetList(false);
  } catch (error) {
    setDeployStatus(error instanceof Error ? error.message : String(error), true);
  }
}

async function loadWidget() {
  try {
    const id = validateWidgetId();
    setDeployStatus(`Loading ${id}...`);
    const result = await adminRequest('GET', `/api/widgets/${id}`);
    applyConfig(result.config);
    await loadHostedBackground();
    await renderPreview();
    setDeployStatus(`Loaded: ${id}`);
  } catch (error) {
    setDeployStatus(error instanceof Error ? error.message : String(error), true);
  }
}

async function deleteWidget() {
  try {
    const id = validateWidgetId();
    if (!window.confirm(`Delete widget "${id}"?`)) return;
    await adminRequest('DELETE', `/api/widgets/${id}`);
    setDeployStatus(`Deleted: ${id}`);
    await refreshWidgetList(false);
  } catch (error) {
    setDeployStatus(error instanceof Error ? error.message : String(error), true);
  }
}

async function refreshWidgetList(showStatus = true) {
  try {
    const result = await adminRequest('GET', '/api/widgets');
    els.widgetList.replaceChildren(new Option('-', ''));
    for (const id of result.ids || []) els.widgetList.append(new Option(id, id));
    if (showStatus) setDeployStatus(`Loaded ${result.ids?.length || 0} widget ID(s).`);
  } catch (error) {
    if (showStatus) setDeployStatus(error instanceof Error ? error.message : String(error), true);
  }
}

function generateAdminToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  els.adminToken.value = bytesToBase64Url(bytes);
  setDeployStatus('Generated an admin token. Use this same value on the Cloudflare deployment screen.');
}

const configInputs = [
  els.tlText, els.tlColor, els.trText, els.trColor, els.blText, els.blColor, els.brText, els.brColor,
  els.endedAt, els.timezone, els.fallbackColor, els.shadowColor, els.borderColor, els.frameLight, els.frameDark,
  els.dim, els.tracking,
];
for (const input of configInputs) {
  input.addEventListener('input', invalidateAndRender);
  input.addEventListener('change', invalidateAndRender);
}

els.widgetId.addEventListener('input', updateWidgetUrl);
els.widgetId.addEventListener('change', updateWidgetUrl);
els.workerUrl.addEventListener('input', updateWidgetUrl);
els.workerUrl.addEventListener('change', updateWidgetUrl);

els.bgUrl.addEventListener('change', async () => {
  lastConfig = '';
  els.copy.disabled = true;
  await loadHostedBackground();
  renderPreview();
});
els.bgUrl.addEventListener('input', debounce(async () => {
  lastConfig = '';
  els.copy.disabled = true;
  await loadHostedBackground();
  renderPreview();
}, 450));

els.bgFile.addEventListener('change', () => {
  const file = els.bgFile.files?.[0];
  if (!file) return;
  if (localBackgroundUrl) URL.revokeObjectURL(localBackgroundUrl);
  localBackgroundUrl = URL.createObjectURL(file);
  const image = new Image();
  image.onload = () => {
    localBackgroundImage = image;
    els.downloadBg.disabled = false;
    renderPreview();
  };
  image.onerror = () => showWarnings(['Could not read local image.']);
  image.src = localBackgroundUrl;
});

els.clearBg.addEventListener('click', () => {
  if (localBackgroundUrl) URL.revokeObjectURL(localBackgroundUrl);
  localBackgroundUrl = null;
  localBackgroundImage = null;
  els.bgFile.value = '';
  els.downloadBg.disabled = true;
  renderPreview();
});

els.downloadBg.addEventListener('click', async () => {
  try {
    const blob = await optimizedBackgroundBlob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'minimal-widget-bg.webp';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) {
    showWarnings([error instanceof Error ? error.message : String(error)]);
  }
});

els.generate.addEventListener('click', async () => {
  try {
    await generateConfig();
    setDeployStatus('Card payload generated.');
  } catch (error) {
    showWarnings([error instanceof Error ? error.message : String(error)]);
  }
});

els.copy.addEventListener('click', async () => {
  if (!lastConfig) return;
  await navigator.clipboard.writeText(lastConfig);
  setDeployStatus('Card payload copied.');
});

els.generateToken.addEventListener('click', generateAdminToken);
els.copyToken.addEventListener('click', async () => {
  if (!els.adminToken.value) generateAdminToken();
  await navigator.clipboard.writeText(els.adminToken.value);
  setDeployStatus('Admin token copied.');
});

els.deploy.addEventListener('click', () => {
  if (/YOUR_NAME/.test(TEMPLATE_REPO_URL)) {
    setDeployStatus('Template repo is still a placeholder. Publish worker-template/ as a public repo and set TEMPLATE_REPO_URL in builder/app.js first.', true);
    return;
  }
  if (!els.adminToken.value) generateAdminToken();
  const url = `https://deploy.workers.cloudflare.com/?url=${encodeURIComponent(TEMPLATE_REPO_URL)}`;
  setDeployStatus('Cloudflare opened in a new tab. Paste the current Admin token into ADMIN_TOKEN during setup.');
  window.open(url, '_blank', 'noopener,noreferrer');
});

els.publish.addEventListener('click', publishWidget);
els.load.addEventListener('click', loadWidget);
els.delete.addEventListener('click', deleteWidget);
els.refreshList.addEventListener('click', () => refreshWidgetList(true));
els.widgetList.addEventListener('change', () => {
  if (!els.widgetList.value) return;
  els.widgetId.value = els.widgetList.value;
  updateWidgetUrl();
});

async function init() {
  populateTimezones();
  els.templateRepoDisplay.textContent = TEMPLATE_REPO_URL;

  try {
    await ensureFont();
  } catch (error) {
    showWarnings(['Galmuri9 could not be loaded. Check your network connection or font CDN access.']);
  }

  await renderPreview();
  setInterval(renderPreview, 60_000);
}

init().catch((error) => {
  console.error('Builder initialization failed:', error);
  showWarnings([error instanceof Error ? error.message : String(error)]);
});
