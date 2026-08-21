// HDR light composite — Tier-1 baseline look + the AAA technique stack
// (tickets 07/08). The tier flags (uTwoTerm/uSpecular/uCookie) are uniform-
// controlled so A/B flips don't recompile; LightingTiers.ACTIVE_TIER sets them.
//
// Inputs (sampler slots):
//   slot 0: uAlbedoSampler    (__albedoRT)
//   slot 1: uNormalsSampler   (__normalsRT)
//   slot 2: uCookieSampler1   (light_01.png — warm torch/fire/candle cookie)
//   slot 3: uCookieSampler2   (light_02.png — cool player-aura cookie)
//   slot 4: uCookieSampler3   (light_03.png — poison cookie)
//
// Outputs LINEAR HDR (values may exceed 1.0) into __litRT; tonemap happens
// in the Final camera-internal filter.
//
// ── Tier math (uniform-gated; LightingTiers.TIERS[ACTIVE_TIER] sets flags) ──
//   Tier 1 baseline (else branches): flat single-smoothstep disk falloff
//     `atten = t*t*(3-2*t) * intensity`, NO two-term/specular/cookie, low
//     emissive boost (0.6), ambient floor vec3(0.38,0.40,0.48).
//   Tiers 2+ (ticket 07): two-term core+halo, Blinn-Phong specular, hot
//     emissive boost 2.2, cookie modulation, ambient floor vec3(0.18,0.15,0.12)
//     for HDR tiers — cosmetic only, never a vision mechanic (GDD forbids fog
//     of war).
//
// ── Per-light cookie selection (ticket 07) ──
// `uLightParams[i].w` (lp.w) carries the cookie index from the palette
// (1→light_01/slot2, 2→light_02/slot3, 3→light_03/slot4; 0 = no cookie). This
// is a faithful superset of the 06 prototype's shipped mechanism: the prototype
// bound a single cookie (light_01) at slot 2 + treated lp.w as a boolean on/off
// (gate `lp.w > 0.5`). The data model there already carried per-kind cookie
// indices (1/2/3) in lp.w; this shader makes that selection real so each kind
// samples its validated cookie (warm torch/fire/candle → light_01, cool aura →
// light_02, poison → light_03). The cookie math itself (cuv, mix 0.65, atten*=)
// is verbatim from prototype.js:167-170.
//
// World-position reconstruction uses the Y-flipped formula (Phaser-4.1 gotcha):
//   v4 framebuffers are bottom-origin, worldView is top-origin → Y needs flip;
//   X needs no flip. Albedo/normals are sampled with the RAW outTexCoord (not uv).
precision mediump float;

#define MAX_LIGHTS 256

varying vec2 outTexCoord;

uniform sampler2D uAlbedoSampler;    // slot 0
uniform sampler2D uNormalsSampler;   // slot 1
uniform sampler2D uCookieSampler1;   // slot 2 — light_01.png (warm)
uniform sampler2D uCookieSampler2;   // slot 3 — light_02.png (cool aura)
uniform sampler2D uCookieSampler3;   // slot 4 — light_03.png (poison)

uniform vec4  uWorldView;           // xy=top-left world, zw=visible w/h

uniform int   uLightCount;
uniform vec4  uLights[MAX_LIGHTS];      // xy=pos, z=radius, w=intensity
uniform vec3  uLightColors[MAX_LIGHTS];
uniform vec4  uLightParams[MAX_LIGHTS]; // x=corePower y=haloFrac z=specPower w=cookieIdx+blendMode (packed; see below)
// D2 (lighting-system-4) — the per-light accumulation blend mode is PACKED into
// `uLightParams[i].w` (lp.w) ALONGSIDE the cookie index, NOT a separate array.
// A 256-element `uniform float uLightBlend[MAX_LIGHTS]` would push the total
// uniform-vector count (768 from uLights/uLightColors/uLightParams) to 1024,
// exceeding `MAX_FRAGMENT_UNIFORM_VECTORS` on many GPUs → the shader fails to
// link → black screen (the D2 regression this packing fixes).
//
// Packing scheme (the cookie index occupies the low digit; the blend mode the
// tens digit):
//   lp.w = cookieIdx + blendOffset
//     cookieIdx: 0 = no cookie, 1 = light_01, 2 = light_02, 3 = light_03
//     blendOffset: 0 = additive (the historical behavior; energy accumulates),
//                  10 = max-blend (N same-color lights = brightness of 1)
//   so e.g. light_02 + max-blend = 2 + 10 = 12. The cookie is extracted with
//   `mod(lp.w, 10.0)`; the blend mode is read via `lp.w > 9.5`.
// LightPacker.packLights writes `uLightParams[i].w = cookieIdx + (max ? 10 : 0)`.

uniform vec3  uAmbient;
uniform float uUseNormals;
uniform int   uShowMode;   // 0=lit 1=albedo 2=normals 3=lit-pre-tonemap(debug)

// Tier flags (uniform-controlled so A/B flips don't recompile). Tier-1 baseline
// leaves all of these at 0.0; LightingTiers.ACTIVE_TIER raises them.
uniform float uTwoTerm;
uniform float uSpecular;
uniform float uCookie;
uniform float uSpecularScale; // per-instance specular-term scale (menu >1 for stronger sheen; gameplay 1.0)

// Ticket 19 — A/B toggle for the accumulation model. DEFAULT 0.0 (new path).
//   uPureAdditive = 1.0  → OLD pure-additive accumulation (the regression
//                            baseline: the shipped white-blob look). Bit-identical
//                            to the pre-ticket-19 shader (3 separate `lit +=`).
//   uPureAdditive = 0.0  → NEW alpha-composite (blend-add) accumulation — the
//                            Diablo III white-blob fix. Overlapping lights
//                            composite via an HDR-correct screen blend so they
//                            stay discrete/readable instead of fusing to white.
// Flipped at runtime via the `window.__LIGHTING_PURE_ADDITIVE__` debug global
// (read in LightingPipelineUpdate → uniformStash → this uniform) for live A/B.
uniform float uPureAdditive;

void main() {
  // World-position reconstruction (Y-flip gotcha, pinned in the spec).
  vec2 uv = vec2(outTexCoord.x, 1.0 - outTexCoord.y);
  vec2 world = uWorldView.xy + uv * uWorldView.zw;

  vec4 albedo = texture2D(uAlbedoSampler, outTexCoord);
  vec3 normal = texture2D(uNormalsSampler, outTexCoord).rgb * 2.0 - 1.0;
  if (uUseNormals < 0.5) {
    normal = vec3(0.0, 0.0, 1.0);
  }

  if (uShowMode == 1) { gl_FragColor = vec4(albedo.rgb, 1.0); return; }
  if (uShowMode == 2) { gl_FragColor = vec4(normal * 0.5 + 0.5, 1.0); return; }

  // Cosmetic-only: ambient floor keeps the world fully visible (GDD forbids fog
  // of war — lighting is mood only, never a visibility mechanic).
  vec3 lit = albedo.rgb * uAmbient;

  for (int i = 0; i < MAX_LIGHTS; i++) {
    if (i >= uLightCount) break;
    vec4 ld = uLights[i];
    vec3 lc = uLightColors[i];
    vec2 d = world - ld.xy;
    float dist = length(d);
    if (dist > ld.z) continue;
    float t = clamp(1.0 - dist / ld.z, 0.0, 1.0);
    vec4 lp = uLightParams[i];

    // ── Falloff ──
    float atten;
    float coreT;   // reused for emissive
    if (uTwoTerm > 0.5) {
      // AAA two-term (ticket 07): tight bright core + wide soft halo, summed in HDR.
      // prototype.js:156-158
      coreT = pow(t, lp.x);
      float halo = t * t * (3.0 - 2.0 * t);
      atten = (coreT + halo * lp.y) * ld.w;
    } else {
      // Tier-1 baseline: flat single-smoothstep disk.
      coreT = pow(t, 2.5);
      float halo = t * t * (3.0 - 2.0 * t);
      atten = halo * ld.w;
    }

    // ── Light cookie (ticket 07) — non-circular natural glow from light_*.png ──
    // D2 packs the blend mode into lp.w alongside the cookie index
    // (cookieIdx + 10 for max-blend; see the header comment). Extract the cookie
    // index via `mod(lp.w, 10.0)` so the +10 offset doesn't break selection.
    // lp.w is the cookie index (1/2/3 → light_01/02/03; 0 = off). Verbatim cookie
    // math from prototype.js:167-170; only the sampler selection is new (the
    // prototype bound a single light_01 at slot 2 + treated lp.w as a boolean).
    float cookieIdx = mod(lp.w, 10.0);
    if (uCookie > 0.5 && cookieIdx > 0.5) {
      vec2 cuv = (world - ld.xy) / ld.z * 0.5 + 0.5;
      float cookieMask;
      if (cookieIdx < 1.5) {
        cookieMask = texture2D(uCookieSampler1, cuv).a;       // light_01 (warm)
      } else if (cookieIdx < 2.5) {
        cookieMask = texture2D(uCookieSampler2, cuv).a;       // light_02 (cool aura)
      } else {
        cookieMask = texture2D(uCookieSampler3, cuv).a;       // light_03 (poison)
      }
      // Ticket 07 (A2 findings §3, §5): cookie mix 0.65 → 0.50 — a GLOBAL
      // diffuseness lever. At 0.65 the cookie mask (a radial gradient fading to
      // its edge) suppressed the outer ring, making every disk read smaller +
      // tighter than its radius. Easing toward 0.50 lets the pure radial halo
      // (the smoothstep term at hdrLit.frag:114) carry more of the edge, so all
      // lights read as wider + more diffuse. The cookie still contributes its
      // non-circular natural-glow character (50% cookie, 50% radial), just less
      // aggressively. A/B baseline: was 0.65 (verbatim-prototype). Tuned by eye
      // against the post-ticket-05/06 corrected composite + readable ambient.
      atten *= mix(1.0, cookieMask, 0.50);
    }

    // ── Diffuse (Lambert) from the normal map ──
    // Light dir angled upward gives beveled tile edges + wall faces visible
    // relief as a nearby torch would. Mix keeps flat areas lit (cosmetic).
    vec3 toLight = normalize(vec3(-d.x, -d.y, max(ld.z * 0.55, 1.0)));
    float diff = max(dot(normal, toLight), 0.0);
    diff = mix(1.0, diff, 0.55);

    // ── Per-light contribution ──
    // Diffuse + specular, summed into ONE per-light contribution. (Summing the
    // two terms for a single light is correct — they're the same light's
    // diffuse/specular.) The fix is about how DISTINCT lights combine, which the
    // composite below handles.
    //
    // ── D2 (lighting-system-4) — the emissive-add term is REMOVED. ──
    // PRE-D2 the per-light contribution also included an emissive add:
    //     c += albedo.rgb * lc * coreT * emissiveBoost;   (emissiveBoost = 2.2 | 1.0 | 0.6)
    // This was the WASHOUT. At a light core (coreT ≈ 1) it added `albedo * lc`
    // ON TOP of the diffuse `albedo * lc * atten * diff`, so the pixel
    // approached `albedo * lc` — the entity tinted full-strength by the light
    // color. Silhouette gone. Every reference 2D deferred pipeline avoids this
    // (research Q1/Q3): the standard composite is pure `albedo * light`
    // (MonoGame `return color * light`, Pixi.js `diffuseColor.rgb * intensity`,
    // Unity URP 2D). The motivated-lighting "core glow" the emissive was
    // approximating is ALREADY provided by: (i) the diffuse term lighting the
    // floor/walls around the source (the disk reads as a soft wash, not a flat
    // disk); (ii) the prop sprite (torch/campfire art is bright, bloom picks it
    // up); (iii) the light cookie (the non-circular natural-glow mask). The
    // emissive-add was redundant core brightness that only buried entities.
    // Research grounding: `.scratch/lighting-system-4/01-research/light-washout-
    // additive-research.md` Q3 ("Your pipeline's `c += albedo.rgb * lc * coreT *
    // ld.w * emissiveBoost` line is the anti-pattern").
    vec3 c = albedo.rgb * lc * atten * diff;        // diffuse (was `lit += ...`)
    if (uSpecular > 0.5) {                           // specular (was `lit += ...`)
      vec3 viewDir = vec3(0.0, 0.0, 1.0);
      vec3 halfDir = normalize(toLight + viewDir);
      float spec = pow(max(dot(normal, halfDir), 0.0), lp.z);
      // C5 (albedo-modulate): was `lc * spec * atten * 0.85` — albedo-blind,
      // which stamped the light's pure color at the core (a contributing cause
      // of the "cores too bright" half of the simultaneous-contrast pair). The
      // specular should LIGHT THE SURFACE, not stamp pure light color — same
      // albedo-modulation model the diffuse term uses (ticket 05).
      //
      // Lighting-mood pass: the prior C5 line kept a `* 0.85` tempering scale,
      // replaced by a per-pipeline-instance `uSpecularScale` uniform (default
      // 1.0). Because the term is albedo-modulated it is naturally subtle on
      // dark surfaces, so 0.85 left many lights — notably the biome-glow
      // crystals, whose specPower was also the sharpest in the palette —
      // producing almost no visible sheen. The uniform lets each pipeline tune
      // the sheen: gameplay 1.0, the menu >1 so its few fixtures read stronger.
      // Albedo-modulation still bounds it well short of stamping pure light color.
      c += albedo.rgb * lc * spec * atten * uSpecularScale;
    }
    // D2: emissive-add term REMOVED (see the header comment above). `coreT` is
    // still computed because the two-term falloff uses it for the diffuse atten
    // at :110-121 (it is NOT dead — `coreT` is consumed in `atten` there).

    // ════════════════════════════════════════════════════════════════════════
    // TICKET 19 — light accumulation (the Diablo III white-blob fix).
    //
    // AAA CITATION (verbatim from 02-research.md §"Diablo III VFX"):
    //   Diablo III uses "Blend-Add (Alpha Composite)" rather than pure
    //   additive. Why: with "vast amounts of spells on screen," pure additive
    //   turns "everything into one large mass of white." Alpha composite
    //   places "a black background behind the emissive part, helping it stand
    //   out more in a scene with a lot of things happening at once."
    //   — Julian Love, "The VFX of Diablo," GDC 2013
    //     (https://gdcvault.com/play/1017660/Technical-Artist-Bootcamp-The-VFX;
    //      JangaFX write-up: https://jangafx.com/insights/diablo-3-vfx-experiments)
    //   Readability rule (Love): "be able to space out when looking at an
    //   effect" — i.e. an effect must read as discrete, not as a fused blob.
    //
    // Realization — HDR-correct screen blend with asymptote K:
    //     lit = lit + c - lit * c / K          (equivalently, in "opacity":
    //     (1 - lit/K)(1 - c/K) = the unlit fraction — i.e. each light
    //     multiplies the BLACK background behind it; lit accumulates only the
    //     emissive part that survives that black. This is exactly Love's "a
    //   black background behind the emissive part.")
    //
    // Why this realizes "overlapping lights stay discrete" (vs pure additive):
    //   - Single light over the dim ambient floor: c << K, so
    //     lit ≈ ambient + c → the validated tier-5 tight-core + soft-halo look
    //     is preserved (single-light character unchanged; the A/B should be
    //     ~identical for an isolated light).
    //   - Two co-located lights of magnitude c: pure additive gives 2c (linear
    //     → fuses straight to white). Screen gives c + c - c²/K ≈ 2c - c²/K —
    //     the -c²/K term is the "black background" eating the overlap, so the
    //     sum brightens but bends toward K instead of running to infinity.
    //   - N co-located lights: pure additive = N·c (unbounded → one mass of
    //     white). Screen asymptotes to K (bounded) → cores brighten toward a
    //     readable hot point but each light's center still reads as a distinct
    //     bright point against a darker surround.
    //
    // K is the per-channel asymptote. ── D2 (lighting-system-4): K lowered
    // 4.0 → 2.5. ──
    // The ticket spec'd this with ACES(4.0)≈0.85 / ACES(2.5)≈0.76, but those
    // values are INCORRECT — verified algebraically against the Narkowicz fit
    // (a=2.51, b=0.03, c=2.43, d=0.59, e=0.14):
    //   ACES(1.0) ≈ 0.804    ACES(2.5) ≈ 0.938    ACES(4.0) ≈ 0.973
    // So the K change 4.0→2.5 shifts the saturated-additive asymptote from
    // ~0.973 to ~0.938 — a real but MODEST reduction (≈3.6%), NOT the
    // 0.85→0.76 (≈10%) the ticket assumed. The PRIMARY whiteout fix is the
    // max-blend family (Layer 2a/2c above) — N same-color auras under
    // max-blend = brightness of 1, which sits well below the asymptote
    // regardless of K. K=2.5 is retained per the spec (it still helps the
    // ADDITIVE family — torch/explosion clusters — and the value is locked by
    // the orchestrator's instruction); the modest magnitude is flagged in the
    // worker report as a DEVIATION from the ticket's stated rationale.
    // Asymptote math: as x→∞, ACES(x) → a/c = 2.51/2.43 ≈ 1.033 (clamped to 1.0).
    //
    // ── D2 (lighting-system-4): three-way branch on the per-light blend mode. ──
    // The blend mode is PACKED into lp.w (cookieIdx + 10 for max-blend; see the
    // header comment). The max-blend family (aura, biome-glow — `lp.w > 9.5`)
    // uses `lit = max(lit, c)` so N same-color lights = brightness of 1 (research
    // Q2 Technique C — Unity URP "Alpha Blend Overlap Operation"). The
    // additive family (everything else) keeps the ticket-19 screen-blend with
    // the lowered K=2.5. The pure-additive A/B baseline is preserved via
    // `uPureAdditive` (the OLD white-blob look) for the live regression.
    //
    // uPureAdditive=1 branch reproduces the pre-ticket shader bit-identically
    // (3 separate `lit +=`) — the regression baseline for the live A/B. Note:
    // the max-blend branch is HONORED even under uPureAdditive=1 (a max-blend
    // light should never sum regardless of the A/B mode — otherwise the A/B
    // would re-introduce the whiteout for auras specifically). This is the
    // intentional deviation from "bit-identical baseline"; documented here.
    // ════════════════════════════════════════════════════════════════════════
    if (lp.w > 9.5) {
      // D2 — max-blend family (aura, biome-glow). N same-color lights =
      // brightness of 1 light. No information lost (all auras are warm-white;
      // all biome-glows are cool). Unity URP "Alpha Blend Overlap Operation"
      // (research Q2 Technique C — ranked #1 for clustered same-color lights).
      lit = max(lit, c);
    } else if (uPureAdditive > 0.5) {
      // OLD path — pure additive (the white-blob look). Kept verbatim as the
      // A/B regression baseline for the ADDITIVE family only. Do NOT retune: it
      // must stay bit-identical to the shipped pre-ticket-19 accumulation so
      // the A/B is apples-to-apples.
      lit += c;
    } else {
      // NEW path — alpha-composite (blend-add), per Love GDC 2013.
      // D2: K lowered 4.0 → 2.5 (saturated asymptote ACES≈0.938 vs ≈0.973;
      // see the header comment for the corrected ACES math).
      const float K = 2.5;   // per-channel HDR asymptote
      lit = lit + c - lit * c / K;
    }
  }

  if (uShowMode == 3) { gl_FragColor = vec4(clamp(lit, 0.0, 1.0), 1.0); return; }

  // Output HDR linear. Final pass tonemaps.
  gl_FragColor = vec4(lit, 1.0);
}
