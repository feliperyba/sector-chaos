// Bright-pass — first stage of the separable bloom chain.
//
// Extracts the bright (>threshold) parts of the HDR lit RT for blooming. The
// threshold (0.55) sits below 1.0 on purpose: only the HDR (>1) light cores AND
// their colored falloff bloom, not the whole scene. A soft knee (smoothstep
// over [threshold, threshold+knee]) gives a graceful rolloff so the bloom edge
// isn't a hard cliff, and a ×1.3 boost lets soft glows bloom too, not just
// clipped whites — this is what gives lights their wide colored glow rather
// than a tight white halo.
//
// Verbatim port of the validated 06 prototype's BRIGHT_FRAG
// (`docs/wayfinder/prototypes/06-aaa-lighting/prototype.js:207-220`). The
// prototype hardcodes the boost (×1.3) in the shader body and takes the
// threshold + knee as uniforms (wired at `prototype.js:432`: threshold 0.55,
// knee 1.2). The boost constant is mirrored in `LightingTiers.BLOOM.boost`
// (regression-guarded by `LightingTiers.test.ts`); changing it here requires a
// recorded HITL verdict.
//
// Runs at HALF the g-buffer resolution (bloom is a wide blur; half-res is
// visually identical and ~4× cheaper — spec §"Performance budget"). The
// half-res UV is identical to the source's UV (both span [0,1]); no UV
// rescaling is needed — only the RT dimensions differ.
precision mediump float;

varying vec2 outTexCoord;

uniform sampler2D uTex;    // __litRT (HDR linear)
uniform float uThreshold;  // 0.55 — start of soft knee
uniform float uKnee;       // 1.2  — width of the soft rolloff

void main() {
  vec3 c = texture2D(uTex, outTexCoord).rgb;
  float l = max(c.r, max(c.g, c.b));
  float soft = smoothstep(uThreshold, uThreshold + uKnee, l);
  // Boost slightly so soft glows bloom too, not just clipped whites.
  // (×1.3 — matches LightingTiers.BLOOM.boost + the prototype verbatim.)
  gl_FragColor = vec4(c * soft * 1.3, 1.0);
}
