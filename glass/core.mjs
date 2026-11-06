/**
 * Pure geometry/material helpers shared by LiquidGlass and its tests.
 * No DOM or WebGL dependency; importing this module is safe in Node.js.
 */
const regular = Object.freeze({
  radius: 24,
  bevel: 20,
  refraction: 12,
  roughness: 0.65,
  tint: Object.freeze([1, 1, 1]),
  tintOpacity: 0.08,
  dispersion: 0.2,
  highlight: 0.4
});

export const PRESETS = Object.freeze({
  regular,
  clear: Object.freeze({
    ...regular,
    roughness: 0.18,
    refraction: 16,
    tintOpacity: 0.025,
    highlight: 0.48
  }),
  tinted: Object.freeze({
    ...regular,
    roughness: 0.72,
    refraction: 10,
    tint: Object.freeze([0.04, 0.52, 1]),
    tintOpacity: 0.18,
    highlight: 0.35
  })
});

const limits = Object.freeze({
  radius: [0, 256],
  bevel: [1, 128],
  refraction: [0, 40],
  roughness: [0, 1],
  tintOpacity: [0, 1],
  dispersion: [0, 2],
  highlight: [0, 1]
});

function finite(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function positive(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Accepts a preset name or a material object with an optional preset property.
 * Unknown presets use regular. Invalid fields use their preset defaults.
 * The result never aliases caller-owned arrays or the immutable presets.
 */
export function normalizeMaterial(input) {
  const options = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const name = typeof input === 'string' ? input : options.preset;
  const preset = typeof name === 'string' && Object.hasOwn(PRESETS, name) ? PRESETS[name] : PRESETS.regular;
  const result = {};
  for (const [key, [min, max]] of Object.entries(limits)) {
    result[key] = clamp(finite(options[key], preset[key]), min, max);
  }
  const tint = Array.isArray(options.tint) ? options.tint : preset.tint;
  result.tint = [0, 1, 2].map(index => clamp(finite(tint[index], preset.tint[index]), 0, 1));
  return result;
}

function dimension(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new RangeError(name + ' must be a finite positive number.');
  }
  return value;
}

/**
 * Centered drawImage source and destination rectangles.
 * cover fills the destination by cropping the source.
 * contain preserves the complete source and leaves centered letterbox space.
 */
export function fitCover(sourceWidth, sourceHeight, width, height, fit = 'cover') {
  dimension(sourceWidth, 'sourceWidth');
  dimension(sourceHeight, 'sourceHeight');
  dimension(width, 'width');
  dimension(height, 'height');
  if (fit !== 'cover' && fit !== 'contain') throw new TypeError('fit must be cover or contain.');
  const scaleX = width / sourceWidth;
  const scaleY = height / sourceHeight;
  if (fit === 'contain') {
    const scale = Math.min(scaleX, scaleY);
    const dw = sourceWidth * scale;
    const dh = sourceHeight * scale;
    return { sx: 0, sy: 0, sw: sourceWidth, sh: sourceHeight, dx: (width - dw) / 2, dy: (height - dh) / 2, dw, dh };
  }
  const scale = Math.max(scaleX, scaleY);
  const sw = Math.min(sourceWidth, width / scale);
  const sh = Math.min(sourceHeight, height / scale);
  return { sx: (sourceWidth - sw) / 2, sy: (sourceHeight - sh) / 2, sw, sh, dx: 0, dy: 0, dw: width, dh: height };
}

/**
 * Allocates at least one pixel per dimension, respecting both dimension and
 * area limits. Integer rounding may change aspect ratio by one pixel; for
 * extreme aspect ratios, minimum 1px dimensions take precedence.
 * scale is the smaller of the final x/y CSS-to-buffer scales.
 */
export function computeBufferSize(width, height, options = {}) {
  options = options && typeof options === 'object' ? options : {};
  const w = positive(width, 1);
  const h = positive(height, 1);
  const dpr = positive(options.dpr, 1);
  const maxDpr = positive(options.maxDpr, 1.5);
  const maxPixels = Math.max(1, Math.floor(positive(options.maxPixels, 2500000)));
  const maxSize = Math.max(1, Math.floor(positive(options.maxSize, 4096)));
  // Split square roots avoid overflowing w*h for very large finite inputs.
  const areaScale = Math.sqrt(maxPixels) / Math.sqrt(w) / Math.sqrt(h);
  const requestedScale = Math.min(dpr, maxDpr, areaScale, maxSize / w, maxSize / h);
  let bufferWidth = Math.max(1, Math.min(maxSize, Math.floor(w * requestedScale)));
  let bufferHeight = Math.max(1, Math.min(maxSize, Math.floor(h * requestedScale)));
  // A <1px dimension rounded up to 1 can exceed the area budget on extremely
  // wide/tall roots. Correct the long dimension without ever allocating zero.
  if (bufferWidth > maxPixels / bufferHeight) {
    if (bufferWidth >= bufferHeight) bufferWidth = Math.max(1, Math.floor(maxPixels / bufferHeight));
    else bufferHeight = Math.max(1, Math.floor(maxPixels / bufferWidth));
  }
  return { width: bufferWidth, height: bufferHeight, scale: Math.min(bufferWidth / w, bufferHeight / h) };
}

/**
 * Rounded rectangle signed distance in local CSS coordinates (top-left = 0,0).
 * Negative inside, zero on the boundary, positive outside.
 */
export function roundRectDistance(x, y, width, height, radius = 0) {
  dimension(width, 'width');
  dimension(height, 'height');
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new RangeError('Point coordinates must be finite.');
  const r = clamp(finite(radius, 0), 0, Math.min(width, height) / 2);
  const qx = Math.abs(x - width / 2) - width / 2 + r;
  const qy = Math.abs(y - height / 2) - height / 2 + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

