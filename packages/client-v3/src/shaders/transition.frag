precision mediump float;

uniform float uProgress;
uniform float uDirection;
uniform vec2 uResolution;
uniform float uTime;
uniform vec3 uBaseColor;
uniform vec3 uDoodleColor;
uniform float uContrastFloor;
uniform float uContrastCeil;
uniform float uTiling;
uniform sampler2D iChannel0;

const float divisions = 10.0;

void main() {
    vec2 corrected_coord = vec2(gl_FragCoord.x, uResolution.y - gl_FragCoord.y);
    float biggest_dim = max(uResolution.x, uResolution.y);
    vec2 st = corrected_coord / biggest_dim;

    float p = uDirection > 0.5 ? uProgress : 1.0 - uProgress;
    float t = p * 3.0 - 1.0;

    vec2 f_st = fract(st * divisions);
    vec2 i_st = floor(st * divisions);
    f_st -= 0.5;

    t = (1.0 - t + (i_st.x / divisions) - (1.0 - i_st.y / divisions));

    float mask = step(t, 1.0 - abs(f_st.x + f_st.y)) * step(t, 1.0 - abs(f_st.x - f_st.y));
    float alpha = mask;

    // Tiled watermark doodle fill (ticket 02). The art is black strokes on
    // white paper, so stroke-ness is the INVERTED sample luminance: paper
    // (lum ~1.0) -> 0.0, strokes (lum ~0.0) -> 1.0. smoothstep(uContrastFloor,
    // uContrastCeil, ...) crushes paper grain below the floor and saturates
    // stroke cores above the ceiling (values fed from TransitionScene taste
    // constants).
    vec2 patternUV = fract(st * uTiling);
    float sampleLum = texture2D(iChannel0, patternUV).r;
    float stroke = smoothstep(uContrastFloor, uContrastCeil, 1.0 - sampleLum);

    // Both mix endpoints stay low-luminance so the wipe reads black overall:
    // uBaseColor is the near-black cell floor, uDoodleColor is a subtle
    // graphite tint the strokes lift toward. Alpha remains the diamond mask
    // ONLY — the cover must stay opaque, so the sample drives rgb, not alpha
    // (sampling alpha here would let the scene swap leak through the cover).
    vec3 fill = mix(uBaseColor, uDoodleColor, stroke);

    gl_FragColor = vec4(fill * alpha, alpha);
}
