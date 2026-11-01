#!/usr/bin/env node
/**
 * Generates every icon / splash asset from the official Lumora mark
 * (assets/brand/lumora-mark.svg). The mark's geometry is reused verbatim; only
 * its colour and placement change per asset. Requires `rsvg-convert` (librsvg).
 *
 *   node scripts/brand-assets.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = path.join(ROOT, 'assets');
const SOURCE = path.join(ASSETS, 'brand', 'lumora-mark.svg');

export const BRAND = {
  background: '#060B16', // Lumora midnight navy (app background)
  mark: '#FFFFFF', // the source SVG's own dark-mode colour
};

/** Extracts the drawable elements (path / circle) from the source SVG. */
export function extractMark(svg) {
  const viewBox = (svg.match(/viewBox="([^"]+)"/) || [])[1];
  if (viewBox !== '0 0 100 100') throw new Error(`Unexpected viewBox: ${viewBox}`);
  const shapes = svg.match(/<(path|circle)\b[^>]*\/>/g);
  if (!shapes || !shapes.length) throw new Error('No shapes found in source SVG');
  return shapes;
}

/** Bounding box of the mark in viewBox units (stroke width 18, round caps; circle r=12). */
export const MARK_BOUNDS = { x: 13, y: 15, width: 75, height: 68 };

/**
 * Builds a square SVG of `size` px with the mark scaled so its bounding box
 * spans `fraction` of the canvas (by its longest side) and is optically centred.
 */
export function composeSvg(shapes, { size, fraction, color, background }) {
  const scale = (size * fraction) / Math.max(MARK_BOUNDS.width, MARK_BOUNDS.height);
  const cx = MARK_BOUNDS.x + MARK_BOUNDS.width / 2;
  const cy = MARK_BOUNDS.y + MARK_BOUNDS.height / 2;
  const tx = size / 2 - cx * scale;
  const ty = size / 2 - cy * scale;
  const colored = shapes.map((s) =>
    s.startsWith('<path') ? s.replace('<path', `<path stroke="${color}"`) : s.replace('<circle', `<circle fill="${color}"`),
  );
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`,
    background ? `<rect width="${size}" height="${size}" fill="${background}"/>` : '',
    `<g transform="translate(${tx.toFixed(3)} ${ty.toFixed(3)}) scale(${scale.toFixed(5)})">`,
    ...colored,
    '</g></svg>',
  ].join('');
}

/** Asset specs. Android adaptive safe zone: inner 66/108 dp circle. */
export const SPECS = [
  // iOS + universal icon: opaque, no alpha (App Store requirement).
  { file: 'icon.png', size: 1024, fraction: 0.56, color: BRAND.mark, background: BRAND.background, opaque: true },
  // Android adaptive foreground (background colour is set in app.json). Mark's
  // diagonal stays inside the 61% safe circle.
  { file: 'adaptive-icon.png', size: 1024, fraction: 0.42, color: BRAND.mark },
  // Android 13+ themed icon: single-colour silhouette.
  { file: 'monochrome-icon.png', size: 1024, fraction: 0.42, color: '#FFFFFF' },
  // Splash image (rendered at `imageWidth` on a #060B16 background).
  { file: 'splash-icon.png', size: 1024, fraction: 0.9, color: BRAND.mark },
  { file: 'favicon.png', size: 196, fraction: 0.62, color: BRAND.mark, background: BRAND.background, opaque: true },
  // In-app logo (header + assistant avatar), tight crop at 3x for a ~64pt max size.
  { file: 'brand/lumora-mark-white.png', size: 192, fraction: 0.98, color: '#FFFFFF' },
];

function render(svg, outFile, { opaque }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'lumora-brand-'));
  try {
    const svgFile = path.join(dir, 'in.svg');
    writeFileSync(svgFile, svg);
    execFileSync('rsvg-convert', ['--format=png', '-o', outFile, svgFile]);
    if (opaque) {
      // Drop the alpha channel entirely (Apple rejects icons with alpha).
      execFileSync('magick', [outFile, '-background', BRAND.background, '-alpha', 'remove', '-alpha', 'off', `PNG24:${outFile}`]);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const shapes = extractMark(readFileSync(SOURCE, 'utf8'));
  for (const spec of SPECS) {
    render(composeSvg(shapes, spec), path.join(ASSETS, spec.file), spec);
    console.log(`✓ assets/${spec.file} (${spec.size}px)`);
  }
}
