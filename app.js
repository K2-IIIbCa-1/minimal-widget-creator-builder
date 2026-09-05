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
const LIVE_KEY_RE = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const LEGACY_LIVE_NUMBER_RE = /^\{([A-Za-z][A-Za-z0-9_-]{0,31})\}$/;
const MAX_IMAGE_LAYERS = 6;
const PLACEHOLDER_RE = /\{([A-Za-z][A-Za-z0-9_-]{0,31})\}/g;
const RUNTIME_ASCII = Array.from({ length: 95 }, (_, i) => String.fromCharCode(i + 32)).join('');

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
  imageLayers: $('imageLayers'),
  addImageLayer: $('addImageLayerButton'),
  liveImageFieldList: $('liveImageFieldList'),
  liveNumberFieldList: $('liveNumberFieldList'),
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
let loadedLiveValues = {};
let imageLayers = [createBackgroundLayer()];
const previewImageCache = new Map();
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

function layerValueState(value) {
  return { mode: 'fixed', fixed: String(value), field: '', fallback: String(value) };
}

function createBackgroundLayer(source = '') {
  return {
    name: 'Background',
    fit: 'cover',
    source: layerValueState(source),
    x: layerValueState(0), y: layerValueState(0), w: layerValueState(W), h: layerValueState(H),
    cropEnabled: false,
    cropX: layerValueState(0), cropY: layerValueState(0), cropW: layerValueState(W), cropH: layerValueState(H),
  };
}

function createImageLayer(index = imageLayers.length) {
  return {
    name: `Layer ${index}`,
    fit: 'fill',
    source: layerValueState(''),
    x: layerValueState(0), y: layerValueState(0), w: layerValueState(40), h: layerValueState(40),
    cropEnabled: false,
    cropX: layerValueState(0), cropY: layerValueState(0), cropW: layerValueState(40), cropH: layerValueState(40),
  };
}

function validCropRect(crop, sourceW, sourceH) {
  const [x, y, w, h] = crop;
  return x >= 0 && y >= 0 && w >= 1 && h >= 1 && x + w <= sourceW && y + h <= sourceH;
}

function updateLiveFieldSuggestions() {
  els.liveImageFieldList.replaceChildren();
  els.liveNumberFieldList.replaceChildren();
  for (const [key, value] of Object.entries(loadedLiveValues)) {
    if (typeof value === 'string' && /^https:\/\//i.test(value)) els.liveImageFieldList.append(new Option(key, key));
    if (typeof value === 'number' || (typeof value === 'string' && value.trim() && Number.isInteger(Number(value)))) {
      els.liveNumberFieldList.append(new Option(key, key));
    }
  }
}

function imageValueEditor(label, property, state, kind) {
  const editor = document.createElement('div');
  editor.className = 'layer-value-editor';
  editor.dataset.property = property;
  editor.dataset.kind = kind;

  const title = document.createElement('span');
  title.className = 'layer-value-label';
  title.textContent = label;
  editor.append(title);

  const mode = document.createElement('select');
  mode.dataset.role = 'mode';
  mode.append(new Option('Fixed', 'fixed'), new Option('Live', 'live'));
  editor.append(mode);

  const fixed = document.createElement('input');
  fixed.dataset.role = 'fixed';
  fixed.type = kind === 'number' ? 'number' : 'url';
  if (kind === 'number') fixed.step = '1';
  else fixed.placeholder = 'https://...';
  editor.append(fixed);

  const field = document.createElement('input');
  field.dataset.role = 'field';
  field.type = 'text';
  field.maxLength = 32;
  field.placeholder = 'Live field';
  field.setAttribute('list', kind === 'number' ? 'liveNumberFieldList' : 'liveImageFieldList');
  editor.append(field);

  const fallback = document.createElement('input');
  fallback.dataset.role = 'fallback';
  fallback.type = kind === 'number' ? 'number' : 'url';
  if (kind === 'number') fallback.step = '1';
  fallback.placeholder = kind === 'number' ? 'Fallback' : 'Fallback URL';
  fallback.title = 'Fallback';
  editor.append(fallback);

  syncValueEditor(editor, state);
  return editor;
}

function syncValueEditor(editor, state) {
  const live = state.mode === 'live';
  const mode = editor.querySelector('[data-role="mode"]');
  const fixed = editor.querySelector('[data-role="fixed"]');
  const field = editor.querySelector('[data-role="field"]');
  const fallback = editor.querySelector('[data-role="fallback"]');
  mode.value = state.mode;
  fixed.value = state.fixed;
  field.value = state.field;
  fallback.value = state.fallback;
  fixed.hidden = live;
  field.hidden = !live;
  fallback.hidden = !live;
}

function renderImageLayerControls() {
  els.imageLayers.replaceChildren();
  imageLayers.forEach((layer, index) => {
    const article = document.createElement('article');
    article.className = 'image-layer';
    article.dataset.layerIndex = String(index);

    const header = document.createElement('div');
    header.className = 'image-layer-header';
    const title = document.createElement('strong');
    title.textContent = index === 0 ? 'Background' : layer.name;
    header.append(title);

    if (index > 0) {
      const actions = document.createElement('div');
      actions.className = 'image-layer-actions';
      for (const [action, label] of [['up', 'Raise'], ['down', 'Lower'], ['remove', '−']]) {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.action = action;
        button.textContent = label;
        button.title = action === 'up' ? 'Raise layer' : action === 'down' ? 'Lower layer' : 'Remove layer';
        if (action === 'up') button.disabled = index === imageLayers.length - 1;
        if (action === 'down') button.disabled = index === 1;
        actions.append(button);
      }
      header.append(actions);
    }
    article.append(header);

    article.append(imageValueEditor('Source', 'source', layer.source, 'url'));

    const positionDetails = document.createElement('details');
    const positionSummary = document.createElement('summary');
    positionSummary.textContent = 'Position & size';
    positionDetails.append(positionSummary);
    const positionGrid = document.createElement('div');
    positionGrid.className = 'layer-value-grid';
    positionGrid.append(
      imageValueEditor('X', 'x', layer.x, 'number'),
      imageValueEditor('Y', 'y', layer.y, 'number'),
      imageValueEditor('W', 'w', layer.w, 'number'),
      imageValueEditor('H', 'h', layer.h, 'number'),
    );
    positionDetails.append(positionGrid);
    article.append(positionDetails);

    const cropDetails = document.createElement('details');
    const cropSummary = document.createElement('summary');
    cropSummary.textContent = 'Crop';
    cropDetails.append(cropSummary);
    const cropToggle = document.createElement('label');
    cropToggle.className = 'toggle-row compact-toggle';
    const cropEnabled = document.createElement('input');
    cropEnabled.type = 'checkbox';
    cropEnabled.dataset.role = 'crop-enabled';
    cropEnabled.checked = layer.cropEnabled;
    cropToggle.append(cropEnabled, document.createTextNode('Enable crop'));
    cropDetails.append(cropToggle);
    const cropNote = document.createElement('small');
    cropNote.textContent = 'Crop X/Y are offsets inside the full layer image; Position X/Y remains the output anchor.';
    cropDetails.append(cropNote);
    const cropGrid = document.createElement('div');
    cropGrid.className = 'layer-value-grid';
    cropGrid.dataset.role = 'crop-fields';
    cropGrid.hidden = !layer.cropEnabled;
    cropGrid.append(
      imageValueEditor('X', 'cropX', layer.cropX, 'number'),
      imageValueEditor('Y', 'cropY', layer.cropY, 'number'),
      imageValueEditor('W', 'cropW', layer.cropW, 'number'),
      imageValueEditor('H', 'cropH', layer.cropH, 'number'),
    );
    cropDetails.append(cropGrid);
    article.append(cropDetails);

    els.imageLayers.append(article);
  });
  els.addImageLayer.disabled = imageLayers.length >= MAX_IMAGE_LAYERS;
}

function stateForProperty(layer, property) {
  return layer[property];
}

function parseLayerNumber(raw, label, min, max) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${label} must be an integer from ${min} to ${max}.`);
  return value;
}

function validateImageUrl(value, label) {
  const trimmed = value.trim();
  if (trimmed && !/^https:\/\//i.test(trimmed)) throw new Error(`${label} must use HTTPS.`);
  return trimmed;
}

function buildLayerValue(state, label, kind, min = -2048, max = 2048) {
  if (kind === 'url') {
    if (state.mode === 'fixed') return validateImageUrl(state.fixed, label);
    const field = state.field.trim();
    if (!LIVE_KEY_RE.test(field)) throw new Error(`${label} live field must start with a letter and use letters, digits, _ or -.`);
    return { live: field, fallback: validateImageUrl(state.fallback, `${label} fallback`) };
  }

  if (state.mode === 'fixed') return parseLayerNumber(state.fixed, label, min, max);
  const field = state.field.trim();
  if (!LIVE_KEY_RE.test(field)) throw new Error(`${label} live field must start with a letter and use letters, digits, _ or -.`);
  return { live: field, fallback: parseLayerNumber(state.fallback, `${label} fallback`, min, max) };
}

function configFallback(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && 'live' in value ? value.fallback : value;
}

function buildImageLayersConfig() {
  return imageLayers.map((layer, index) => {
    const source = buildLayerValue(layer.source, `${layer.name} source`, 'url');
    const rect = [
      buildLayerValue(layer.x, `${layer.name} X`, 'number'),
      buildLayerValue(layer.y, `${layer.name} Y`, 'number'),
      buildLayerValue(layer.w, `${layer.name} width`, 'number', 1, 2048),
      buildLayerValue(layer.h, `${layer.name} height`, 'number', 1, 2048),
    ];

    let crop;
    if (layer.cropEnabled) {
      crop = [
        buildLayerValue(layer.cropX, `${layer.name} crop X`, 'number', 0, 2048),
        buildLayerValue(layer.cropY, `${layer.name} crop Y`, 'number', 0, 2048),
        buildLayerValue(layer.cropW, `${layer.name} crop width`, 'number', 1, 2048),
        buildLayerValue(layer.cropH, `${layer.name} crop height`, 'number', 1, 2048),
      ];
      const fallbackCrop = crop.map(configFallback);
      if (!validCropRect(fallbackCrop, configFallback(rect[2]), configFallback(rect[3]))) {
        throw new Error(`${layer.name} crop fallback must stay inside its width/height.`);
      }
    }

    return {
      name: index === 0 ? 'Background' : layer.name,
      source,
      rect,
      ...(crop ? { crop } : {}),
      fit: index === 0 ? 'cover' : 'fill',
    };
  });
}

function resolveConfigValue(value, kind, min = -2048, max = 2048) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !('live' in value)) return value;
  const raw = loadedLiveValues[value.live];
  if (kind === 'url') return typeof raw === 'string' ? raw : value.fallback;
  const candidate = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw) : Number.NaN;
  return Number.isInteger(candidate) && candidate >= min && candidate <= max ? candidate : value.fallback;
}

function resolveImageLayerConfig(layer, sourceOverride = '') {
  let source = sourceOverride || String(resolveConfigValue(layer.source, 'url') || '').trim();
  if ((!source || !/^https:\/\//i.test(source)) && layer.source && typeof layer.source === 'object' && 'live' in layer.source) {
    source = String(layer.source.fallback || '').trim();
  }
  if (!source || !/^https:\/\//i.test(source)) return null;
  const rect = [
    resolveConfigValue(layer.rect[0], 'number', -2048, 2048),
    resolveConfigValue(layer.rect[1], 'number', -2048, 2048),
    resolveConfigValue(layer.rect[2], 'number', 1, 2048),
    resolveConfigValue(layer.rect[3], 'number', 1, 2048),
  ];
  const [x, y, w, h] = rect;
  let crop;
  if (layer.crop) {
    crop = [
      resolveConfigValue(layer.crop[0], 'number', 0, 2048),
      resolveConfigValue(layer.crop[1], 'number', 0, 2048),
      resolveConfigValue(layer.crop[2], 'number', 1, 2048),
      resolveConfigValue(layer.crop[3], 'number', 1, 2048),
    ];
    if (!validCropRect(crop, w, h)) return null;
  }
  return { source, rect, crop, fit: layer.fit === 'cover' ? 'cover' : 'fill' };
}

function validateDaysPattern(text) {
  const count = (text.match(/\{days\}/g) || []).length;
  if (count > 1) throw new Error('Each corner may contain {days} at most once.');
  return count === 1;
}

function livePlaceholderKeys(text) {
  return [...text.matchAll(PLACEHOLDER_RE)].map((match) => match[1]).filter((key) => key !== 'days');
}

function previewDynamicText(text, days) {
  return text.replace(PLACEHOLDER_RE, (_match, key) => {
    if (key === 'days') return String(days);
    return Object.prototype.hasOwnProperty.call(loadedLiveValues, key)
      ? String(loadedLiveValues[key])
      : key;
  }).normalize('NFC');
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

function buildRuntimeGlyphAtlas(pattern) {
  const literal = pattern.replace(PLACEHOLDER_RE, '');
  const chars = new Set([...literal, ...RUNTIME_ASCII]);
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

function drawImageCoverRect(ctx, image, x, y, w, h) {
  const scale = Math.max(w / image.naturalWidth, h / image.naturalHeight);
  const dw = image.naturalWidth * scale;
  const dh = image.naturalHeight * scale;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.drawImage(image, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  ctx.restore();
}

function previewImageFor(src) {
  if (!src) return null;
  const cached = previewImageCache.get(src);
  if (cached?.status === 'loaded') return cached.image;
  if (cached) return null;

  const entry = { status: 'loading', image: null };
  previewImageCache.set(src, entry);
  const image = new Image();
  image.onload = () => {
    entry.status = 'loaded';
    entry.image = image;
    renderPreview();
  };
  image.onerror = () => {
    entry.status = 'error';
    renderPreview();
  };
  image.src = src;
  return null;
}

function drawImageLayer(ctx, image, layer) {
  const [x, y, w, h] = layer.rect;
  if (layer.fit === 'cover' && !layer.crop) {
    drawImageCoverRect(ctx, image, x, y, w, h);
    return;
  }
  if (!layer.crop) {
    ctx.drawImage(image, x, y, w, h);
    return;
  }

  const [cropX, cropY, cropW, cropH] = layer.crop;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, cropW, cropH);
  ctx.clip();
  ctx.drawImage(image, x - cropX, y - cropY, w, h);
  ctx.restore();
}

function optimizedBackgroundBlob() {
  return new Promise((resolve, reject) => {
    const img = localBackgroundImage;
    if (!img) return reject(new Error('Choose a local image first.'));
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    drawImageCoverRect(ctx, img, 0, 0, W, H);
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('WebP export failed.')), 'image/webp', 0.86);
  });
}

function buildCorner(name, days, tracking) {
  const input = cornerInputs[name];
  const layout = CORNER_LAYOUT[name];
  const text = input.text.value;
  const color = input.color.value;
  const hasDays = validateDaysPattern(text);
  const liveKeys = livePlaceholderKeys(text);

  if (liveKeys.length > 0) {
    const glyphs = buildRuntimeGlyphAtlas(text);
    const currentText = previewDynamicText(text, days);
    const previewGlyphs = buildGlyphAtlasFromText(currentText);
    const preview = layoutGlyphText(currentText, previewGlyphs, layout.anchor, layout.baseline, color, tracking, layout.align);
    return {
      width: preview.width,
      layers: preview.layers,
      config: {
        text, color, align: layout.align, anchor: layout.anchor, baseline: layout.baseline,
        tracking, mode: 'dynamic', glyphs,
      },
    };
  }

  if (hasDays) {
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
    const layerConfigs = buildImageLayersConfig();
    const resolvedLayers = layerConfigs.map((layer) => resolveImageLayerConfig(layer));
    if (generation !== renderGeneration) return;

    const ctx = els.preview.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, W, H);
    drawFallbackBackground(ctx);

    const remoteBackground = resolvedLayers[0];
    const background = localBackgroundImage
      ? resolveImageLayerConfig(layerConfigs[0], 'https://local-preview.invalid/image')
      : remoteBackground;
    const backgroundImage = localBackgroundImage || (remoteBackground ? previewImageFor(remoteBackground.source) : null);
    if (background && backgroundImage) drawImageLayer(ctx, backgroundImage, background);

    for (let index = 1; index < resolvedLayers.length; index++) {
      const layer = resolvedLayers[index];
      if (!layer) continue;
      const image = previewImageFor(layer.source);
      if (image) drawImageLayer(ctx, image, layer);
    }

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

    layerConfigs.forEach((layer, index) => {
      const label = index === 0 ? 'Background' : layer.name;
      const source = String(resolveConfigValue(layer.source, 'url') || '').trim();
      if (layer.source && typeof layer.source === 'object' && 'live' in layer.source && !loadedLiveValues[layer.source.live] && !layer.source.fallback) {
        warnings.push(`${label}: no live image value for ${layer.source.live}. Load this Widget ID after live data has been pushed.`);
      } else if (source && !/^https:\/\//i.test(source)) {
        warnings.push(`${label}: resolved image source must use HTTPS.`);
      } else if (source && !resolvedLayers[index]) {
        warnings.push(`${label}: live position/crop values are invalid or outside the configured image size.`);
      } else if (source && !(index === 0 && localBackgroundImage) && previewImageCache.get(source)?.status === 'error') {
        warnings.push(`${label}: image could not be previewed. The Worker may still be able to fetch it.`);
      }
    });
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
  const config = {
    v: 4,
    size: [W, H],
    endedAt: baked.iso,
    layers: buildImageLayersConfig(),
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

function legacyLayerValue(value, fallback) {
  if (Number.isInteger(value)) return value;
  const match = typeof value === 'string' ? value.match(LEGACY_LIVE_NUMBER_RE) : null;
  return match ? { live: match[1], fallback } : fallback;
}

function normalizeBuilderConfig(raw) {
  if (raw.v === 4) return raw;
  if (raw.v !== 3) throw new Error('This widget was made with an incompatible Builder version.');

  const layers = [{
    name: 'Background',
    source: raw.backgroundUrl || '',
    rect: [0, 0, W, H],
    fit: 'cover',
  }];
  if (raw.liveImage) {
    const [sourceW, sourceH] = raw.liveImage.sourceSize;
    const [x, y] = raw.liveImage.position;
    const fallbacks = [0, 0, sourceW || 1, sourceH || 1];
    layers.push({
      name: 'Layer 1',
      source: { live: raw.liveImage.key, fallback: '' },
      rect: [x, y, sourceW, sourceH],
      crop: raw.liveImage.crop.map((value, index) => legacyLayerValue(value, fallbacks[index])),
      fit: 'fill',
    });
  }
  return { ...raw, v: 4, layers };
}

function stateFromConfigValue(value, fallback) {
  if (value && typeof value === 'object' && !Array.isArray(value) && 'live' in value) {
    const base = value.fallback ?? fallback;
    return { mode: 'live', fixed: String(base), field: String(value.live || ''), fallback: String(base) };
  }
  return layerValueState(value ?? fallback);
}

function stateFromImageLayer(layer, index) {
  const rect = Array.isArray(layer.rect) && layer.rect.length === 4 ? layer.rect : [0, 0, index === 0 ? W : 40, index === 0 ? H : 40];
  const crop = Array.isArray(layer.crop) && layer.crop.length === 4 ? layer.crop : [0, 0, configFallback(rect[2]), configFallback(rect[3])];
  return {
    name: index === 0 ? 'Background' : (layer.name || `Layer ${index}`),
    fit: index === 0 ? 'cover' : 'fill',
    source: stateFromConfigValue(layer.source, ''),
    x: stateFromConfigValue(rect[0], 0),
    y: stateFromConfigValue(rect[1], 0),
    w: stateFromConfigValue(rect[2], index === 0 ? W : 40),
    h: stateFromConfigValue(rect[3], index === 0 ? H : 40),
    cropEnabled: Boolean(layer.crop),
    cropX: stateFromConfigValue(crop[0], 0),
    cropY: stateFromConfigValue(crop[1], 0),
    cropW: stateFromConfigValue(crop[2], index === 0 ? W : 40),
    cropH: stateFromConfigValue(crop[3], index === 0 ? H : 40),
  };
}

function applyConfig(encoded) {
  const config = normalizeBuilderConfig(JSON.parse(base64UrlToUtf8(encoded)));

  const match = String(config.endedAt).match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}):\d{2}([+-]\d{2}:\d{2})$/);
  if (match) {
    els.endedAt.value = match[1];
    els.timezone.value = match[2];
  }
  imageLayers = (Array.isArray(config.layers) && config.layers.length ? config.layers : [{ name: 'Background', source: '', rect: [0, 0, W, H], fit: 'cover' }])
    .slice(0, MAX_IMAGE_LAYERS)
    .map(stateFromImageLayer);
  renderImageLayerControls();
  previewImageCache.clear();
  if (localBackgroundUrl) URL.revokeObjectURL(localBackgroundUrl);
  localBackgroundUrl = null;
  localBackgroundImage = null;
  els.bgFile.value = '';
  els.downloadBg.disabled = true;
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
    loadedLiveValues = result.live && typeof result.live === 'object' && !Array.isArray(result.live) ? result.live : {};
    updateLiveFieldSuggestions();
    applyConfig(result.config);
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

function handleImageLayerValue(event) {
  const target = event.target;
  const article = target.closest?.('.image-layer');
  if (!article) return;
  const index = Number(article.dataset.layerIndex);
  const layer = imageLayers[index];
  if (!layer) return;

  if (target.dataset.role === 'crop-enabled') {
    layer.cropEnabled = target.checked;
    const cropFields = article.querySelector('[data-role="crop-fields"]');
    if (cropFields) cropFields.hidden = !layer.cropEnabled;
    invalidateAndRender();
    return;
  }

  const editor = target.closest('.layer-value-editor');
  if (!editor) return;
  const state = stateForProperty(layer, editor.dataset.property);
  const role = target.dataset.role;
  if (!state || !role) return;

  if (role === 'mode') {
    state.mode = target.value === 'live' ? 'live' : 'fixed';
    if (state.mode === 'live' && !state.fallback) state.fallback = state.fixed;
    if (state.mode === 'fixed' && !state.fixed && state.fallback) state.fixed = state.fallback;
    syncValueEditor(editor, state);
  } else if (role === 'fixed' || role === 'field' || role === 'fallback') {
    state[role] = target.value;
  }
  invalidateAndRender();
}

els.imageLayers.addEventListener('input', handleImageLayerValue);
els.imageLayers.addEventListener('change', handleImageLayerValue);
els.imageLayers.addEventListener('click', (event) => {
  const button = event.target.closest?.('button[data-action]');
  if (!button) return;
  const article = button.closest('.image-layer');
  const index = Number(article?.dataset.layerIndex);
  if (!Number.isInteger(index) || index <= 0 || index >= imageLayers.length) return;

  if (button.dataset.action === 'remove') imageLayers.splice(index, 1);
  if (button.dataset.action === 'up' && index < imageLayers.length - 1) [imageLayers[index], imageLayers[index + 1]] = [imageLayers[index + 1], imageLayers[index]];
  if (button.dataset.action === 'down' && index > 1) [imageLayers[index], imageLayers[index - 1]] = [imageLayers[index - 1], imageLayers[index]];
  renderImageLayerControls();
  invalidateAndRender();
});

els.addImageLayer.addEventListener('click', () => {
  if (imageLayers.length >= MAX_IMAGE_LAYERS) return;
  imageLayers.push(createImageLayer(imageLayers.length));
  renderImageLayerControls();
  invalidateAndRender();
});

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
  renderImageLayerControls();
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
