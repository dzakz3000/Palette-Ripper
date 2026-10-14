/*!
 * Palette Ripper — script.js
 * Browser-only image color extraction, exact pixel picking and live palette preview.
 *
 * Sections
 *   1. Config & constants        6. Image loading
 *   2. DOM references & state    7. Interactive picker (coordinate mapping)
 *   3. Small helpers             8. Palette management
 *   4. Color math                9. Role assignment & live preview
 *   5. Palette extraction       10. Export, theme, events, init
 */
(() => {
  'use strict';

  /* ==========================================================================
     1. Config & constants
     ========================================================================== */

  const CONFIG = Object.freeze({
    maxFileBytes: 25 * 1024 * 1024,   // refuse files above 25 MB
    maxCanvasSide: 4096,              // longest side of the full-resolution working canvas
    sampleSide: 256,                  // longest side of the downsampled copy used for quantization
    alphaThreshold: 125,              // pixels more transparent than this are ignored when extracting
    defaultColors: 6,
    storageKey: 'palette-ripper-theme',
    acceptedTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp', 'image/avif'],
    acceptedExtensions: ['png', 'jpg', 'jpeg', 'jfif', 'webp', 'gif', 'bmp', 'avif'],
  });

  const ROLES = Object.freeze([
    { id: 'background', label: 'Background' },
    { id: 'surface', label: 'Surface' },
    { id: 'primary', label: 'Primary' },
    { id: 'secondary', label: 'Secondary' },
    { id: 'accent', label: 'Accent' },
    { id: 'text', label: 'Text' },
  ]);

  const ICON_PATHS = Object.freeze({
    check: 'M5 12.5l4.5 4.5L19 7.5',
    left: 'M15 6l-6 6 6 6',
    right: 'M9 6l6 6-6 6',
    close: 'M6 6l12 12M18 6L6 18',
  });

  /** An error whose message is safe and helpful to show to the person. */
  class AppError extends Error {}

  /* ==========================================================================
     2. DOM references & state
     ========================================================================== */

  const byId = (id) => document.getElementById(id);

  const els = {
    themeToggle: byId('themeToggle'),
    viewer: byId('viewer'),
    dropzone: byId('dropzone'),
    fileInput: byId('fileInput'),
    stage: byId('stage'),
    canvas: byId('imageCanvas'),
    marker: byId('marker'),
    processing: byId('processing'),
    processingText: byId('processingText'),
    errorBanner: byId('errorBanner'),
    errorText: byId('errorText'),
    errorDismiss: byId('errorDismiss'),
    replaceBtn: byId('replaceBtn'),
    removeBtn: byId('removeBtn'),
    viewerMeta: byId('viewerMeta'),
    metaFile: byId('metaFile'),
    metaDims: byId('metaDims'),
    hoverChip: byId('hoverChip'),
    hoverDot: byId('hoverDot'),
    hoverHex: byId('hoverHex'),

    sampleEmpty: byId('sampleEmpty'),
    sampleEmptyText: byId('sampleEmptyText'),
    sampleBody: byId('sampleBody'),
    sampleSwatch: byId('sampleSwatch'),
    sampleHex: byId('sampleHex'),
    sampleRgb: byId('sampleRgb'),
    sampleHsl: byId('sampleHsl'),
    copySampleHex: byId('copySampleHex'),
    copySampleRgb: byId('copySampleRgb'),
    copySampleHsl: byId('copySampleHsl'),
    sampleMeta: byId('sampleMeta'),
    sampleNotice: byId('sampleNotice'),
    addSampleBtn: byId('addSampleBtn'),

    colorCount: byId('colorCount'),
    colorCountOutput: byId('colorCountOutput'),
    exportTxt: byId('exportTxt'),
    exportJson: byId('exportJson'),
    exportCss: byId('exportCss'),
    resetPaletteBtn: byId('resetPaletteBtn'),
    paletteStatus: byId('paletteStatus'),
    paletteStrip: byId('paletteStrip'),
    paletteEmpty: byId('paletteEmpty'),
    paletteEmptyText: byId('paletteEmptyText'),
    paletteList: byId('paletteList'),

    previewEmpty: byId('previewEmpty'),
    previewWorkspace: byId('previewWorkspace'),
    previewPicker: byId('previewPicker'),
    selectedLabel: byId('selectedLabel'),
    roleButtons: byId('roleButtons'),
    autoAssignBtn: byId('autoAssignBtn'),
    contrastList: byId('contrastList'),
    previewTabs: byId('previewTabs'),
    previewStage: byId('previewStage'),
    cardsGrid: byId('cardsGrid'),
    cardsStrip: byId('cardsStrip'),

    toast: byId('toast'),
    liveRegion: byId('liveRegion'),
  };

  const tabs = Array.from(els.previewTabs.querySelectorAll('[role="tab"]'));
  const views = Array.from(els.previewStage.querySelectorAll('[data-view]'));
  const roleButtons = Array.from(els.roleButtons.querySelectorAll('.role-btn'));

  // The only drawing context we need. willReadFrequently keeps getImageData fast.
  const ctx = els.canvas.getContext('2d', { willReadFrequently: true });

  const state = {
    // image
    imageLoaded: false,
    fileName: '',
    fileBase: '',
    fileSize: 0,
    naturalW: 0,
    naturalH: 0,
    scaled: false,
    histogram: null,
    loadToken: 0,

    // palette
    palette: [],          // { id, hex, rgb:[r,g,b], source:'extracted'|'sampled', proportion:number|null }
    nextId: 1,
    selectedId: null,
    colorCount: CONFIG.defaultColors,
    shortfall: false,     // true when fewer distinct colors exist than were requested

    // roles: { [roleId]: { hex, fromPalette } }
    roles: {},
    rolesTouched: false,  // becomes true once the person assigns a role manually

    // picker
    sample: null,         // { x, y, rgb, alpha }
    dragging: false,

    // preview
    previewMode: 'website',

    // timers
    countTimer: 0,
    toastTimer: 0,
    copyTimers: new WeakMap(),
  };

  /* ==========================================================================
     3. Small helpers
     ========================================================================== */

  const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
  const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));

  /** Tiny element factory: h('button', { class: 'x', text: 'Hi' }, [children]) */
  function h(tag, props = {}, children = []) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value == null || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'text') el.textContent = value;
      else if (key === 'style') for (const [k, v] of Object.entries(value)) el.style.setProperty(k, v);
      else el.setAttribute(key, value === true ? '' : String(value));
    }
    for (const child of [].concat(children)) if (child != null) el.append(child);
    return el;
  }

  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', ICON_PATHS[name]);
    svg.append(path);
    return svg;
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function slugify(text) {
    return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  }

  /** Announce something to screen readers without showing it. */
  function announce(message) {
    els.liveRegion.textContent = '';
    setTimeout(() => { els.liveRegion.textContent = message; }, 30);
  }

  function showToast(message, { color = null, tone = 'default' } = {}) {
    clearTimeout(state.toastTimer);
    els.toast.replaceChildren();
    if (color) els.toast.append(h('i', { class: 'toast__dot', style: { background: color } }));
    els.toast.append(h('span', { text: message }));
    els.toast.dataset.tone = tone;
    els.toast.classList.add('is-visible');
    state.toastTimer = setTimeout(() => els.toast.classList.remove('is-visible'), 2200);
  }

  /* ==========================================================================
     4. Color math
     ========================================================================== */

  const toHex = ([r, g, b]) =>
    '#' + [r, g, b].map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('').toUpperCase();

  function hexToRgb(hex) {
    const n = parseInt(hex.replace('#', ''), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  const formatRgb = ([r, g, b]) => `rgb(${r}, ${g}, ${b})`;

  function rgbToHsl([r, g, b]) {
    const rn = r / 255, gn = g / 255, bn = b / 255;
    const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
    const d = max - min;
    const l = (max + min) / 2;
    let hue = 0, sat = 0;
    if (d !== 0) {
      sat = d / (1 - Math.abs(2 * l - 1));
      if (max === rn) hue = ((gn - bn) / d) % 6;
      else if (max === gn) hue = (bn - rn) / d + 2;
      else hue = (rn - gn) / d + 4;
      hue *= 60;
      if (hue < 0) hue += 360;
    }
    return [Math.round(hue), Math.round(sat * 100), Math.round(l * 100)];
  }

  const formatHsl = (rgb) => {
    const [h, s, l] = rgbToHsl(rgb);
    return `hsl(${h}, ${s}%, ${l}%)`;
  };

  const mixRgb = (a, b, t) => a.map((v, i) => v * (1 - t) + b[i] * t);

  /** WCAG relative luminance (0 = black, 1 = white). */
  function relativeLuminance([r, g, b]) {
    const f = (c) => {
      const v = c / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  }

  /** WCAG contrast ratio between two RGB colors (1–21). */
  function contrastRatio(a, b) {
    const la = relativeLuminance(a), lb = relativeLuminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }

  /** Whichever of near-black / white reads better on the given color. */
  function readableOn(rgb) {
    const dark = [17, 17, 17], light = [255, 255, 255];
    return contrastRatio(rgb, dark) >= contrastRatio(rgb, light) ? '#111111' : '#FFFFFF';
  }

  /** sRGB -> CIE L*a*b* (D65). Used because Euclidean distance in Lab tracks perceived difference. */
  function rgbToLab([r, g, b]) {
    const lin = (c) => {
      const v = c / 255;
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    const R = lin(r), G = lin(g), B = lin(b);
    const x = (R * 0.4124564 + G * 0.3575761 + B * 0.1804375) / 0.95047;
    const y = R * 0.2126729 + G * 0.7151522 + B * 0.072175;
    const z = (R * 0.0193339 + G * 0.119192 + B * 0.9503041) / 1.08883;
    const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    const fx = f(x), fy = f(y), fz = f(z);
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
  }

  const deltaE = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

  /* ==========================================================================
     5. Palette extraction (median cut)
     ========================================================================== */

  /**
   * Step 1 — Build a color histogram.
   * Each pixel is bucketed by its top 5 bits per channel (32 768 possible buckets),
   * but we keep the exact RGB sums so a bucket's representative color is its true mean.
   * Transparent pixels are skipped so they cannot pull the palette toward black.
   */
  function buildHistogram(imageData) {
    const { data } = imageData;
    const map = new Map();
    let total = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < CONFIG.alphaThreshold) continue;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      let bucket = map.get(key);
      if (!bucket) {
        bucket = { count: 0, sumR: 0, sumG: 0, sumB: 0 };
        map.set(key, bucket);
      }
      bucket.count++;
      bucket.sumR += r; bucket.sumG += g; bucket.sumB += b;
      total++;
    }
    const buckets = [];
    for (const b of map.values()) {
      buckets.push({ ...b, r: b.sumR / b.count, g: b.sumG / b.count, b: b.sumB / b.count });
    }
    return { buckets, total };
  }

  /**
   * Step 2 — Median cut.
   * Start with one box holding every bucket. Repeatedly take the box with the most "visual
   * spread" (widest channel range, weighted by the square root of its pixel count so a huge
   * flat area does not hog every split), sort its buckets along that channel and cut at the
   * population median. Each final box becomes one candidate color.
   */
  function medianCut(buckets, targetBoxes) {
    const makeBox = (items) => {
      let rMin = 255, rMax = 0, gMin = 255, gMax = 0, bMin = 255, bMax = 0, count = 0;
      for (const p of items) {
        if (p.r < rMin) rMin = p.r; if (p.r > rMax) rMax = p.r;
        if (p.g < gMin) gMin = p.g; if (p.g > gMax) gMax = p.g;
        if (p.b < bMin) bMin = p.b; if (p.b > bMax) bMax = p.b;
        count += p.count;
      }
      const ranges = [rMax - rMin, gMax - gMin, bMax - bMin];
      const range = Math.max(...ranges);
      return { items, count, range, axis: ranges.indexOf(range) };
    };

    const boxes = [makeBox(buckets)];
    while (boxes.length < targetBoxes) {
      let bestIndex = -1, bestScore = -1;
      boxes.forEach((box, i) => {
        if (box.items.length < 2) return;
        const score = box.range * Math.sqrt(box.count);
        if (score > bestScore) { bestScore = score; bestIndex = i; }
      });
      if (bestIndex === -1) break; // nothing left to split

      const box = boxes[bestIndex];
      const channel = ['r', 'g', 'b'][box.axis];
      box.items.sort((a, b) => a[channel] - b[channel]);

      const half = box.count / 2;
      let running = 0, splitAt = 1;
      for (let i = 0; i < box.items.length - 1; i++) {
        running += box.items[i].count;
        splitAt = i + 1;
        if (running >= half) break;
      }
      boxes.splice(bestIndex, 1, makeBox(box.items.slice(0, splitAt)), makeBox(box.items.slice(splitAt)));
    }
    return boxes;
  }

  /**
   * Step 3 — Choose distinct colors.
   * Median cut can return several near-identical shades. Two passes avoid that:
   *  1. Walk candidates by popularity and keep one only if it is clearly different
   *     (ΔE > MIN_DISTINCT) from everything already kept.
   *  2. If that leaves free slots (the image has fewer clearly different colors than
   *     requested), fill them farthest-first: repeatedly add the candidate that is most
   *     different from the current selection. This prefers a rare but distinct accent over
   *     yet another shade of a dominant color. Exact duplicates are never added.
   */
  function pickDistinct(candidates, count) {
    const MIN_DISTINCT = 22;
    const nearest = (candidate, chosen) => Math.min(...chosen.map((c) => deltaE(c.lab, candidate.lab)));

    const chosen = [];
    for (const candidate of candidates) {
      if (chosen.length >= count) break;
      if (!chosen.length || nearest(candidate, chosen) > MIN_DISTINCT) chosen.push(candidate);
    }

    while (chosen.length < count) {
      let best = null, bestDistance = 0.5; // anything closer than this is effectively the same color
      for (const candidate of candidates) {
        if (chosen.includes(candidate)) continue;
        const d = nearest(candidate, chosen);
        if (d > bestDistance) { bestDistance = d; best = candidate; }
      }
      if (!best) break;
      chosen.push(best);
    }
    return chosen;
  }

  /** Full pipeline: histogram -> median cut -> distinct selection -> proportions. */
  function extractPalette(histogram, count) {
    const { buckets, total } = histogram;
    const candidateCount = Math.min(buckets.length, count * 4);
    const boxes = medianCut(buckets.slice(), candidateCount);

    const candidates = boxes.map((box) => {
      let r = 0, g = 0, b = 0;
      for (const p of box.items) { r += p.sumR; g += p.sumG; b += p.sumB; }
      const rgb = [Math.round(r / box.count), Math.round(g / box.count), Math.round(b / box.count)];
      return { rgb, lab: rgbToLab(rgb), count: box.count };
    }).sort((a, b) => b.count - a.count);

    const chosen = pickDistinct(candidates, count);

    // Give every candidate's pixels to its nearest chosen color so proportions add up to 100 %.
    const weights = new Array(chosen.length).fill(0);
    for (const candidate of candidates) {
      let best = 0, bestDistance = Infinity;
      chosen.forEach((c, i) => {
        const d = deltaE(c.lab, candidate.lab);
        if (d < bestDistance) { bestDistance = d; best = i; }
      });
      weights[best] += candidate.count;
    }

    return chosen
      .map((c, i) => ({ rgb: c.rgb, hex: toHex(c.rgb), proportion: weights[i] / total }))
      .sort((a, b) => b.proportion - a.proportion);
  }

  /* ==========================================================================
     6. Image loading
     ========================================================================== */

  function validateFile(file) {
    if (!file) return 'No file was received.';
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    if (file.type === 'image/svg+xml' || ext === 'svg') {
      return 'SVG files can’t be sampled pixel by pixel. Export it as a PNG first, then upload that.';
    }
    const typeOk = CONFIG.acceptedTypes.includes(file.type);
    const extOk = !file.type && CONFIG.acceptedExtensions.includes(ext);
    if (!typeOk && !extOk) {
      return `“${file.name}” isn’t a supported image. Use PNG, JPEG, WebP, GIF, BMP or AVIF.`;
    }
    if (file.size === 0) return 'That file is empty.';
    if (file.size > CONFIG.maxFileBytes) {
      return `That image is ${formatBytes(file.size)}. The limit is ${formatBytes(CONFIG.maxFileBytes)}.`;
    }
    return null;
  }

  function decodeImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new AppError('The browser couldn’t decode that image. It may be corrupted or in an unsupported format.'));
      img.src = url;
    });
  }

  const CANVAS_BLOCKED = 'Your browser wouldn’t let the page read this image’s pixels (privacy protection or low memory). Try a smaller image, or allow canvas access for this site.';

  /**
   * Draws the image onto an off-screen canvas at working resolution and builds the
   * histogram from a downsampled copy. Throws AppError if anything fails, so the
   * currently displayed image is only replaced once the new one is fully ready.
   */
  function prepareImage(img) {
    const naturalW = img.naturalWidth, naturalH = img.naturalHeight;
    if (!naturalW || !naturalH) throw new AppError('That image has no readable dimensions.');

    const scale = Math.min(1, CONFIG.maxCanvasSide / Math.max(naturalW, naturalH));
    const width = Math.max(1, Math.round(naturalW * scale));
    const height = Math.max(1, Math.round(naturalH * scale));

    let work;
    try {
      work = document.createElement('canvas');
      work.width = width;
      work.height = height;
      const wctx = work.getContext('2d', { willReadFrequently: true });
      if (!wctx) throw new Error('2D context unavailable');
      wctx.imageSmoothingQuality = 'high';
      wctx.drawImage(img, 0, 0, width, height);
      wctx.getImageData(0, 0, 1, 1); // throws if the canvas is tainted or blocked
    } catch (err) {
      console.error(err);
      throw new AppError(CANVAS_BLOCKED);
    }

    // Downsample large images so quantization stays fast; small images are used as-is.
    let histogram;
    try {
      const ratio = Math.min(1, CONFIG.sampleSide / Math.max(width, height));
      const sw = Math.max(1, Math.round(width * ratio));
      const sh = Math.max(1, Math.round(height * ratio));
      const small = document.createElement('canvas');
      small.width = sw;
      small.height = sh;
      const sctx = small.getContext('2d', { willReadFrequently: true });
      sctx.imageSmoothingQuality = 'high';
      sctx.drawImage(work, 0, 0, sw, sh);
      histogram = buildHistogram(sctx.getImageData(0, 0, sw, sh));
    } catch (err) {
      console.error(err);
      throw new AppError(CANVAS_BLOCKED);
    }
    if (!histogram.total) throw new AppError('That image has no visible pixels to analyze (it is fully transparent).');

    return { work, width, height, naturalW, naturalH, scaled: scale < 1, histogram };
  }

  async function loadFile(file) {
    const problem = validateFile(file);
    if (problem) { showError(problem); return; }
    clearError();

    const token = ++state.loadToken;
    setProcessing(true, 'Decoding image…');
    const url = URL.createObjectURL(file); // local blob URL; the file is only ever decoded as an image

    try {
      const img = await decodeImage(url);
      if (token !== state.loadToken) return;

      setProcessing(true, 'Reading pixels…');
      await nextFrame();
      const prepared = prepareImage(img);
      if (token !== state.loadToken) return;

      // Commit: put the new image on the visible canvas and reset image-specific state.
      els.canvas.width = prepared.width;
      els.canvas.height = prepared.height;
      ctx.clearRect(0, 0, prepared.width, prepared.height);
      ctx.drawImage(prepared.work, 0, 0);

      Object.assign(state, {
        imageLoaded: true,
        fileName: file.name,
        fileBase: slugify(file.name.replace(/\.[^.]+$/, '')) || 'palette-ripper',
        fileSize: file.size,
        naturalW: prepared.naturalW,
        naturalH: prepared.naturalH,
        scaled: prepared.scaled,
        histogram: prepared.histogram,
        sample: null,
        palette: [],
        selectedId: null,
        roles: {},
        rolesTouched: false,
      });

      showImageView();
      setProcessing(true, 'Extracting colors…');
      await nextFrame();
      applyExtraction({ animate: true });
      placeMarker();
      announce(`Image loaded. ${state.palette.length} colors extracted.`);
    } catch (err) {
      if (!(err instanceof AppError)) console.error(err);
      showError(err instanceof AppError ? err.message : 'Something went wrong while reading that image. Please try another file.');
    } finally {
      URL.revokeObjectURL(url);
      if (token === state.loadToken) setProcessing(false);
    }
  }

  function removeImage() {
    state.loadToken++;
    Object.assign(state, {
      imageLoaded: false, fileName: '', fileBase: '', fileSize: 0, histogram: null,
      sample: null, palette: [], selectedId: null, roles: {}, rolesTouched: false, shortfall: false,
    });
    els.canvas.width = 1;
    els.canvas.height = 1;
    els.fileInput.value = '';
    clearError();
    setProcessing(false);
    showEmptyView();
    refreshAll();
  }

  function setProcessing(on, text = '') {
    els.processing.hidden = !on;
    els.viewer.setAttribute('aria-busy', String(on));
    if (text) els.processingText.textContent = text;
  }

  function showError(message) {
    els.errorText.textContent = message;
    els.errorBanner.hidden = false;
  }

  function clearError() {
    els.errorBanner.hidden = true;
    els.errorText.textContent = '';
  }

  function showImageView() {
    els.dropzone.hidden = true;
    els.stage.hidden = false;
    els.viewerMeta.hidden = false;
    els.replaceBtn.hidden = false;
    els.removeBtn.hidden = false;
    els.metaFile.textContent = state.fileName;
    const dims = `${state.naturalW} × ${state.naturalH}px · ${formatBytes(state.fileSize)}`;
    els.metaDims.textContent = state.scaled ? `${dims} · working copy ${els.canvas.width} × ${els.canvas.height}px` : dims;
    els.marker.hidden = true;
    els.hoverChip.hidden = true;
  }

  function showEmptyView() {
    els.dropzone.hidden = false;
    els.stage.hidden = true;
    els.viewerMeta.hidden = true;
    els.replaceBtn.hidden = true;
    els.removeBtn.hidden = true;
    els.marker.hidden = true;
  }

  /* ==========================================================================
     7. Interactive picker (coordinate mapping)
     ========================================================================== */

  /**
   * Where, in viewport (client) coordinates, is the image actually painted inside `el`?
   * Accounts for borders, padding and `object-fit: contain` letterboxing, so the result is
   * correct however CSS scales or lays out the canvas.
   * (object-position is assumed to be the default 50% 50%.)
   */
  function getImageBox(el, imgW, imgH) {
    const rect = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const px = (v) => parseFloat(v) || 0;
    const left = rect.left + px(cs.borderLeftWidth) + px(cs.paddingLeft);
    const top = rect.top + px(cs.borderTopWidth) + px(cs.paddingTop);
    const width = rect.width - px(cs.borderLeftWidth) - px(cs.borderRightWidth) - px(cs.paddingLeft) - px(cs.paddingRight);
    const height = rect.height - px(cs.borderTopWidth) - px(cs.borderBottomWidth) - px(cs.paddingTop) - px(cs.paddingBottom);

    if (cs.objectFit === 'contain') {
      const scale = Math.min(width / imgW, height / imgH);
      const drawW = imgW * scale, drawH = imgH * scale;
      return { left: left + (width - drawW) / 2, top: top + (height - drawH) / 2, width: drawW, height: drawH };
    }
    return { left, top, width, height };
  }

  /** Viewport point -> pixel in the canvas bitmap. `inside` tells whether the point is on the image. */
  function clientToImagePixel(clientX, clientY) {
    const w = els.canvas.width, h = els.canvas.height;
    const box = getImageBox(els.canvas, w, h);
    const u = (clientX - box.left) / box.width;
    const v = (clientY - box.top) / box.height;
    return {
      inside: u >= 0 && u < 1 && v >= 0 && v < 1,
      x: clamp(Math.floor(u * w), 0, w - 1),
      y: clamp(Math.floor(v * h), 0, h - 1),
    };
  }

  /** Pixel in the canvas bitmap -> viewport point at the pixel's centre (inverse of the above). */
  function imagePixelToClient(px, py) {
    const w = els.canvas.width, h = els.canvas.height;
    const box = getImageBox(els.canvas, w, h);
    return { x: box.left + ((px + 0.5) / w) * box.width, y: box.top + ((py + 0.5) / h) * box.height };
  }

  function readPixel(x, y) {
    try {
      const d = ctx.getImageData(x, y, 1, 1).data;
      return { rgb: [d[0], d[1], d[2]], alpha: d[3] };
    } catch (err) {
      console.error(err);
      showError(CANVAS_BLOCKED);
      return null;
    }
  }

  function sampleAt(x, y) {
    if (!state.imageLoaded) return;
    const px = clamp(Math.round(x), 0, els.canvas.width - 1);
    const py = clamp(Math.round(y), 0, els.canvas.height - 1);
    const pixel = readPixel(px, py);
    if (!pixel) return;
    state.sample = { x: px, y: py, rgb: pixel.rgb, alpha: pixel.alpha };
    placeMarker();
    renderSample();
    announce(pixel.alpha === 0
      ? `Transparent pixel at ${px}, ${py}`
      : `Sampled ${toHex(pixel.rgb)} at ${px}, ${py}`);
  }

  function placeMarker() {
    if (!state.sample || !state.imageLoaded || els.stage.hidden) { els.marker.hidden = true; return; }
    const point = imagePixelToClient(state.sample.x, state.sample.y);
    const stageRect = els.stage.getBoundingClientRect();
    els.marker.style.left = `${point.x - stageRect.left - els.stage.clientLeft}px`;
    els.marker.style.top = `${point.y - stageRect.top - els.stage.clientTop}px`;
    els.marker.hidden = false;
  }

  let moveFrame = 0;
  let lastMove = null;

  function onPointerMove(e) {
    if (e.pointerType !== 'mouse') return;
    lastMove = { x: e.clientX, y: e.clientY };
    if (moveFrame) return;
    moveFrame = requestAnimationFrame(() => {
      moveFrame = 0;
      if (!lastMove || !state.imageLoaded) return;
      const p = clientToImagePixel(lastMove.x, lastMove.y);
      if (state.dragging) sampleAt(p.x, p.y);
      updateHover(p);
    });
  }

  function updateHover(p) {
    if (!p.inside) { els.hoverChip.hidden = true; return; }
    const pixel = readPixel(p.x, p.y);
    if (!pixel || pixel.alpha === 0) { els.hoverChip.hidden = true; return; }
    const hex = toHex(pixel.rgb);
    els.hoverDot.style.background = hex;
    els.hoverHex.textContent = `${hex} · ${p.x}, ${p.y}`;
    els.hoverChip.hidden = false;
  }

  function onCanvasKeydown(e) {
    if (!state.imageLoaded) return;
    const moves = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const w = els.canvas.width, h = els.canvas.height;
    if (moves[e.key]) {
      e.preventDefault();
      const big = Math.max(10, Math.round(Math.max(w, h) / 100));
      const step = e.shiftKey ? big : 1;
      const from = state.sample || { x: Math.floor(w / 2), y: Math.floor(h / 2) };
      const [dx, dy] = moves[e.key];
      sampleAt(from.x + dx * step, from.y + dy * step);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const from = state.sample || { x: Math.floor(w / 2), y: Math.floor(h / 2) };
      sampleAt(from.x, from.y);
    }
  }

  /* ==========================================================================
     8. Palette management
     ========================================================================== */

  const selectedEntry = () => state.palette.find((c) => c.id === state.selectedId) || null;
  const hasHex = (hex) => state.palette.some((c) => c.hex === hex);

  function applyExtraction({ animate = false } = {}) {
    if (!state.histogram) return;
    const requested = state.colorCount;
    const extracted = extractPalette(state.histogram, requested).map((c) => ({
      id: state.nextId++, hex: c.hex, rgb: c.rgb, source: 'extracted', proportion: c.proportion,
    }));

    // Colors the person sampled by hand survive re-extraction (unless extraction now found the same color).
    const sampled = state.palette.filter((c) => c.source === 'sampled' && !extracted.some((e) => e.hex === c.hex));
    const previousHex = selectedEntry()?.hex;

    state.palette = [...extracted, ...sampled];
    state.shortfall = extracted.length < requested;
    const keep = state.palette.find((c) => c.hex === previousHex);
    state.selectedId = (keep || state.palette[0] || {}).id ?? null;

    syncRoles(!state.rolesTouched);
    refreshAll({ animate });
  }

  function resetPalette() {
    if (!state.histogram) return;
    state.palette = [];
    state.rolesTouched = false;
    state.roles = {};
    applyExtraction({ animate: true });
    showToast('Palette reset to the extracted colors');
  }

  function selectColor(id) {
    state.selectedId = id;
    renderSelection();
  }

  function addSampleToPalette() {
    const s = state.sample;
    if (!s || s.alpha === 0) return;
    const hex = toHex(s.rgb);
    const existing = state.palette.find((c) => c.hex === hex);
    if (existing) {
      selectColor(existing.id);
      showToast(`${hex} is already in your palette`, { color: hex });
      return;
    }
    const entry = { id: state.nextId++, hex, rgb: s.rgb.slice(), source: 'sampled', proportion: null };
    state.palette.push(entry);
    state.selectedId = entry.id;
    syncRoles(false);
    refreshAll({ animate: false, freshId: entry.id });
    showToast(`Added ${hex} to your palette`, { color: hex });
    announce(`Added ${hex} to the palette`);
  }

  function removeColor(id) {
    const index = state.palette.findIndex((c) => c.id === id);
    if (index === -1) return;
    const [removed] = state.palette.splice(index, 1);
    if (state.selectedId === id) state.selectedId = (state.palette[index] || state.palette[index - 1] || {}).id ?? null;
    syncRoles(!state.rolesTouched);
    refreshAll();
    showToast(`Removed ${removed.hex}`, { color: removed.hex });
  }

  function moveColor(id, direction) {
    const index = state.palette.findIndex((c) => c.id === id);
    const target = index + direction;
    if (index === -1 || target < 0 || target >= state.palette.length) return;
    [state.palette[index], state.palette[target]] = [state.palette[target], state.palette[index]];
    refreshAll();
    // Keep keyboard focus on the same control after the list is rebuilt.
    const li = els.paletteList.querySelector(`[data-id="${id}"]`);
    const wanted = li && li.querySelector(`[data-action="${direction < 0 ? 'left' : 'right'}"]:not(:disabled)`);
    (wanted || (li && li.querySelector('[data-action="select"]')))?.focus();
  }

  /* ----- Copying ----- */

  function legacyCopy(text) {
    const previous = document.activeElement;
    const area = h('textarea', { 'aria-hidden': 'true', readonly: true, style: { position: 'fixed', top: '-1000px', opacity: '0' } });
    area.value = text;
    document.body.append(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
    area.remove();
    previous?.focus?.();
    return ok;
  }

  async function copyText(text, trigger, color = null) {
    let ok = false;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        ok = true;
      }
    } catch (err) {
      console.warn('Clipboard API failed, trying fallback', err);
    }
    if (!ok) ok = legacyCopy(text);

    if (ok) {
      flashCopied(trigger);
      showToast(`Copied ${text}`, { color });
    } else {
      showToast('Your browser blocked copying. Select the value and copy it manually.', { tone: 'error' });
    }
  }

  function flashCopied(el) {
    if (!el) return;
    clearTimeout(state.copyTimers.get(el));
    el.classList.add('is-copied');
    state.copyTimers.set(el, setTimeout(() => el.classList.remove('is-copied'), 1300));
  }

  /* ----- Rendering ----- */

  /** Re-render everything that depends on the palette. */
  function refreshAll({ animate = false, freshId = null } = {}) {
    renderPalette({ animate, freshId });
    renderPicker();
    renderSample();
    renderPreview();
    updateControls();
  }

  function updateControls() {
    const hasImage = state.imageLoaded;
    const hasColors = state.palette.length > 0;
    els.colorCount.disabled = !hasImage;
    els.resetPaletteBtn.disabled = !hasImage;
    [els.exportTxt, els.exportJson, els.exportCss].forEach((b) => { b.disabled = !hasColors; });
  }

  function createSwatch(entry, index, { animate, freshId }) {
    const ink = readableOn(entry.rgb);
    const isLast = index === state.palette.length - 1;
    const label = entry.proportion == null ? '' : (entry.proportion < 0.01 ? '<1%' : `${Math.round(entry.proportion * 100)}%`);

    const pick = h('button', {
      class: 'swatch__color', type: 'button', 'data-action': 'select',
      'aria-pressed': 'false', 'aria-label': `Select ${entry.hex}`,
      style: { '--swatch': entry.hex, '--swatch-ink': ink },
    }, [h('span', { text: label }), (() => { const c = icon('check'); c.classList.add('swatch__check'); return c; })()]);

    const copyBtn = (kind, value, cls) => h('button', {
      class: `copy-btn ${cls}`, type: 'button', 'data-action': 'copy', 'data-value': value, 'data-color': entry.hex,
      'aria-label': `Copy ${kind} ${value}`,
    }, [h('span', { class: 'copy-btn__text', text: value }), h('span', { class: 'copy-btn__done', 'aria-hidden': 'true', text: 'Copied' })]);

    const actionBtn = (action, name, iconName, extra = '') => h('button', {
      class: `icon-btn ${extra}`.trim(), type: 'button', 'data-action': action,
      'aria-label': `${name} ${entry.hex}`, title: name,
      disabled: (action === 'left' && index === 0) || (action === 'right' && isLast),
    }, [icon(iconName)]);

    return h('li', {
      class: `swatch${animate || freshId === entry.id ? ' is-new' : ''}`,
      'data-id': entry.id, style: { '--i': index },
    }, [
      pick,
      h('div', { class: 'swatch__body' }, [
        copyBtn('HEX', entry.hex, 'copy-btn--hex'),
        copyBtn('RGB', formatRgb(entry.rgb), 'copy-btn--rgb'),
        h('div', { class: 'swatch__meta' }, [
          h('span', { class: `tag tag--${entry.source}`, text: entry.source === 'extracted' ? 'Extracted' : 'Picked' }),
          h('span', { class: 'swatch__roles' }),
        ]),
        h('div', { class: 'swatch__actions' }, [
          actionBtn('left', 'Move earlier', 'left'),
          actionBtn('right', 'Move later', 'right'),
          actionBtn('remove', 'Remove', 'close', 'icon-btn--danger'),
        ]),
      ]),
    ]);
  }

  function renderPalette({ animate = false, freshId = null } = {}) {
    const has = state.palette.length > 0;
    els.paletteList.replaceChildren(...state.palette.map((entry, i) => createSwatch(entry, i, { animate, freshId })));
    els.paletteList.hidden = !has;
    els.paletteEmpty.hidden = has;
    els.paletteStrip.hidden = !has;
    els.paletteEmptyText.textContent = state.imageLoaded
      ? 'The palette is empty. Click the image to pick colors, or choose “Reset palette” to extract them again.'
      : 'Your palette will appear here once you upload an image.';

    els.paletteStrip.replaceChildren(...state.palette.map((c) => h('span', {
      title: c.hex, style: { background: c.hex, 'flex-grow': c.proportion ? Math.max(c.proportion * 100, 2) : 4 },
    })));

    const extractedCount = state.palette.filter((c) => c.source === 'extracted').length;
    const pickedCount = state.palette.length - extractedCount;
    let status = '';
    if (state.imageLoaded && has) {
      status = `${extractedCount} extracted` + (pickedCount ? ` · ${pickedCount} picked` : '') + ` · from ${state.fileName}`;
      if (state.shortfall) status += `. Only ${extractedCount} distinct colors exist in this image.`;
    }
    els.paletteStatus.textContent = status;

    renderRoleTags();
    renderSelection();
  }

  /** Cheap update: reflect which swatch is selected without rebuilding the list. */
  function renderSelection() {
    for (const li of els.paletteList.children) {
      const selected = Number(li.dataset.id) === state.selectedId;
      li.classList.toggle('is-selected', selected);
      li.querySelector('[data-action="select"]').setAttribute('aria-pressed', String(selected));
    }
    for (const chip of els.previewPicker.children) {
      chip.setAttribute('aria-pressed', String(Number(chip.dataset.id) === state.selectedId));
    }
    els.selectedLabel.textContent = selectedEntry()?.hex || '—';
  }

  function renderRoleTags() {
    const labelsByHex = new Map();
    for (const role of ROLES) {
      const value = state.roles[role.id];
      if (!value || !value.fromPalette) continue;
      if (!labelsByHex.has(value.hex)) labelsByHex.set(value.hex, []);
      labelsByHex.get(value.hex).push(role.label);
    }
    for (const li of els.paletteList.children) {
      const entry = state.palette.find((c) => c.id === Number(li.dataset.id));
      li.querySelector('.swatch__roles').textContent = (labelsByHex.get(entry?.hex) || []).join(' · ');
    }
  }

  function renderPicker() {
    els.previewPicker.replaceChildren(...state.palette.map((c) => h('button', {
      class: 'picker-chip', type: 'button', 'data-id': c.id, 'aria-pressed': 'false',
      'aria-label': `Choose ${c.hex}`, title: c.hex,
      style: { '--c': c.hex, '--c-ink': readableOn(c.rgb) },
    }, [icon('check')])));
    renderSelection();
  }

  /* ----- Picked-color panel ----- */

  function renderSample() {
    const s = state.sample;
    const show = state.imageLoaded && !!s;
    els.sampleBody.hidden = !show;
    els.sampleEmpty.hidden = show;
    els.sampleEmptyText.textContent = state.imageLoaded
      ? 'Click or tap anywhere on the image to sample the exact pixel under your pointer. Arrow keys work too.'
      : 'Upload an image to start picking colors.';
    if (!show) return;

    const transparent = s.alpha === 0;
    const hex = toHex(s.rgb);
    els.sampleSwatch.style.setProperty('--sample-color', transparent ? 'transparent' : `rgba(${s.rgb.join(',')}, ${s.alpha / 255})`);
    els.sampleHex.textContent = transparent ? '—' : hex;
    els.sampleRgb.textContent = transparent ? '—' : formatRgb(s.rgb);
    els.sampleHsl.textContent = transparent ? '—' : formatHsl(s.rgb);
    els.sampleMeta.textContent = `Pixel ${s.x}, ${s.y} of ${els.canvas.width} × ${els.canvas.height}`;

    if (transparent) {
      els.sampleNotice.textContent = 'This pixel is fully transparent, so it has no color. Pick a visible area.';
      els.sampleNotice.hidden = false;
    } else if (s.alpha < 255) {
      els.sampleNotice.textContent = `This pixel is ${Math.round((s.alpha / 255) * 100)}% opaque. The values show its own color, not how it blends with a background.`;
      els.sampleNotice.hidden = false;
    } else {
      els.sampleNotice.hidden = true;
    }

    [els.copySampleHex, els.copySampleRgb, els.copySampleHsl].forEach((b) => { b.disabled = transparent; });
    const duplicate = !transparent && hasHex(hex);
    els.addSampleBtn.disabled = transparent || duplicate;
    els.addSampleBtn.textContent = duplicate ? 'Already in palette' : 'Add to palette';
  }

  /* ==========================================================================
     9. Role assignment & live preview
     ========================================================================== */

  /**
   * Suggest a role for each palette color:
   *  - Background: the lightest color if the palette has a light tone, otherwise the darkest.
   *  - Text: the palette color with the best contrast against the background (a near-black or
   *    near-white fallback is used when none reaches 4.5:1).
   *  - Surface: the color closest to the background, or a subtle blend of background and text.
   *  - Primary / Secondary / Accent: the most saturated remaining colors, favouring ones that
   *    are visible against the background.
   */
  function computeAutoRoles(palette) {
    if (!palette.length) return {};
    const items = palette.map((c) => {
      const lab = rgbToLab(c.rgb);
      return { hex: c.hex, rgb: c.rgb, lab, lum: relativeLuminance(c.rgb), chroma: Math.hypot(lab[1], lab[2]) };
    });
    const byLum = [...items].sort((a, b) => a.lum - b.lum);
    const darkest = byLum[0], lightest = byLum[byLum.length - 1];
    const useLight = lightest.lum >= 0.4;
    const bg = useLight ? lightest : darkest;
    const fromPalette = (item) => ({ hex: item.hex, fromPalette: true });
    const derived = (rgb) => ({ hex: toHex(rgb), fromPalette: false });

    const rest = items.filter((i) => i !== bg);

    // Text
    const textCandidates = rest
      .map((i) => ({ item: i, ratio: contrastRatio(i.rgb, bg.rgb) }))
      .filter((c) => c.ratio >= 4.5)
      .sort((a, b) => (b.ratio - b.item.chroma / 20) - (a.ratio - a.item.chroma / 20));
    const textItem = textCandidates[0]?.item || null;
    const textValue = textItem ? fromPalette(textItem) : derived(useLight ? [22, 22, 22] : [245, 245, 245]);
    const textRgb = hexToRgb(textValue.hex);

    // Surface
    const afterText = rest.filter((i) => i !== textItem);
    const nearest = [...afterText].sort((a, b) => deltaE(a.lab, bg.lab) - deltaE(b.lab, bg.lab))[0];
    const nearestDistance = nearest ? deltaE(nearest.lab, bg.lab) : Infinity;
    const surfaceItem = nearest && nearestDistance >= 3 && nearestDistance <= 28 ? nearest : null;
    const surfaceValue = surfaceItem ? fromPalette(surfaceItem) : derived(mixRgb(bg.rgb, textRgb, 0.06));

    // Primary / Secondary / Accent
    const pool = afterText.filter((i) => i !== surfaceItem).sort((a, b) => b.chroma - a.chroma);
    const visible = pool.filter((i) => contrastRatio(i.rgb, bg.rgb) >= 3);
    const primary = visible[0] || pool[0] || surfaceItem || textItem || bg;
    const secondary = pool.find((i) => i !== primary) || null;
    const used = [primary, secondary].filter(Boolean);
    const accent = pool
      .filter((i) => !used.includes(i))
      .sort((a, b) => Math.min(...used.map((u) => deltaE(b.lab, u.lab))) - Math.min(...used.map((u) => deltaE(a.lab, u.lab))))[0] || null;

    return {
      background: fromPalette(bg),
      surface: surfaceValue,
      primary: fromPalette(primary),
      secondary: secondary ? fromPalette(secondary) : derived(mixRgb(primary.rgb, bg.rgb, 0.5)),
      accent: fromPalette(accent || primary),
      text: textValue,
    };
  }

  /** Keep `state.roles` valid after the palette changes. */
  function syncRoles(fullAuto) {
    if (!state.palette.length) { state.roles = {}; return; }
    const auto = computeAutoRoles(state.palette);
    if (fullAuto) { state.roles = auto; return; }
    for (const role of ROLES) {
      const current = state.roles[role.id];
      const valid = current && (!current.fromPalette || hasHex(current.hex));
      if (!valid) state.roles[role.id] = auto[role.id];
    }
  }

  function assignRole(roleId) {
    const entry = selectedEntry();
    if (!entry) { showToast('Choose a color first', { tone: 'error' }); return; }
    state.roles[roleId] = { hex: entry.hex, fromPalette: true };
    state.rolesTouched = true;
    renderRoleTags();
    renderPreview();
    const label = ROLES.find((r) => r.id === roleId).label;
    const button = roleButtons.find((b) => b.dataset.role === roleId);
    button.classList.remove('is-flash');
    void button.offsetWidth; // restart the animation
    button.classList.add('is-flash');
    showToast(`${label} → ${entry.hex}`, { color: entry.hex });
  }

  function autoAssign() {
    state.rolesTouched = false;
    syncRoles(true);
    renderRoleTags();
    renderPreview();
    showToast('Roles assigned automatically');
  }

  function rateContrast(ratio, kind) {
    if (kind === 'ui') return ratio >= 3 ? { label: 'Pass 3:1', tone: 'pass' } : { label: 'Low', tone: 'fail' };
    if (ratio >= 7) return { label: 'AAA', tone: 'pass' };
    if (ratio >= 4.5) return { label: 'AA', tone: 'pass' };
    if (ratio >= 3) return { label: 'Large text only', tone: 'warn' };
    return { label: 'Fails', tone: 'fail' };
  }

  function renderPreview() {
    const has = state.palette.length > 0 && ROLES.every((r) => state.roles[r.id]);
    els.previewEmpty.hidden = has;
    els.previewWorkspace.hidden = !has;
    if (!has) return;

    const rgb = {};
    ROLES.forEach((r) => { rgb[r.id] = hexToRgb(state.roles[r.id].hex); });
    const onPrimary = hexToRgb(readableOn(rgb.primary));

    // Apply the palette to the preview through CSS custom properties.
    const set = (name, value) => els.previewStage.style.setProperty(name, value);
    set('--pv-bg', toHex(rgb.background));
    set('--pv-surface', toHex(rgb.surface));
    set('--pv-primary', toHex(rgb.primary));
    set('--pv-secondary', toHex(rgb.secondary));
    set('--pv-accent', toHex(rgb.accent));
    set('--pv-text', toHex(rgb.text));
    set('--pv-on-primary', readableOn(rgb.primary));
    set('--pv-on-secondary', readableOn(rgb.secondary));
    set('--pv-on-accent', readableOn(rgb.accent));
    set('--pv-muted', toHex(mixRgb(rgb.text, rgb.surface, 0.28)));
    set('--pv-line', `rgba(${rgb.text.join(', ')}, 0.18)`);

    // Role buttons show the current assignment.
    for (const button of roleButtons) {
      const role = ROLES.find((r) => r.id === button.dataset.role);
      const hex = state.roles[role.id].hex;
      button.querySelector('.role-btn__chip').style.setProperty('--c', hex);
      button.querySelector('.role-btn__hex').textContent = hex;
      button.setAttribute('aria-label', `Assign selected color to ${role.label} (currently ${hex})`);
    }

    renderContrast(rgb, onPrimary);
    renderCards();
  }

  function renderContrast(rgb, onPrimary) {
    const checks = [
      { label: 'Text on background', fg: rgb.text, bg: rgb.background, kind: 'text' },
      { label: 'Text on surface', fg: rgb.text, bg: rgb.surface, kind: 'text' },
      { label: 'Button label on primary', fg: onPrimary, bg: rgb.primary, kind: 'text' },
      { label: 'Primary on background', fg: rgb.primary, bg: rgb.background, kind: 'ui' },
    ];
    els.contrastList.replaceChildren(...checks.map((c) => {
      const ratio = contrastRatio(c.fg, c.bg);
      const rating = rateContrast(ratio, c.kind);
      return h('li', { class: 'contrast__item' }, [
        h('span', { class: 'contrast__demo', text: 'Aa', 'aria-hidden': 'true', style: { '--fg-c': toHex(c.fg), '--bg-c': toHex(c.bg) } }),
        h('span', { class: 'contrast__label', text: c.label }),
        h('span', { class: 'contrast__ratio', text: `${ratio.toFixed(2)}:1` }),
        h('span', { class: `badge badge--${rating.tone}`, text: rating.label }),
      ]);
    }));
  }

  function renderCards() {
    els.cardsGrid.replaceChildren(...ROLES.map((role) => {
      const hex = state.roles[role.id].hex;
      const rgb = hexToRgb(hex);
      return h('article', { class: 'pv-swatchcard' }, [
        h('div', { class: 'pv-swatchcard__color', style: { '--c': hex, '--c-ink': readableOn(rgb) } }, [h('span', { text: role.label })]),
        h('div', { class: 'pv-swatchcard__info' }, [h('strong', { text: hex }), h('span', { text: formatRgb(rgb) })]),
      ]);
    }));
    els.cardsStrip.replaceChildren(...state.palette.map((c) => h('span', { style: { '--c': c.hex }, title: c.hex })));
  }

  function setPreviewMode(mode, { focus = false } = {}) {
    state.previewMode = mode;
    for (const tab of tabs) {
      const on = tab.dataset.mode === mode;
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
      if (on && focus) tab.focus();
    }
    for (const view of views) view.hidden = view.dataset.view !== mode;
  }

  /* ==========================================================================
     10. Export, theme, events, init
     ========================================================================== */

  function download(filename, content, mime) {
    const blob = new Blob([content], { type: `${mime};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const link = h('a', { href: url, download: filename, style: { display: 'none' } });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function roleSnapshot() {
    const out = {};
    for (const role of ROLES) if (state.roles[role.id]) out[role.id] = state.roles[role.id].hex;
    return out;
  }

  function exportPalette(kind) {
    if (!state.palette.length) { showToast('There is no palette to export yet', { tone: 'error' }); return; }
    const base = `${state.fileBase || 'palette-ripper'}-palette`;
    const source = state.fileName || 'manual selection';
    const stamp = new Date().toISOString();

    if (kind === 'txt') {
      download(`${base}.txt`, state.palette.map((c) => c.hex).join('\n') + '\n', 'text/plain');
    } else if (kind === 'json') {
      const data = {
        name: `${base}`,
        generator: 'Palette Ripper',
        source,
        createdAt: stamp,
        colors: state.palette.map((c) => {
          const [h, s, l] = rgbToHsl(c.rgb);
          return {
            hex: c.hex,
            rgb: { r: c.rgb[0], g: c.rgb[1], b: c.rgb[2] },
            hsl: { h, s, l },
            origin: c.source,
            proportion: c.proportion == null ? null : Number(c.proportion.toFixed(4)),
          };
        }),
        roles: roleSnapshot(),
      };
      download(`${base}.json`, JSON.stringify(data, null, 2) + '\n', 'application/json');
    } else if (kind === 'css') {
      const lines = [
        `/* Palette Ripper — ${state.palette.length} colors from ${source} */`,
        `/* Generated ${stamp.slice(0, 10)} */`,
        ':root {',
        ...state.palette.map((c, i) => `  --palette-${i + 1}: ${c.hex};`),
      ];
      const roles = roleSnapshot();
      if (Object.keys(roles).length) {
        lines.push('', '  /* Roles from the live preview */');
        for (const role of ROLES) if (roles[role.id]) lines.push(`  --color-${role.id}: ${roles[role.id]};`);
      }
      lines.push('}', '');
      download(`${base}.css`, lines.join('\n'), 'text/css');
    }
    showToast(`Downloaded ${base}.${kind}`);
  }

  /* ----- Theme ----- */

  function applyTheme(theme, persist) {
    document.documentElement.dataset.theme = theme;
    const dark = theme === 'dark';
    els.themeToggle.setAttribute('aria-pressed', String(dark));
    els.themeToggle.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
    if (persist) {
      try { localStorage.setItem(CONFIG.storageKey, theme); } catch (_) { /* storage may be unavailable */ }
    }
  }

  function initTheme() {
    let saved = null;
    try { saved = localStorage.getItem(CONFIG.storageKey); } catch (_) { /* ignore */ }
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    applyTheme(saved === 'dark' || saved === 'light' ? saved : (query.matches ? 'dark' : 'light'), false);
    query.addEventListener?.('change', (e) => {
      let stored = null;
      try { stored = localStorage.getItem(CONFIG.storageKey); } catch (_) { /* ignore */ }
      if (!stored) applyTheme(e.matches ? 'dark' : 'light', false);
    });
  }

  /* ----- Events ----- */

  const hasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');

  function firstImageFrom(fileList) {
    const files = Array.from(fileList || []);
    if (files.length > 1) showToast('Using the first file only');
    return files[0] || null;
  }

  function bindEvents() {
    // Upload: click, drag & drop, paste
    els.dropzone.addEventListener('click', () => els.fileInput.click());
    els.replaceBtn.addEventListener('click', () => els.fileInput.click());
    els.removeBtn.addEventListener('click', removeImage);
    els.fileInput.addEventListener('change', () => {
      const file = els.fileInput.files && els.fileInput.files[0];
      els.fileInput.value = ''; // allow choosing the same file again
      if (file) loadFile(file);
    });

    let dragDepth = 0;
    els.viewer.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth++;
      els.viewer.classList.add('is-dragover');
    });
    els.viewer.addEventListener('dragover', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    els.viewer.addEventListener('dragleave', (e) => {
      if (!hasFiles(e)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) els.viewer.classList.remove('is-dragover');
    });
    els.viewer.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth = 0;
      els.viewer.classList.remove('is-dragover');
      const file = firstImageFrom(e.dataTransfer.files);
      if (file) loadFile(file);
    });
    // Dropping a file outside the viewer must not make the browser navigate to it.
    window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
    window.addEventListener('drop', (e) => { if (hasFiles(e)) e.preventDefault(); });

    document.addEventListener('paste', (e) => {
      const item = Array.from(e.clipboardData?.items || []).find((i) => i.kind === 'file' && i.type.startsWith('image/'));
      const file = item && item.getAsFile();
      if (file) { e.preventDefault(); loadFile(file); }
    });

    els.errorDismiss.addEventListener('click', clearError);

    // Image picker
    els.canvas.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'mouse' || e.button !== 0) return;
      state.dragging = true;
      try { els.canvas.setPointerCapture(e.pointerId); } catch (_) { /* not critical */ }
      const p = clientToImagePixel(e.clientX, e.clientY);
      sampleAt(p.x, p.y);
    });
    const stopDrag = () => { state.dragging = false; };
    els.canvas.addEventListener('pointerup', stopDrag);
    els.canvas.addEventListener('pointercancel', stopDrag);
    els.canvas.addEventListener('pointermove', onPointerMove);
    els.canvas.addEventListener('pointerleave', () => { els.hoverChip.hidden = true; });
    // Touch and pen: sample on tap (a plain click, so scrolling the page still works).
    els.canvas.addEventListener('click', (e) => {
      if (e.pointerType === 'mouse') return; // already handled by pointerdown
      const p = clientToImagePixel(e.clientX, e.clientY);
      if (p.inside) sampleAt(p.x, p.y);
    });
    els.canvas.addEventListener('keydown', onCanvasKeydown);

    const repositionMarker = () => placeMarker();
    window.addEventListener('resize', repositionMarker);
    if ('ResizeObserver' in window) {
      const observer = new ResizeObserver(repositionMarker);
      observer.observe(els.stage);
      observer.observe(els.canvas);
    }

    // Picked color panel
    const sampleCopy = (button, format) => button.addEventListener('click', () => {
      const s = state.sample;
      if (!s || s.alpha === 0) return;
      copyText(format(s.rgb), button, toHex(s.rgb));
    });
    sampleCopy(els.copySampleHex, toHex);
    sampleCopy(els.copySampleRgb, formatRgb);
    sampleCopy(els.copySampleHsl, formatHsl);
    els.addSampleBtn.addEventListener('click', addSampleToPalette);

    // Palette controls
    els.colorCount.addEventListener('input', () => {
      const n = Number(els.colorCount.value);
      state.colorCount = n;
      els.colorCountOutput.textContent = String(n);
      els.colorCount.setAttribute('aria-valuetext', `${n} colors`);
      clearTimeout(state.countTimer);
      state.countTimer = setTimeout(() => applyExtraction(), 120);
    });
    els.resetPaletteBtn.addEventListener('click', resetPalette);
    els.exportTxt.addEventListener('click', () => exportPalette('txt'));
    els.exportJson.addEventListener('click', () => exportPalette('json'));
    els.exportCss.addEventListener('click', () => exportPalette('css'));

    // Palette swatches (event delegation)
    els.paletteList.addEventListener('click', (e) => {
      const control = e.target.closest('[data-action]');
      const li = e.target.closest('.swatch');
      if (!control || !li) return;
      const id = Number(li.dataset.id);
      switch (control.dataset.action) {
        case 'select': selectColor(id); break;
        case 'copy': copyText(control.dataset.value, control, control.dataset.color); break;
        case 'left': moveColor(id, -1); break;
        case 'right': moveColor(id, 1); break;
        case 'remove': removeColor(id); break;
        default: break;
      }
    });

    // Preview controls
    els.previewPicker.addEventListener('click', (e) => {
      const chip = e.target.closest('.picker-chip');
      if (chip) selectColor(Number(chip.dataset.id));
    });
    els.roleButtons.addEventListener('click', (e) => {
      const button = e.target.closest('.role-btn');
      if (button) assignRole(button.dataset.role);
    });
    els.autoAssignBtn.addEventListener('click', autoAssign);

    els.previewTabs.addEventListener('click', (e) => {
      const tab = e.target.closest('[role="tab"]');
      if (tab) setPreviewMode(tab.dataset.mode);
    });
    els.previewTabs.addEventListener('keydown', (e) => {
      const index = tabs.findIndex((t) => t.dataset.mode === state.previewMode);
      let next = null;
      if (e.key === 'ArrowRight') next = (index + 1) % tabs.length;
      else if (e.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = tabs.length - 1;
      if (next === null) return;
      e.preventDefault();
      setPreviewMode(tabs[next].dataset.mode, { focus: true });
    });

    // Theme
    els.themeToggle.addEventListener('click', () => {
      applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark', true);
    });
  }

  function init() {
    if (!ctx) {
      showError('This browser doesn’t support the Canvas API, which Palette Ripper needs to read image pixels.');
      els.dropzone.disabled = true;
      return;
    }
    initTheme();
    els.colorCount.value = String(CONFIG.defaultColors);
    els.colorCountOutput.textContent = String(CONFIG.defaultColors);
    els.colorCount.setAttribute('aria-valuetext', `${CONFIG.defaultColors} colors`);
    bindEvents();
    setPreviewMode('website');
    refreshAll();
  }

  init();
})();
