import Phaser from 'phaser';

/**
 * MatchmakingCanvasBake — ticket 30 "Iron War-Table Refined" local CanvasTexture
 * helpers (the one-off helper the ticket authorizes: "scope = MatchmakingUI.ts
 * (+ any one-off CanvasTexture helper, kept local)").
 *
 * Per doc 23 §2.2/§2.3 — the Canvas 2D API is the bridge that makes CSS-only
 * gradient techniques (radial-gradient face, background-clip:text gold title)
 * trivial in Phaser. Both bakes run ONCE into a `CanvasTexture` and reuse the
 * cached texture on scene restart (`scene.textures.exists` guard). Best-effort:
 * return false when Canvas2D is unavailable so MatchmakingUI falls back to the
 * pre-ticket-30 look (flat rectangle / cream Label) — no-black holds.
 */

/** Texture key for the baked iron face (technique §3.8). */
export const IRON_FACE_KEY = '__matchmaking_iron_face';
/** Texture key for the baked brushed-gold title (technique §3.2). */
export const TITLE_GOLD_KEY = '__matchmaking_title_gold';

/**
 * Technique §3.8 — Baked iron face (CanvasTexture).
 *
 * Radial warm-center → dark-edge gradient (the "forged metal" read) + a
 * scattered noise pass at α0.08 (kills the flat-gradient look the user flagged
 * "design very poor"). One draw call; scaled to the panel face via
 * `setDisplaySize` at the call site. Mirrors `MenuBackground.createCanvasVignette`
 * (`MenuBackground.ts:433`) for the createCanvas + getContext + refresh pattern
 * + the `if (!canvas) return false` Canvas2D-unavailable guard.
 */
export function bakeIronFace(scene: Phaser.Scene, key: string, w: number, h: number): boolean {
  if (scene.textures.exists(key)) return true;
  const canvas = scene.textures.createCanvas(key, w, h);
  if (!canvas) return false; // Canvas2D unavailable — degrade to flat backing plate.
  const ctx = canvas.getContext();
  // Warm-center (lifted toward the title) → dark-edge radial gradient.
  // Stops verbatim from doc 23 §4.1 / prototype `.opt1 .panel`.
  const grad = ctx.createRadialGradient(w / 2, h * 0.36, 0, w / 2, h * 0.5, Math.max(w, h) * 0.72);
  grad.addColorStop(0, '#423b34');
  grad.addColorStop(0.4, '#3a3530');
  grad.addColorStop(0.72, '#2c2722');
  grad.addColorStop(1, '#221e1a');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
  // 256px-equivalent noise scatter at α0.08 (doc 23 §2.6/§3.8 grain tile). α ≤
  // 0.12 per doc 23 §2.6 — subtle enough to read as forged texture, not dirt.
  for (let y = 0; y < h; y += 3) {
    for (let x = 0; x < w; x += 3) {
      const v = Math.floor(Math.random() * 255);
      ctx.fillStyle = `rgba(${v},${v},${v},0.08)`;
      ctx.fillRect(x, y, 3, 3);
    }
  }
  canvas.refresh();
  return true;
}

/**
 * Technique §3.2 — Brushed-gold title (CanvasTexture destination-in mask).
 *
 * Draws the §2.3 90deg gold gradient into the canvas, flips to
 * `globalCompositeOperation = 'destination-in'`, then paints the text — the
 * text becomes a mask clipping the gradient to glyph shapes (the Canvas 2D
 * equivalent of CSS `background-clip: text`). Bake ONCE for the fixed title
 * (NOT for dynamic text — doc 23 §2.3 path 1). Returns false when Canvas2D /
 * text measurement is unavailable so the caller keeps the cream Label visible.
 */
export function bakeGoldTitle(
  scene: Phaser.Scene,
  key: string,
  text: string,
  fontPx: number,
  fontFamily: string,
): boolean {
  if (scene.textures.exists(key)) return true;
  // Measure the text via a scratch canvas (canvas 2D measureText; avoids
  // creating a Phaser Text object just to measure).
  const scratch = scene.textures.createCanvas('__matchmaking_measure', 8, 8);
  if (!scratch) return false;
  const sctx = scratch.getContext();
  const fontDecl = `bold ${fontPx}px ${fontFamily}`;
  sctx.font = fontDecl;
  const metrics = sctx.measureText(text);
  scene.textures.remove('__matchmaking_measure');
  const textW = Math.ceil(metrics.width);
  if (textW <= 0) return false;
  const textH = Math.ceil(fontPx * 1.4);
  const pad = 8;
  const cw = textW + pad * 2;
  const ch = textH + pad * 2;
  const canvas = scene.textures.createCanvas(key, cw, ch);
  if (!canvas) return false;
  const ctx = canvas.getContext();
  // 1. Fill with the §2.3 90deg brushed-gold gradient (verbatim stops —
  //    sanctioned intermediate accent per ticket 30 palette note).
  const grad = ctx.createLinearGradient(0, 0, cw, 0);
  grad.addColorStop(0, '#b28530');
  grad.addColorStop(0.09, '#dcb251');
  grad.addColorStop(0.15, '#f0cd70');
  grad.addColorStop(0.21, '#fde28a');
  grad.addColorStop(0.31, '#f4ce6d');
  grad.addColorStop(0.43, '#e4b859');
  grad.addColorStop(0.55, '#d2a44a');
  grad.addColorStop(0.67, '#c4963e');
  grad.addColorStop(0.8, '#b98a34');
  grad.addColorStop(0.91, '#ad7d2b');
  grad.addColorStop(1, '#a67527');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, cw, ch);
  // 2. destination-in: keep only pixels covered by the next draw (the text) —
  //    this clips the gradient to glyph shapes (the background-clip:text bridge).
  ctx.globalCompositeOperation = 'destination-in';
  ctx.font = fontDecl;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ffffff';
  ctx.fillText(text, cw / 2, ch / 2);
  ctx.globalCompositeOperation = 'source-over';
  canvas.refresh();
  return true;
}

/** Texture key for the baked panel drop-shadow (technique §3.9). */
export const PANEL_SHADOW_KEY = '__matchmaking_panel_shadow';

/**
 * Technique §3.9 — Baked drop shadow for the War-Table panel (CanvasTexture).
 *
 * Canvas2D's native `shadowBlur` + `shadowOffsetY` render a real Gaussian-ish
 * halo — the same render path as CSS `box-shadow`. The filled rounded rect at
 * the center is OPAQUE and lands exactly under the opaque panel/backing plate,
 * so it is hidden; only the shadow it casts (drawn into the canvas margin by
 * shadowBlur) is visible as a soft halo extending uniformly past every edge.
 *
 * Why not the `light_01` radial puddle: that texture is a LIGHT glow — its
 * energy concentrates in the center, which the opaque panel covers entirely, so
 * only the near-zero-alpha tail escaped past the edges = invisible at any
 * alpha/size. shadowBlur puts dense shadow where the panel hides it + a strong
 * soft halo where it shows.
 *
 * Best-effort: returns false when Canvas2D is unavailable (caller omits the
 * shadow — the panel still reads fine, just flatter).
 */
export function bakePanelShadow(
  scene: Phaser.Scene,
  key: string,
  w: number,
  h: number,
  opts: {
    blur?: number;
    offsetX?: number;
    offsetY?: number;
    color?: string;
    radius?: number;
  } = {},
): boolean {
  if (scene.textures.exists(key)) return true;
  const blur = opts.blur ?? 52;
  const offX = opts.offsetX ?? 0;
  const offY = opts.offsetY ?? 28;
  const color = opts.color ?? 'rgba(20,13,8,0.72)';
  const radius = opts.radius ?? 18;
  // Margin must comfortably fit the blur falloff + offset on every side.
  const margin = Math.ceil(blur * 2 + Math.max(Math.abs(offX), Math.abs(offY)) + 8);
  const cw = Math.ceil(w + margin * 2);
  const ch = Math.ceil(h + margin * 2);
  const canvas = scene.textures.createCanvas(key, cw, ch);
  if (!canvas) return false; // Canvas2D unavailable — degrade (no shadow).
  const ctx = canvas.getContext();
  ctx.save();
  ctx.shadowColor = color;
  ctx.shadowBlur = blur;
  ctx.shadowOffsetX = offX;
  ctx.shadowOffsetY = offY;
  // The fill itself is hidden behind the panel; its CAST shadow is the visible
  // halo. Opaque black so no gap shows through under the panel either.
  ctx.fillStyle = '#000';
  const rx = (cw - w) / 2;
  const ry = (ch - h) / 2;
  roundRectPath(ctx, rx, ry, w, h, radius);
  ctx.fill();
  ctx.restore();
  canvas.refresh();
  return true;
}

/** Canvas2D rounded-rectangle path (ctx.roundRect is not universally available). */
function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rad = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}

/**
 * Technique §3.5 — One heraldric L-bracket polygon (brass corner clamp).
 *
 * Traces a 6-point L-shape at corner (ox, oy) with arm signs (dx, dy):
 * dx=+1 arm points right, dx=-1 left; dy=+1 down, dy=-1 up. `fillPoints` with
 * closeShape=true closes the polygon. Called 4× (TL/TR/BL/BR) — zero new art
 * (doc 23 §3.5 sanctions Graphics over atlas frames when no art drop exists).
 */
export function drawCornerBracket(
  gfx: Phaser.GameObjects.Graphics,
  ox: number,
  oy: number,
  armLen: number,
  thickness: number,
  dx: number,
  dy: number,
): void {
  const points = [
    new Phaser.Math.Vector2(ox, oy),
    new Phaser.Math.Vector2(ox + dx * armLen, oy),
    new Phaser.Math.Vector2(ox + dx * armLen, oy + dy * thickness),
    new Phaser.Math.Vector2(ox + dx * thickness, oy + dy * thickness),
    new Phaser.Math.Vector2(ox + dx * thickness, oy + dy * armLen),
    new Phaser.Math.Vector2(ox, oy + dy * armLen),
  ];
  gfx.fillPoints(points, true, true);
}
