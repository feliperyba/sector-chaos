// Separable 9-tap Gaussian blur — the H + V bloom blur stages share this one
// shader, parameterized by `uDir` (the texel step in one axis).
//
//   H-blur stage: uDir = (1/bloomW, 0)   — __bloomBright → __bloomH
//   V-blur stage: uDir = (0, 1/bloomH)   — __bloomH      → __bloomVRT
//
// `uSpread` (4.0) multiplies the per-tap offset so a single 9-tap pass reaches
// far — two passes of 9-tap Gaussian at spread 4 give an effective ~32px radius
// at 720p (Hades-II scale bloom). The 9-tap decomposition is center + 4
// symmetric pairs, so only 5 distinct weights are needed.
//
// Verbatim port of the validated 06 prototype's BLUR_FRAG
// (`docs/wayfinder/prototypes/06-aaa-lighting/prototype.js:223-240`). The
// weights + spread are mirrored in `LightingTiers.BLOOM_WEIGHTS` /
// `LightingTiers.BLOOM.spread` (regression-guarded by `LightingTiers.test.ts`).
//
// Runs at HALF the g-buffer resolution (bloom is a wide blur; half-res is
// visually identical and ~4× cheaper — spec §"Performance budget"). `uDir` is
// therefore `1/bloomDim` (the half-res dimension), NOT `1/gbufDim` — wiring
// the full-res texel size here would shrink the blur to half its intended
// radius. See `LightingRtShaderBuilder.buildBloomBlurShader`.
precision mediump float;

varying vec2 outTexCoord;

uniform sampler2D uTex;
uniform vec2 uDir;       // texel step in one axis ((1/bloomW, 0) or (0, 1/bloomH))
uniform float uSpread;   // multiplier on uDir for a wider blur (4.0)

void main() {
  float w[5];
  w[0] = 0.227027; w[1] = 0.1945946; w[2] = 0.1216216; w[3] = 0.054054; w[4] = 0.016216;
  vec3 sum = texture2D(uTex, outTexCoord).rgb * w[0];
  for (int i = 1; i < 5; i++) {
    vec2 off = uDir * float(i) * uSpread;
    sum += texture2D(uTex, outTexCoord + off).rgb * w[i];
    sum += texture2D(uTex, outTexCoord - off).rgb * w[i];
  }
  gl_FragColor = vec4(sum, 1.0);
}
