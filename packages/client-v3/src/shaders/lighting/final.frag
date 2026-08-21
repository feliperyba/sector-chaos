// Final composite — camera-internal filter (its output IS the on-screen image).
//
// Sampler slots (set by FinalFilterNode.setupTextures):
//   slot 0: uSceneSampler   — camera scene tex (HUD only — the world is ignored
//                            on the main camera and captured into the albedo RT;
//                            HUD lives at depth >= hudBg and renders here)
//   slot 1: uHdrLitSampler  — __litRT (HDR linear output of the HdrLit stage)
//   slot 2: uBloomSampler   — __bloomVRT (reserved; unused at tier 1)
//
// ── Composition strategy: Option B (in-shader HUD alpha-composite) ──
//
// The 06 prototype's FINAL_FRAG (prototype.js:243-287) outputs the lit RT
// directly (`gl_FragColor = vec4(max(mapped, 0.0), 1.0)`, line 285); slot 0
// (uLitSampler) is declared but NEVER READ (comment line 246: "slot 0 (camera
// scene tex — unused, lit comes from slot 1)"). This works in the prototype
// because its HUD is HTML/CSS (index.html:34 `<div id="hud">` with
// `position: fixed; z-index: 10`) — rendered by the browser outside the Phaser
// canvas, surviving the camera filter via CSS layering.
//
// This codebase's HUD is Phaser GameObjects on the single main camera (see
// LightingPipeline.ts build() block for the full Phaser-4.1 constraint
// citation). A camera-internal filter processes the ENTIRE camera render
// (world + HUD); outputting only the lit RT would clobber the in-canvas HUD.
// The faithful port of the prototype's INTENT (lit world visible + HUD
// visible) tonemaps the lit RT and alpha-composites the HUD over it. The main
// camera background is transparent, so slot 0's alpha channel discriminates:
// alpha=0 where no HUD draws (lit world shows), alpha>0 where HUD draws (HUD
// overlays). This is the in-shader equivalent of the prototype's CSS z-index
// overlay. Without the transparent background (opaque alpha=1 everywhere),
// `mix(lit, scene.rgb, scene.a)` would always pick `scene` and lose the lit
// world — so the transparent camera is load-bearing for this composite.
//
// Tier-1 baseline look: Reinhard tonemap `x/(x+1)`, NO bloom, NO vignette,
// NO grade. The ambient floor in HdrLit already keeps everything legible.
//
// The ACES path + bloom additive + grade + vignette branches are present but
// uniform-gated OFF at tier 1, so tickets 07/08 can light them up without
// reworking the pipeline.
precision mediump float;

varying vec2 outTexCoord;

uniform sampler2D uSceneSampler;   // slot 0 — camera scene tex (HUD; alpha-composited)
uniform sampler2D uHdrLitSampler;  // slot 1 — __litRT (HDR linear)
uniform sampler2D uBloomSampler;   // slot 2 — reserved (tier-1: unused)

uniform float uBloomStrength;
uniform float uUseBloom;
uniform float uACES;
uniform float uGrade;
uniform float uVignette;
uniform float uReinhard;   // 1 = use Reinhard (tier-1 baseline) instead of ACES

vec3 acesTonemap(vec3 x) {
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

vec3 reinhard(vec3 x) {
  return x / (x + 1.0);
}

void main() {
  vec3 lit = texture2D(uHdrLitSampler, outTexCoord).rgb;
  if (uUseBloom > 0.5) {
    vec3 bloom = texture2D(uBloomSampler, outTexCoord).rgb;
    lit += bloom * uBloomStrength;   // additive in HDR, before tonemap
  }
  vec3 mapped;
  if (uReinhard > 0.5) {
    // Reinhard is mild enough to keep per-channel (low desaturation at the
    // brightness ranges Reinhard produces — its asymptote is 1.0 but it
    // reaches it slowly, so per-channel hue shift stays perceptually small).
    mapped = reinhard(lit);
  } else {
    // ── D2 (lighting-system-4): luminance-tonemap ACES (theagentd method). ──
    // PRE-D2 applied ACES per-channel: `mapped = acesTonemap(lit)`. Narkowicz's
    // own caveat (research Q5): the per-channel fit "over saturates brights"
    // and shifts hue ratios toward white/magenta as brightness rises
    // (theagentd's proof: per-channel `x/(x+1)` maps `(5,0,10)` purple to
    // `(5/6,0,10/11)` ≈ magenta; ACES does the same thing in a smoother curve).
    // After D2 Layers 1+2, bright additive clusters (overlapping explosions,
    // muzzle flashes) still desaturated to white under per-channel ACES.
    //
    // The fix (research Q5 recommendation #1, theagentd's method): apply ACES
    // to the LUMINANCE scalar, then rescale the RGB vector by the tonemapped-
    // luminance / original-luminance ratio. This preserves hue ratios under
    // bright clusters (the RGB ratios of `lit` are carried through unchanged;
    // only the overall brightness is compressed). The ACES operator itself is
    // UNCHANGED (the standard Narkowicz fit — `a=2.51, b=0.03, c=2.43,
    // d=0.59, e=0.14`); only the application point changes (luminance vs
    // per-channel). `acesTonemap(vec3(L, 0.0, 0.0)).x` is mathematically
    // equivalent to applying the ACES rational function to the scalar L (each
    // channel of the function is independent), kept in this form so the single
    // operator definition stays the source of truth.
    float L = max(dot(lit, vec3(0.2126, 0.7152, 0.0722)), 1e-4);
    float nL = acesTonemap(vec3(L, 0.0, 0.0)).x;
    mapped = lit * (nL / L);
  }

  if (uGrade > 0.5) {
    // Saturation boost — AAA color read jewel-like, not washed.
    float lum = dot(mapped, vec3(0.299, 0.587, 0.114));
    mapped = mix(vec3(lum), mapped, 1.28);
    // ── ALL THREE A/B BASELINES for the split-tone (do not lose prior art) ──
    //   (a) VERBATIM-PROTOTYPE (prototype.js:275-278):
    //         warm highlights = vec3(1.08, 1.0, 0.90)
    //         cool shadows    = vec3(0.88, 0.97, 1.10)   ← B-boost, reinforced
    //                                                    the cool-navy floor
    //   (b) TICKET 23 warm-shadow (commit 033616e):
    //         warmShadow      = vec3(0.92, 0.86, 0.78)   ← R>G>B warm, but ALL
    //         gamma           = pow(..., vec3(0.90))→0.95 channels <1.0 → net-
    //                                                    darkens the shadow band
    //                                                    (compounds the dim floor)
    //   (c) TICKET 06 lifted-warm (this commit):
    //         warmShadow      = vec3(0.96, 0.92, 0.88)   ← eased toward neutral
    //         gamma           = pow(..., vec3(0.92))     ← R≥G≥B still warm
    //
    // ── Ticket 23 (warm-dominant split-tone — DIRECTION preserved) ──
    // AAA rule (research §3, §7): warm-dominant in torch-lit spaces; mood =
    // low-key chiaroscuro. Keep warm highlights; warm-dominant shadows. The
    // warm HUE is preserved (R≥G≥B); only the magnitude is eased (see A6 §3.3
    // H4: ticket-23's [0.92,0.86,0.78] net-darkens the shadow band on top of
    // the dim floor). vec3 warm is UNCHANGED from the verbatim prototype.
    vec3 warm = vec3(1.08, 1.0, 0.90);
    vec3 warmShadow = vec3(0.96, 0.92, 0.88);
    mapped = mix(mapped * warmShadow, mapped * warm, smoothstep(0.15, 0.85, lum));
    // ── Ticket 06 — gamma eased between verbatim (0.90) and ticket-23 (0.95) ──
    // 0.92 keeps deeper shadows than the verbatim flat-lifted 0.90 (low-key
    // chiaroscuro preserved) without the ticket-23 0.95 darkening (A6 §3.3 H2:
    // at the dim floor, pow(x,0.95) operates in exactly the band it darkens
    // most — the lifted floor moves the band back into the readable range, so
    // a hair of shadow lift restores midtone legibility without going flat).
    // A/B starting point per spec; tuned by eye against the seeded preview.
    mapped = pow(max(mapped, 0.0), vec3(0.92));
  }
  if (uVignette > 0.5) {
    // ── Ticket 06 → C5 — vignette paired with the floor lift ──
    // Ticket 06 EASED the vignette here to 0.25 (from ticket-23's 0.35) to keep
    // corners readable on top of the dim 0.60 floor. C5 (2026-08-07) lifts the
    // floor to 0.70 AND STRENGTHENS the vignette back to 0.30 — paired
    // deliberately (user ruling): the stronger vignette preserves the low-key
    // chiaroscuro mood/center-focus while the lifted floor rescues corner
    // readability. The corner multiplier is (1 - strength): 0.30 → corners keep
    // 70% of the lifted floor. Net-corner check (verified algebraically): the
    // floor lift (+0.10 sum, +16.7% rel) dominates the vignette crush
    // (corner multiplier 0.75→0.70, -6.7% rel), so corner ACES-mapped luma
    // rises ~0.109 → ~0.126 (+15.2%). The vignette is a MOOD device, not a
    // visibility device — paired with the floor lift it stays inside the
    // cosmetic-only floor (GDD docs/GDD.md:210 — no fog of war).
    vec2 q = outTexCoord - 0.5;
    float vig = smoothstep(0.85, 0.30, dot(q, q) * 2.2);
    mapped *= mix(1.0, vig, 0.30);
  }

  // Alpha-composite the HUD (camera scene tex, slot 0) over the lit world.
  // The main camera background is transparent → slot 0 alpha = 0 where no HUD
  // draws (lit world shows through) and > 0 where HUD draws (HUD overlays).
  // In-shader equivalent of the prototype's HTML CSS HUD overlay — see the
  // file header for the full Phaser-4.1 constraint rationale.
  vec4 scene = texture2D(uSceneSampler, outTexCoord);
  vec3 outRgb = mix(mapped, scene.rgb, scene.a);

  gl_FragColor = vec4(max(outRgb, 0.0), 1.0);
}
