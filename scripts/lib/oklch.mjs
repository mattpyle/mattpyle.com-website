/**
 * Pure sRGB and WCAG contrast maths for oklch() design tokens.
 *
 * Kept dependency-free under scripts/lib/ so OG card and brand-asset scripts
 * can convert colours without importing Style Dictionary.
 */

/** Convert `oklch(L C H)` to linear sRGB channels [r, g, b] in [0, 1]. */
export function oklchToLinearRgb(lightness, chroma, hueDegrees) {
  const hue = (hueDegrees * Math.PI) / 180;
  const a = chroma * Math.cos(hue);
  const b = chroma * Math.sin(hue);

  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;

  return [
    Math.max(0, Math.min(1, 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s)),
    Math.max(0, Math.min(1, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s)),
    Math.max(0, Math.min(1, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)),
  ];
}

export function linearChannelToSrgb(channel) {
  const encoded = channel <= 0.0031308
    ? 12.92 * channel
    : 1.055 * channel ** (1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(encoded * 255)));
}

export function srgbChannelToLinear(byte) {
  const c = byte / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Convert `oklch(L C H)` to `#rrggbb`. */
export function oklchToHex(lightness, chroma, hueDegrees) {
  const linear = oklchToLinearRgb(lightness, chroma, hueDegrees);
  return `#${linear.map((c) => linearChannelToSrgb(c).toString(16).padStart(2, '0')).join('')}`;
}

/** Parse `#rrggbb` or `oklch(L C H)` (opaque) into `{ hex, luminance }` or `null` if translucent. */
export function parseOpaqueColor(cssValue) {
  if (typeof cssValue !== 'string') return null;
  const trimmed = cssValue.trim();

  const hexMatch = /^#([0-9a-f]{6})$/i.exec(trimmed);
  if (hexMatch) {
    const hex = `#${hexMatch[1].toLowerCase()}`;
    const r = srgbChannelToLinear(parseInt(hex.slice(1, 3), 16));
    const g = srgbChannelToLinear(parseInt(hex.slice(3, 5), 16));
    const b = srgbChannelToLinear(parseInt(hex.slice(5, 7), 16));
    return { hex, luminance: 0.2126 * r + 0.7152 * g + 0.0722 * b };
  }

  const oklchMatch = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/i.exec(trimmed);
  if (oklchMatch) {
    const l = Number(oklchMatch[1]);
    const c = Number(oklchMatch[2]);
    const h = Number(oklchMatch[3]);
    const hex = oklchToHex(l, c, h);
    const [r, g, b] = oklchToLinearRgb(l, c, h);
    return { hex, luminance: 0.2126 * r + 0.7152 * g + 0.0722 * b };
  }

  return null;
}

/** WCAG 2.1 contrast ratio between two opaque CSS colours (`#rrggbb` or `oklch(L C H)`). */
export function contrastRatio(colorA, colorB) {
  const a = parseOpaqueColor(colorA);
  const b = parseOpaqueColor(colorB);
  if (!a || !b) return null;
  const lighter = Math.max(a.luminance, b.luminance);
  const darker = Math.min(a.luminance, b.luminance);
  return Number(((lighter + 0.05) / (darker + 0.05)).toFixed(2));
}
