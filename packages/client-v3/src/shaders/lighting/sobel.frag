// Sobel normal generation from albedo luminance.
// Input: __albedoRT (the visible world rendered into a viewport-sized RT).
// Output: __normalsRT — packed normals (N*0.5+0.5) with albedo alpha passthrough.
//
// Height = luminance of the albedo. 3x3 8-tap Sobel kernel derives gx/gy;
// N = normalize(vec3(-gx*s, -gy*s, 1.0)). The real atlas art (beveled tiles,
// depth walls, textured floors) provides genuine relief for the kernel to
// respond to. uStrength = 2.4 (validated single global value; per-category
// tuning is out of scope for launch per the spec).
precision mediump float;

varying vec2 outTexCoord;

uniform sampler2D uAlbedo;
uniform vec2 uTexel;
uniform float uStrength;

const vec3 LUMA = vec3(0.299, 0.587, 0.114);

float hAt(vec2 uv) {
  return dot(texture2D(uAlbedo, uv).rgb, LUMA);
}

void main() {
  float tl = hAt(outTexCoord + vec2(-uTexel.x,  uTexel.y));
  float t  = hAt(outTexCoord + vec2( 0.0,       uTexel.y));
  float tr = hAt(outTexCoord + vec2( uTexel.x,  uTexel.y));
  float l  = hAt(outTexCoord + vec2(-uTexel.x,  0.0));
  float r  = hAt(outTexCoord + vec2( uTexel.x,  0.0));
  float bl = hAt(outTexCoord + vec2(-uTexel.x, -uTexel.y));
  float b  = hAt(outTexCoord + vec2( 0.0,      -uTexel.y));
  float br = hAt(outTexCoord + vec2( uTexel.x, -uTexel.y));

  float gx = -tl - 2.0 * l - bl + tr + 2.0 * r + br;
  float gy = -tl - 2.0 * t - tr + bl + 2.0 * b + br;

  vec3 n = normalize(vec3(-gx * uStrength, -gy * uStrength, 1.0));
  gl_FragColor = vec4(n * 0.5 + 0.5, texture2D(uAlbedo, outTexCoord).a);
}
