/**
 * The adjustment chain on the GPU: Adjust (the maths of enhance() in core/adjust.ts), Levels and Curves
 * (per-channel lookup tables) run as shader passes, one after another, each blended with the selection.
 * A chain made only of these windows is drawn entirely on the GPU, so its sliders stay smooth on large
 * photos; single passes can also run on pixels from the CPU (mixed chains, committing a step).
 * create() returns null where WebGL2 is missing or the layer is too large; the chain then uses the CPU.
 */
import type { EnhanceParams } from './adjust';
import { HslParams, ToneParams, tintChroma } from './colorgrade';
import type { FxJob } from './fxjobs';

/** One step of the chain as the GPU sees it. */
export type GpuStageDesc =
  | { kind: 'enhance'; p: EnhanceParams }
  | { kind: 'lut'; r: Uint8ClampedArray; g: Uint8ClampedArray; b: Uint8ClampedArray }
  | { kind: 'hsl'; p: HslParams }
  | { kind: 'tone'; p: ToneParams }
  /** a filter job (core/fxjobs.ts) the GPU can run: full size, in real time; `keep` = preserve transparency */
  | { kind: 'fx'; job: FxJob; keep: boolean };

/** Filters run on the GPU (the same jobs as the worker's, so the windows need no GPU code of their own). */
export const GPU_FX = new Set<string>([
  'gaussian', 'unsharp', 'motionBlur', 'radialBlur', 'highPass', 'glow',
  'invert', 'desaturate', 'posterize', 'threshold', 'sepia', 'noise', 'pixelate', 'chromatic', 'emboss', 'findEdges',
]);
/** The simple filters' operation numbers in FS_SIMPLE. */
const SIMPLE_OP: Record<string, number> = { invert: 0, desaturate: 1, posterize: 2, threshold: 3, sepia: 4, noise: 5, chromatic: 7, emboss: 8, findEdges: 9 };

const VS = `#version 300 es
in vec2 p;
void main() { gl_Position = vec4(p, 0.0, 1.0); }`;

/* Separable Gaussian on premultiplied colour. Pass 1 reads the straight-alpha source (uPremul = 1). */
const FS_BLUR = `#version 300 es
precision highp float; precision highp int;
uniform sampler2D uIn; uniform ivec2 uSize; uniform ivec2 uDir; uniform float uSigma; uniform int uPremul;
out vec4 o;
vec4 at(ivec2 q) {
  vec4 c = texelFetch(uIn, clamp(q, ivec2(0), uSize - 1), 0);
  return uPremul == 1 ? vec4(c.rgb * c.a, c.a) : c;
}
void main() {
  ivec2 q = ivec2(gl_FragCoord.xy);
  int r = int(ceil(uSigma * 3.0));
  float k = -0.5 / (uSigma * uSigma);
  vec4 acc = at(q); float ws = 1.0;
  for (int i = 1; i <= r; i++) {
    float w = exp(float(i * i) * k);
    acc += (at(q + uDir * i) + at(q - uDir * i)) * w;
    ws += 2.0 * w;
  }
  o = acc / ws;
}`;

/* Straight RGBA → premultiplied (the start of the filters that average neighbours). */
const FS_PREMUL = `#version 300 es
precision highp float; precision highp int;
uniform sampler2D uIn;
out vec4 o;
void main() { vec4 c = texelFetch(uIn, ivec2(gl_FragCoord.xy), 0); o = vec4(c.rgb * c.a, c.a); }`;

/*
 * One step of motion / radial blur, as motionBlur() and radialBlur() in core/fx.ts: the mean of two
 * bilinear samples of the premultiplied picture, shifted along a line (0), away from / towards a centre (1)
 * or turned around it (2). Halving the step pass after pass builds the long blur from a few cheap passes.
 */
const FS_AVG2 = `#version 300 es
precision highp float; precision highp int;
uniform sampler2D uIn; uniform ivec2 uSize; uniform int uMode;
uniform vec2 uOff, uC; uniform float uS, uCos, uSin;
out vec4 o;
vec4 at(vec2 p) { return texture(uIn, (p + 0.5) / vec2(uSize)); }
void main() {
  vec2 x = floor(gl_FragCoord.xy);
  vec2 a, b;
  if (uMode == 0) { a = x + uOff; b = x - uOff; }
  else {
    vec2 v = x - uC;
    if (uMode == 1) { a = uC + v * (1.0 + uS); b = uC + v * (1.0 - uS); }
    else { a = uC + vec2(v.x * uCos - v.y * uSin, v.x * uSin + v.y * uCos); b = uC + vec2(v.x * uCos + v.y * uSin, -v.x * uSin + v.y * uCos); }
  }
  o = (at(a) + at(b)) * 0.5;
}`;

/* Glow: the bright parts that will glow (glow() in core/fx.ts), straight RGBA. */
const FS_GLOWMASK = `#version 300 es
precision highp float; precision highp int;
uniform sampler2D uIn; uniform float uThr;
out vec4 o;
void main() {
  vec4 s = texelFetch(uIn, ivec2(gl_FragCoord.xy), 0);
  float L = dot(s.rgb, vec3(0.299, 0.587, 0.114));
  float k = L <= uThr ? 0.0 : min(1.0, (L - uThr) / max(0.02, 1.0 - uThr));
  o = vec4(s.rgb * k, s.a);
}`;

/*
 * The end of a filter: the blurred (premultiplied, possibly reduced) picture against the source.
 * 0 = the blur itself (Gaussian, motion, radial; uKeep = preserve transparency), 1 = Unsharp Mask,
 * 2 = High Pass, 3 = Glow (screen blend); then blended with the selection. Straight RGBA out.
 */
const FS_FXOUT = `#version 300 es
precision highp float; precision highp int;
uniform sampler2D uIn, uSrc, uSel; uniform ivec2 uSize; uniform int uMode, uHasSel, uKeep;
uniform float uA, uB; uniform vec3 uTint;
out vec4 o;
void main() {
  ivec2 q = ivec2(gl_FragCoord.xy);
  vec4 s = texelFetch(uSrc, q, 0);
  vec4 b = texture(uIn, (vec2(q) + 0.5) / vec2(uSize));
  vec3 bs = b.a > 1e-4 ? b.rgb / b.a : vec3(0.0);
  vec4 res;
  if (uMode == 0) res = vec4(clamp(bs, 0.0, 1.0), uKeep == 1 ? s.a : b.a);
  else if (uMode == 1) {
    vec3 d = s.rgb - bs;
    res = vec4(clamp(mix(s.rgb, s.rgb + d * uA, step(vec3(uB), abs(d) * 510.0)), 0.0, 1.0), s.a);
  }
  else if (uMode == 2) res = vec4(clamp(128.0 / 255.0 + s.rgb - bs, 0.0, 1.0), s.a);
  else {
    vec3 g = min(vec3(1.0), bs * uTint * uA);
    res = vec4(1.0 - (1.0 - s.rgb) * (1.0 - g), s.a);
  }
  if (uHasSel == 1) res = mix(s, res, texelFetch(uSel, q, 0).r);
  o = res;
}`;

/*
 * The per-pixel and small-neighbourhood filters of core/fx.ts on the GPU (the same formulas, in 0…255 where
 * the CPU code counts in bytes), blended with the selection. uAux: the premultiplied picture (chromatic) or the
 * cell averages (pixelate).
 */
const FS_SIMPLE = `#version 300 es
precision highp float; precision highp int;
uniform sampler2D uIn, uSel, uAux; uniform ivec2 uSize; uniform int uOp, uHasSel, uI0;
uniform float uF0, uF1, uF2; uniform vec2 uC;
uniform vec3 uStopC[3]; uniform float uStopP[3];
out vec4 o;
const vec3 W3 = vec3(0.299, 0.587, 0.114);
vec4 px(ivec2 q) { return texelFetch(uIn, clamp(q, ivec2(0), uSize - 1), 0); }
float lumAt(vec2 p) {
  p = clamp(p, vec2(0.0), vec2(uSize - 1));
  ivec2 i0 = ivec2(floor(p)), i1 = min(i0 + 1, uSize - 1); vec2 f = p - vec2(i0);
  float a = dot(px(i0).rgb, W3), b = dot(px(ivec2(i1.x, i0.y)).rgb, W3), c = dot(px(ivec2(i0.x, i1.y)).rgb, W3), d = dot(px(i1).rgb, W3);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y) * 255.0;
}
float rnd(uint h) {
  h ^= h >> 16u; h *= 0x7feb352du; h ^= h >> 15u; h *= 0x846ca68bu; h ^= h >> 16u;
  return float(h) / 4294967296.0;
}
float noiseAt(uint p, uint ch) {
  uint base = p * 4u + ch * 0x9e3779b9u;
  if (uI0 == 1) { float s = 0.0; for (uint k = 0u; k < 4u; k++) s += rnd(base * 4u + k); return (s - 2.0) * 1.73; }
  return rnd(base) * 2.0 - 1.0;
}
void main() {
  ivec2 q = ivec2(gl_FragCoord.xy);
  vec4 s = px(q);
  vec3 c = s.rgb;
  vec4 res = s;
  if (uOp == 0) res.rgb = mix(c, 1.0 - c, uF0);
  else if (uOp == 1) { float v = (max(c.r, max(c.g, c.b)) + min(c.r, min(c.g, c.b))) * 0.5; res.rgb = mix(c, vec3(v), uF0); }
  else if (uOp == 2) {
    float n = uF0; vec3 i = floor(c * 255.0 + 0.5);
    res.rgb = floor(min(vec3(n - 1.0), floor(i * n / 256.0)) * 255.0 / (n - 1.0) + 0.5) / 255.0;
  }
  else if (uOp == 3) { float v = dot(floor(c * 255.0 + 0.5), W3) >= uF0 ? 1.0 : 0.0; res.rgb = vec3(v); }
  else if (uOp == 4) {
    // gradient map by brightness (sepia): three stops, mixed with the original by the amount
    float t = floor(dot(floor(c * 255.0 + 0.5), W3) + 0.5) / 255.0;
    int k = t > uStopP[1] ? 1 : 0;
    float f = clamp((t - uStopP[k]) / max(1e-6, uStopP[k + 1] - uStopP[k]), 0.0, 1.0);
    vec3 g = floor(mix(uStopC[k], uStopC[k + 1], f)) / 255.0;
    res.rgb = mix(c, g, uF0);
  }
  else if (uOp == 5) {
    uint p = uint(q.y * uSize.x + q.x);
    float amp = uF0;
    if (uF1 > 0.5) { float n = noiseAt(p, 0u) * amp; res.rgb = c + n; }
    else res.rgb = c + vec3(noiseAt(p, 0u), noiseAt(p, 1u), noiseAt(p, 2u)) * amp;
    res.rgb = clamp(res.rgb, 0.0, 1.0);
  }
  else if (uOp == 6) {
    vec4 m = texelFetch(uAux, q / uI0, 0);
    res = vec4(m.a > 0.0 ? m.rgb / m.a : vec3(0.0), m.a);
  }
  else if (uOp == 7) {
    vec2 x = vec2(q), v = x - uC;
    vec4 r = texture(uAux, (uC + v / (1.0 + uF0) + 0.5) / vec2(uSize));
    vec4 b = texture(uAux, (uC + v / (1.0 - uF0) + 0.5) / vec2(uSize));
    vec4 g = texelFetch(uAux, q, 0);
    float al = max(r.a, max(g.a, b.a));
    res = al <= 0.01 / 255.0 ? vec4(0.0) : vec4(clamp(vec3(r.r, g.g, b.b) / al, 0.0, 1.0), al);
  }
  else if (uOp == 8) {
    vec2 x = vec2(q), dv = uC;
    float d = (lumAt(x - dv) - lumAt(x + dv)) * uF0 / 255.0;
    res.rgb = clamp(uI0 == 1 ? c + d : vec3(128.0 / 255.0 + d), 0.0, 1.0);
  }
  else if (uOp == 9) {
    vec3 p00 = px(q + ivec2(-1, -1)).rgb, p01 = px(q + ivec2(0, -1)).rgb, p02 = px(q + ivec2(1, -1)).rgb;
    vec3 p10 = px(q + ivec2(-1, 0)).rgb, p12 = px(q + ivec2(1, 0)).rgb;
    vec3 p20 = px(q + ivec2(-1, 1)).rgb, p21 = px(q + ivec2(0, 1)).rgb, p22 = px(q + ivec2(1, 1)).rgb;
    vec3 gx = (p02 + 2.0 * p12 + p22 - p00 - 2.0 * p10 - p20) * 255.0, gy = (p20 + 2.0 * p21 + p22 - p00 - 2.0 * p01 - p02) * 255.0;
    vec3 e = clamp((255.0 - sqrt(gx * gx + gy * gy) / 4.0) / 255.0, 0.0, 1.0);
    res.rgb = mix(c, e, uF0);
  }
  if (uHasSel == 1) res = mix(s, res, texelFetch(uSel, q, 0).r);
  o = res;
}`;

/*
 * Cell means for Pixelate, one direction at a time (rows, then columns): many short loops run in parallel,
 * where one loop over a whole large cell per output pixel left most of the GPU idle. Pass 1 premultiplies.
 */
const FS_CELL = `#version 300 es
precision highp float; precision highp int;
uniform sampler2D uIn; uniform ivec2 uSrcSize; uniform ivec2 uDir; uniform int uF, uPremul;
out vec4 o;
void main() {
  ivec2 q = ivec2(gl_FragCoord.xy);
  ivec2 b = q * (ivec2(1) + uDir * (uF - 1));
  vec4 acc = vec4(0.0); float n = 0.0;
  for (int i = 0; i < uF; i++) {
    ivec2 p = b + uDir * i;
    if (p.x >= uSrcSize.x || p.y >= uSrcSize.y) break;
    vec4 c = texelFetch(uIn, p, 0);
    acc += uPremul == 1 ? vec4(c.rgb * c.a, c.a) : c; n += 1.0;
  }
  o = acc / max(n, 1.0);
}`;

/* Box downsample by an integer factor, premultiplying the straight-alpha source. */
const FS_DOWN = `#version 300 es
precision highp float; precision highp int;
uniform sampler2D uIn; uniform ivec2 uSize; uniform int uF;
out vec4 o;
void main() {
  ivec2 b = ivec2(gl_FragCoord.xy) * uF;
  vec4 acc = vec4(0.0); float n = 0.0;
  for (int y = 0; y < uF; y++) for (int x = 0; x < uF; x++) {
    ivec2 q = b + ivec2(x, y);
    if (q.x >= uSize.x || q.y >= uSize.y) continue;
    vec4 c = texelFetch(uIn, q, 0);
    acc += vec4(c.rgb * c.a, c.a); n += 1.0;
  }
  o = acc / max(n, 1.0);
}`;

/* Adjust: the per-pixel part of enhance() on the stage input, blended with the selection. */
const FS_ENH = `#version 300 es
precision highp float; precision highp int;
uniform sampler2D uIn, uSmall, uLarge, uSel;
uniform ivec2 uSize; uniform ivec2 uOrigin;
uniform int uHasSel, uHasSmall, uHasLarge, uHasVig;
uniform float uGamma, uCf, uBp, uWp, uSh, uHl, uWr, uWb, uTg, uHshift, uSkin, uSat, uVib, uSharp, uClar, uGrain, uVamt;
uniform vec2 uVc, uVr; uniform float uInner, uWidth;
out vec4 o;

vec3 rgb2hsl(vec3 c) {
  float mx = max(c.r, max(c.g, c.b)), mn = min(c.r, min(c.g, c.b));
  float l = (mx + mn) * 0.5;
  if (mx == mn) return vec3(0.0, 0.0, l);
  float d = mx - mn;
  float s = l > 0.5 ? d / (2.0 - mx - mn) : d / (mx + mn);
  float h;
  if (mx == c.r) h = (c.g - c.b) / d + (c.g < c.b ? 6.0 : 0.0);
  else if (mx == c.g) h = (c.b - c.r) / d + 2.0;
  else h = (c.r - c.g) / d + 4.0;
  return vec3(h / 6.0, s, l);
}
float hue2rgb(float p, float q, float t) {
  if (t < 0.0) t += 1.0;
  if (t > 1.0) t -= 1.0;
  if (t < 1.0 / 6.0) return p + (q - p) * 6.0 * t;
  if (t < 0.5) return q;
  if (t < 2.0 / 3.0) return p + (q - p) * (2.0 / 3.0 - t) * 6.0;
  return p;
}
vec3 hsl2rgb(vec3 h) {
  if (h.y == 0.0) return vec3(h.z);
  float q = h.z < 0.5 ? h.z * (1.0 + h.y) : h.z + h.y - h.z * h.y;
  float p = 2.0 * h.z - q;
  return vec3(hue2rgb(p, q, h.x + 1.0 / 3.0), hue2rgb(p, q, h.x), hue2rgb(p, q, h.x - 1.0 / 3.0));
}
float skinWeight(float hDeg, float s, float l) {
  float d = abs(mod(hDeg - 25.0 + 540.0, 360.0) - 180.0);
  float hw = d < 11.0 ? 1.0 : d < 23.0 ? 1.0 - (d - 11.0) / 12.0 : 0.0;
  if (hw == 0.0) return 0.0;
  float sw = s < 0.08 ? 0.0 : s < 0.18 ? (s - 0.08) / 0.1 : s < 0.6 ? 1.0 : s < 0.8 ? (0.8 - s) / 0.2 : 0.0;
  float lw = l < 0.12 ? 0.0 : l < 0.25 ? (l - 0.12) / 0.13 : l < 0.85 ? 1.0 : l < 0.95 ? (0.95 - l) / 0.1 : 0.0;
  return hw * sw * lw;
}
float grainNoise(int x, int y) {
  uint h = uint(x) * 374761393u + uint(y) * 668265263u;
  h = (h ^ (h >> 13u)) * 1274126177u;
  float a = float(h ^ (h >> 16u)) / 4294967296.0;
  h = (h ^ 0x9e3779b9u) * 2246822519u;
  float b = float(h ^ (h >> 15u)) / 4294967296.0;
  return (a + b - 1.0) * 1.2;
}
float luma(vec3 c) { return 0.299 * c.r + 0.587 * c.g + 0.114 * c.b; }
vec3 straight(vec4 c) { return c.a > 0.01 / 255.0 ? c.rgb / c.a : vec3(0.0); }

void main() {
  ivec2 q = ivec2(gl_FragCoord.xy);
  vec4 s = texelFetch(uIn, q, 0);
  vec4 res = vec4(0.0);
  if (s.a > 0.0) {
    vec3 c = pow(s.rgb, vec3(uGamma));
    c = 0.5 + (c - 0.5) * uCf;
    c = (c - uBp) / (uWp - uBp);
    if (uSh != 0.0 || uHl != 0.0) {
      float L = clamp(luma(c), 0.0, 1.0);
      c += uSh * (1.0 - L) * (1.0 - L) + uHl * L * L;
    }
    c *= vec3(uWr, uTg, uWb);
    if (uHshift != 0.0) {
      vec3 h = rgb2hsl(clamp(c, 0.0, 1.0));
      c = hsl2rgb(vec3(mod(h.x + uHshift, 1.0), h.y, h.z));
    }
    if (uSkin != 0.0) {
      vec3 h = rgb2hsl(clamp(c, 0.0, 1.0));
      float w = skinWeight(h.x * 360.0, h.y, h.z);
      if (w > 0.0) {
        float nh = mod(h.x + w * uSkin * (10.0 / 360.0) + 1.0, 1.0);
        float ns = clamp(h.y * (1.0 + w * uSkin * 0.12), 0.0, 1.0);
        c = hsl2rgb(vec3(nh, ns, h.z));
      }
    }
    if (uSat != 1.0 || uVib != 0.0) {
      float l = luma(c);
      float cur = max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b));
      // vibrance leaves skin mostly alone (like Lightroom)
      float v = uVib;
      if (v != 0.0) { vec3 h = rgb2hsl(clamp(c, 0.0, 1.0)); v *= 1.0 - 0.8 * skinWeight(h.x * 360.0, h.y, h.z); }
      float k = uSat * (1.0 + v * (1.0 - min(1.0, cur * 1.5)));
      c = l + (c - l) * k;
    }
    if (uHasSmall == 1) c += uSharp * (s.rgb - straight(texelFetch(uSmall, q, 0)));
    if (uHasLarge == 1) {
      vec2 uv = (vec2(q) + 0.5) / vec2(uSize);
      float L = luma(c);
      c += uClar * 4.0 * L * (1.0 - L) * (s.rgb - straight(texture(uLarge, uv)));
    }
    vec2 dp = vec2(q + uOrigin);
    if (uHasVig == 1) {
      vec2 dv = (dp - uVc) / uVr;
      float tt = smoothstep(uInner - uWidth / 2.0, uInner + uWidth / 2.0, length(dv)) * abs(uVamt);
      if (uVamt > 0.0) c *= 1.0 - tt * 0.9;
      else c += (1.0 - c) * tt * 0.9;
    }
    if (uGrain != 0.0) {
      float L = clamp(luma(c), 0.0, 1.0);
      c += grainNoise(q.x + uOrigin.x, q.y + uOrigin.y) * uGrain * (0.45 + 2.2 * L * (1.0 - L));
    }
    res = vec4(clamp(c, 0.0, 1.0), s.a);
  }
  if (uHasSel == 1) res = mix(s, res, texelFetch(uSel, q, 0).r);
  o = res;
}`;

/* Levels / Curves: per-channel lookup table (256×1, r/g/b in the texture channels), blended with the selection. */
const FS_LUT = `#version 300 es
precision highp float; precision highp int;
uniform sampler2D uIn, uLut, uSel; uniform int uHasSel;
out vec4 o;
void main() {
  ivec2 q = ivec2(gl_FragCoord.xy);
  vec4 s = texelFetch(uIn, q, 0);
  ivec3 i = ivec3(s.rgb * 255.0 + 0.5);
  vec4 res = vec4(texelFetch(uLut, ivec2(i.r, 0), 0).r, texelFetch(uLut, ivec2(i.g, 0), 0).g, texelFetch(uLut, ivec2(i.b, 0), 0).b, s.a);
  if (uHasSel == 1) res = mix(s, res, texelFetch(uSel, q, 0).r);
  o = res;
}`;

/* HSL colour helpers shared by the colour shaders (the same as rgbToHsl / hslToRgb in core/color.ts). */
const COLOR_GLSL = `
vec3 rgb2hsl(vec3 c) {
  float mx = max(c.r, max(c.g, c.b)), mn = min(c.r, min(c.g, c.b));
  float l = (mx + mn) * 0.5;
  if (mx == mn) return vec3(0.0, 0.0, l);
  float d = mx - mn;
  float s = l > 0.5 ? d / (2.0 - mx - mn) : d / (mx + mn);
  float h;
  if (mx == c.r) h = (c.g - c.b) / d + (c.g < c.b ? 6.0 : 0.0);
  else if (mx == c.g) h = (c.b - c.r) / d + 2.0;
  else h = (c.r - c.g) / d + 4.0;
  return vec3(h / 6.0, s, l);
}
float hue2rgb(float p, float q, float t) {
  if (t < 0.0) t += 1.0;
  if (t > 1.0) t -= 1.0;
  if (t < 1.0 / 6.0) return p + (q - p) * 6.0 * t;
  if (t < 0.5) return q;
  if (t < 2.0 / 3.0) return p + (q - p) * (2.0 / 3.0 - t) * 6.0;
  return p;
}
vec3 hsl2rgb(vec3 h) {
  if (h.y == 0.0) return vec3(h.z);
  float q = h.z < 0.5 ? h.z * (1.0 + h.y) : h.z + h.y - h.z * h.y;
  float p = 2.0 * h.z - q;
  return vec3(hue2rgb(p, q, h.x + 1.0 / 3.0), hue2rgb(p, q, h.x), hue2rgb(p, q, h.x - 1.0 / 3.0));
}`;

/* HSL mixer: hslMix() in core/colorgrade.ts. */
const FS_HSL = `#version 300 es
precision highp float; precision highp int;
uniform sampler2D uIn, uSel; uniform int uHasSel;
uniform float uHue[8], uSat[8], uLum[8];
out vec4 o;
${COLOR_GLSL}
const float C[9] = float[9](0.0, 30.0, 60.0, 120.0, 180.0, 225.0, 270.0, 315.0, 360.0);
void main() {
  ivec2 q = ivec2(gl_FragCoord.xy);
  vec4 s = texelFetch(uIn, q, 0);
  vec4 res = s;
  vec3 hsl = rgb2hsl(s.rgb);
  if (hsl.y > 0.0) {
    float hd = mod(hsl.x * 360.0, 360.0);
    float dh = 0.0, ds = 0.0, dl = 0.0;
    for (int i = 0; i < 8; i++) {
      if (hd >= C[i] && hd < C[i + 1]) {
        float t = (hd - C[i]) / (C[i + 1] - C[i]);
        int j = i == 7 ? 0 : i + 1;
        dh = uHue[i] * (1.0 - t) + uHue[j] * t;
        ds = uSat[i] * (1.0 - t) + uSat[j] * t;
        dl = uLum[i] * (1.0 - t) + uLum[j] * t;
      }
    }
    // weight by chroma (as the CPU code in colorgrade.ts): nearly grey dark pixels change little
    float cw = smoothstep(0.04, 0.3, max(s.r, max(s.g, s.b)) - min(s.r, min(s.g, s.b)));
    float h2 = mod(hsl.x + dh / 100.0 * (30.0 / 360.0) * cw + 1.0, 1.0);
    float s2 = clamp(hsl.y * (1.0 + ds / 100.0 * cw), 0.0, 1.0);
    float k = dl / 100.0 * 0.3 * cw;
    float l2 = clamp(k > 0.0 ? hsl.z + (1.0 - hsl.z) * k : hsl.z + hsl.z * k, 0.0, 1.0);
    res = vec4(hsl2rgb(vec3(h2, s2, l2)), s.a);
  }
  if (uHasSel == 1) res = mix(s, res, texelFetch(uSel, q, 0).r);
  o = res;
}`;

/* Toning: splitTone() in core/colorgrade.ts. */
const FS_TONE = `#version 300 es
precision highp float; precision highp int;
uniform sampler2D uIn, uSel; uniform int uHasSel;
uniform vec3 uTS, uTH; uniform float uAS, uAH, uMid;
out vec4 o;
void main() {
  ivec2 q = ivec2(gl_FragCoord.xy);
  vec4 s = texelFetch(uIn, q, 0);
  float L = dot(s.rgb, vec3(0.299, 0.587, 0.114));
  float t = smoothstep(uMid - 0.3, uMid + 0.3, L);
  float fade = clamp(L * 5.0, 0.0, 1.0) * clamp((1.0 - L) * 5.0, 0.0, 1.0);
  vec3 c = s.rgb + uTS * (uAS * (1.0 - t) * fade) + uTH * (uAH * t * fade);
  vec4 res = vec4(clamp(c, 0.0, 1.0), s.a);
  if (uHasSel == 1) res = mix(s, res, texelFetch(uSel, q, 0).r);
  o = res;
}`;

/* Screen output: the result (the original left of the before/after line), flipped and premultiplied for drawImage. */
const FS_SHOW = `#version 300 es
precision highp float; precision highp int;
uniform sampler2D uIn, uBase; uniform ivec2 uSize; uniform float uSplit;
out vec4 o;
void main() {
  ivec2 q = ivec2(int(gl_FragCoord.x), uSize.y - 1 - int(gl_FragCoord.y));
  vec4 r = float(q.x) < uSplit ? texelFetch(uBase, q, 0) : texelFetch(uIn, q, 0);
  o = vec4(r.rgb * r.a, r.a);
}`;

interface Prog { p: WebGLProgram; u: Record<string, WebGLUniformLocation | null> }
interface GL {
  canvas: HTMLCanvasElement; gl: WebGL2RenderingContext;
  enh: Prog; lut: Prog; hsl: Prog; tone: Prog; show: Prog; blur: Prog; down: Prog;
  premul: Prog; avg2: Prog; glowMask: Prog; fxOut: Prog; simple: Prog; cell: Prog;
  /** internal format for the wide blur: half float when it can be rendered to */
  fmt: { internal: number; type: number };
  maxSize: number;
  fbo: WebGLFramebuffer;
}
let shared: GL | null | undefined;

function init(): GL | null {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2', { premultipliedAlpha: true, preserveDrawingBuffer: true, antialias: false, alpha: true, depth: false, stencil: false });
    if (!gl) return null;
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!; gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader');
      return s;
    };
    const vs = sh(gl.VERTEX_SHADER, VS);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const prog = (fs: string, names: string[]): Prog => {
      const p = gl.createProgram()!;
      gl.attachShader(p, vs); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
      gl.bindAttribLocation(p, 0, 'p');
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || 'link');
      const u: Prog['u'] = {};
      for (const n of names) u[n] = gl.getUniformLocation(p, n);
      return { p, u };
    };
    const enh = prog(FS_ENH, ['uIn', 'uSmall', 'uLarge', 'uSel', 'uSize', 'uOrigin', 'uHasSel', 'uHasSmall', 'uHasLarge', 'uHasVig',
      'uGamma', 'uCf', 'uBp', 'uWp', 'uSh', 'uHl', 'uWr', 'uWb', 'uTg', 'uHshift', 'uSkin', 'uSat', 'uVib', 'uSharp', 'uClar', 'uGrain', 'uVamt', 'uVc', 'uVr', 'uInner', 'uWidth']);
    const lut = prog(FS_LUT, ['uIn', 'uLut', 'uSel', 'uHasSel']);
    const hsl = prog(FS_HSL, ['uIn', 'uSel', 'uHasSel', 'uHue', 'uSat', 'uLum']);
    const tone = prog(FS_TONE, ['uIn', 'uSel', 'uHasSel', 'uTS', 'uTH', 'uAS', 'uAH', 'uMid']);
    const show = prog(FS_SHOW, ['uIn', 'uBase', 'uSize', 'uSplit']);
    const blur = prog(FS_BLUR, ['uIn', 'uSize', 'uDir', 'uSigma', 'uPremul']);
    const down = prog(FS_DOWN, ['uIn', 'uSize', 'uF']);
    const premul = prog(FS_PREMUL, ['uIn']);
    const avg2 = prog(FS_AVG2, ['uIn', 'uSize', 'uMode', 'uOff', 'uC', 'uS', 'uCos', 'uSin']);
    const glowMask = prog(FS_GLOWMASK, ['uIn', 'uThr']);
    const fxOut = prog(FS_FXOUT, ['uIn', 'uSrc', 'uSel', 'uSize', 'uMode', 'uHasSel', 'uKeep', 'uA', 'uB', 'uTint']);
    const cell = prog(FS_CELL, ['uIn', 'uSrcSize', 'uDir', 'uF', 'uPremul']);
    const simple = prog(FS_SIMPLE, ['uIn', 'uSel', 'uAux', 'uSize', 'uOp', 'uHasSel', 'uI0', 'uF0', 'uF1', 'uF2', 'uC', 'uStopC', 'uStopP']);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
    const half = !!gl.getExtension('EXT_color_buffer_float') || !!gl.getExtension('EXT_color_buffer_half_float');
    const fmt = half ? { internal: gl.RGBA16F, type: gl.HALF_FLOAT } : { internal: gl.RGBA8, type: gl.UNSIGNED_BYTE };
    const vp = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array;
    const maxSize = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE) as number, gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number, vp[0], vp[1]);
    canvas.addEventListener('webglcontextlost', () => { shared = undefined; });
    return { canvas, gl, enh, lut, hsl, tone, show, blur, down, premul, avg2, glowMask, fxOut, simple, cell, fmt, maxSize, fbo: gl.createFramebuffer()! };
  } catch (e) {
    console.warn('PhotoPane: GPU adjustments unavailable', e);
    return null;
  }
}

export class GpuChain {
  private base: WebGLTexture;
  private sel: WebGLTexture | null = null;
  private a: WebGLTexture | null = null;
  private b: WebGLTexture | null = null;
  private lutTex: WebGLTexture;
  /** blurred copies for sharpness/clarity, valid for the input named by the key */
  private small: WebGLTexture | null = null;
  private large: WebGLTexture | null = null;
  private smallKey = '';
  private largeKey = '';
  private textures = new Set<WebGLTexture>();
  private disposed = false;
  /** full-size working pair for the filters (premultiplied, half float where possible), made on first use */
  private fa: WebGLTexture | null = null;
  private fb: WebGLTexture | null = null;
  /** working textures kept by role and size: creating them on every slider move cost more than the filter */
  private scratch = new Map<string, WebGLTexture>();
  private tmp(role: string, w: number, h: number, filter: number, eightBit = false): WebGLTexture {
    const { gl, fmt } = this.st;
    const key = `${role}:${w}x${h}:${filter}:${eightBit ? 8 : 16}`;
    let t = this.scratch.get(key);
    if (t) { this.scratch.delete(key); this.scratch.set(key, t); return t; }
    t = eightBit ? this.rgba8(w, h, filter) : this.texture(fmt.internal, w, h, gl.RGBA, fmt.type, null, filter);
    this.scratch.set(key, t);
    // a dragged radius makes new sizes: keep the most recent few
    while (this.scratch.size > 8) { const [k, old] = this.scratch.entries().next().value!; this.scratch.delete(k); this.free(old); }
    return t;
  }

  static create(w: number, h: number, ox: number, oy: number, sel: Uint8Array | null): GpuChain | null {
    if (shared === undefined) shared = init();
    const st = shared;
    if (!st || st.gl.isContextLost() || w > st.maxSize || h > st.maxSize) return null;
    try { return new GpuChain(st, w, h, ox, oy, sel); }
    catch (e) { console.warn('PhotoPane: GPU adjustments unavailable', e); return null; }
  }

  private constructor(private st: GL, readonly w: number, readonly h: number, private ox: number, private oy: number, sel: Uint8Array | null) {
    const gl = st.gl;
    this.base = this.texture(gl.RGBA8, w, h, gl.RGBA, gl.UNSIGNED_BYTE, null, gl.NEAREST);
    if (sel) this.sel = this.texture(gl.R8, w, h, gl.RED, gl.UNSIGNED_BYTE, sel, gl.NEAREST);
    this.lutTex = this.texture(gl.RGBA8, 256, 1, gl.RGBA, gl.UNSIGNED_BYTE, null, gl.NEAREST);
    if (gl.getError() === gl.OUT_OF_MEMORY) throw new Error('out of GPU memory');
  }

  get ok() { return !this.disposed && !this.st.gl.isContextLost() && shared === this.st; }

  private texture(internal: number, w: number, h: number, format: number, type: number, data: ArrayBufferView | null, filter: number): WebGLTexture {
    const gl = this.st.gl;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, data);
    this.textures.add(t);
    return t;
  }
  private free(t: WebGLTexture | null) { if (t) { this.st.gl.deleteTexture(t); this.textures.delete(t); } }
  private rgba8(w = this.w, h = this.h, filter: number = this.st.gl.NEAREST) {
    const gl = this.st.gl;
    return this.texture(gl.RGBA8, w, h, gl.RGBA, gl.UNSIGNED_BYTE, null, filter);
  }

  /** The chain input (the layer as committed so far), straight RGBA. */
  setBase(data: Uint8ClampedArray) {
    const gl = this.st.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.base);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, this.w, this.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
  }

  /** A full-screen pass of `prog` into texture `out` (null = the canvas), sized w×h. */
  private pass(prog: Prog, out: WebGLTexture | null, w: number, h: number, inputs: [string, WebGLTexture][], set: (u: Prog['u']) => void) {
    const gl = this.st.gl;
    gl.useProgram(prog.p);
    if (out) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.st.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, out, 0);
    } else gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    inputs.forEach(([name, tex], i) => { gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, tex); gl.uniform1i(prog.u[name], i); });
    set(prog.u);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** Two-pass Gaussian of `input` into a new texture; `premul` when the input is straight alpha. */
  private gauss(input: WebGLTexture, w: number, h: number, sigma: number, premul: boolean, eightBit: boolean, filter: number): WebGLTexture {
    const { gl, blur, fmt } = this.st;
    const mk = () => eightBit ? this.rgba8(w, h, filter) : this.texture(fmt.internal, w, h, gl.RGBA, fmt.type, null, filter);
    const tmp = mk(), out = mk();
    this.pass(blur, tmp, w, h, [['uIn', input]], u => { gl.uniform2i(u.uSize, w, h); gl.uniform2i(u.uDir, 1, 0); gl.uniform1f(u.uSigma, sigma); gl.uniform1i(u.uPremul, premul ? 1 : 0); });
    this.pass(blur, out, w, h, [['uIn', tmp]], u => { gl.uniform2i(u.uSize, w, h); gl.uniform2i(u.uDir, 0, 1); gl.uniform1f(u.uSigma, sigma); gl.uniform1i(u.uPremul, 0); });
    this.free(tmp);
    return out;
  }

  /** Fine blur for sharpness (as the CPU version, 8-bit like its result). */
  private getSmall(input: WebGLTexture, key: string) {
    if (this.small && this.smallKey === key) return this.small;
    this.free(this.small);
    this.small = this.gauss(input, this.w, this.h, 1.2, true, true, this.st.gl.NEAREST);
    this.smallKey = key;
    return this.small;
  }

  /** Wide blur for clarity on a reduced copy (very smooth anyway), sampled bilinearly. */
  private getLarge(input: WebGLTexture, key: string) {
    if (this.large && this.largeKey === key) return this.large;
    this.free(this.large);
    const { gl, down, fmt } = this.st;
    const { w, h } = this;
    const sigma = Math.max(8, Math.min(60, Math.max(w, h) / 60));
    const f = Math.max(1, Math.floor(sigma / 4));
    const lw = Math.ceil(w / f), lh = Math.ceil(h / f);
    const reduced = this.texture(fmt.internal, lw, lh, gl.RGBA, fmt.type, null, gl.NEAREST);
    this.pass(down, reduced, lw, lh, [['uIn', input]], u => { gl.uniform2i(u.uSize, w, h); gl.uniform1i(u.uF, f); });
    // the box average already blurs by f²/12; the Gaussian adds the rest
    this.large = this.gauss(reduced, lw, lh, Math.sqrt(Math.max(0.25, sigma * sigma - f * f / 12)) / f, false, false, gl.LINEAR);
    this.free(reduced);
    this.largeKey = key;
    return this.large;
  }

  private work(): [WebGLTexture, WebGLTexture] {
    const { gl, fmt } = this.st;
    this.fa ??= this.texture(fmt.internal, this.w, this.h, gl.RGBA, fmt.type, null, gl.LINEAR);
    this.fb ??= this.texture(fmt.internal, this.w, this.h, gl.RGBA, fmt.type, null, gl.LINEAR);
    return [this.fa, this.fb];
  }

  /**
   * Gaussian of a straight-alpha texture, premultiplied out. Large radii run on a reduced copy (a box
   * average then a smaller Gaussian, sampled back bilinearly): the same look, a few taps instead of hundreds.
   * Returns the texture, its size, and whether the caller must free it.
   */
  private fxGauss(src: WebGLTexture, sigma: number): { tex: WebGLTexture; own: boolean } {
    const { gl, blur, down, fmt } = this.st;
    const { w, h } = this;
    const [fa, fb] = this.work();
    if (sigma < 0.3) {
      this.pass(this.st.premul, fb, w, h, [['uIn', src]], () => {});
      return { tex: fb, own: false };
    }
    const f = sigma > 4 ? Math.max(1, Math.floor(sigma / 2.5)) : 1;
    if (f === 1) {
      this.pass(blur, fa, w, h, [['uIn', src]], u => { gl.uniform2i(u.uSize, w, h); gl.uniform2i(u.uDir, 1, 0); gl.uniform1f(u.uSigma, sigma); gl.uniform1i(u.uPremul, 1); });
      this.pass(blur, fb, w, h, [['uIn', fa]], u => { gl.uniform2i(u.uSize, w, h); gl.uniform2i(u.uDir, 0, 1); gl.uniform1f(u.uSigma, sigma); gl.uniform1i(u.uPremul, 0); });
      return { tex: fb, own: false };
    }
    const lw = Math.ceil(w / f), lh = Math.ceil(h / f);
    const reduced = this.tmp('red', lw, lh, gl.NEAREST);
    this.pass(down, reduced, lw, lh, [['uIn', src]], u => { gl.uniform2i(u.uSize, w, h); gl.uniform1i(u.uF, f); });
    // the box average already blurs by f²/12; the Gaussian adds the rest
    const s2 = Math.sqrt(Math.max(0.25, sigma * sigma - f * f / 12)) / f;
    const t1 = this.tmp('redH', lw, lh, gl.NEAREST), out = this.tmp('redV', lw, lh, gl.LINEAR);
    this.pass(blur, t1, lw, lh, [['uIn', reduced]], u => { gl.uniform2i(u.uSize, lw, lh); gl.uniform2i(u.uDir, 1, 0); gl.uniform1f(u.uSigma, s2); gl.uniform1i(u.uPremul, 0); });
    this.pass(blur, out, lw, lh, [['uIn', t1]], u => { gl.uniform2i(u.uSize, lw, lh); gl.uniform2i(u.uDir, 0, 1); gl.uniform1f(u.uSigma, s2); gl.uniform1i(u.uPremul, 0); });
    void fmt;
    return { tex: out, own: false };
  }

  /** A filter job on the GPU from straight-alpha `input` into `out` (straight RGBA8), blended with the selection. */
  private fx(job: FxJob, keep: boolean, input: WebGLTexture, out: WebGLTexture) {
    const { gl } = this.st;
    const { w, h } = this;
    const op = job[0];
    const num = (i: number) => Number(job[i]) || 0;
    if (op in SIMPLE_OP || op === 'pixelate') { this.simple(job, input, out); return; }
    const finish = (blurred: WebGLTexture, mode: number, a = 0, b = 0, tint: [number, number, number] = [1, 1, 1]) => {
      this.pass(this.st.fxOut, out, w, h, [['uIn', blurred], ['uSrc', input], ['uSel', this.sel ?? input]], u => {
        gl.uniform2i(u.uSize, w, h); gl.uniform1i(u.uMode, mode); gl.uniform1i(u.uHasSel, this.sel ? 1 : 0); gl.uniform1i(u.uKeep, keep ? 1 : 0);
        gl.uniform1f(u.uA, a); gl.uniform1f(u.uB, b); gl.uniform3f(u.uTint, tint[0], tint[1], tint[2]);
      });
    };
    if (op === 'gaussian' || op === 'unsharp' || op === 'highPass') {
      const sigma = op === 'unsharp' ? num(2) : num(1);
      const g = this.fxGauss(input, sigma);
      if (op === 'gaussian') finish(g.tex, 0);
      else if (op === 'unsharp') finish(g.tex, 1, num(1) / 100, num(3));
      else finish(g.tex, 2);
      if (g.own) this.free(g.tex);
      return;
    }
    if (op === 'glow') {
      // the bright parts, blurred, screened over the picture (glow() in core/fx.ts)
      const mask = this.tmp('glow', w, h, gl.NEAREST, true);
      this.pass(this.st.glowMask, mask, w, h, [['uIn', input]], u => gl.uniform1f(u.uThr, num(1) / 255));
      const g = this.fxGauss(mask, num(2));
      finish(g.tex, 3, num(3) / 100, 0, job[4] ? [1, 0.62, 0.42] : [1, 1, 1]);
      if (g.own) this.free(g.tex);
      return;
    }
    // motion / radial blur: halving steps over the premultiplied picture, ping-pong between the working pair
    const [fa, fb] = this.work();
    this.pass(this.st.premul, fa, w, h, [['uIn', input]], () => {});
    let src = fa, dst = fb;
    const step = (set: (u: Prog['u']) => void) => {
      this.pass(this.st.avg2, dst, w, h, [['uIn', src]], u => { gl.uniform2i(u.uSize, w, h); set(u); });
      const t = src; src = dst; dst = t;
    };
    if (op === 'motionBlur') {
      const an = num(1) * Math.PI / 180, dist = num(2);
      const dx = Math.cos(an), dy = -Math.sin(an);
      for (let st = dist / 4; st >= 0.35; st /= 2) step(u => { gl.uniform1i(u.uMode, 0); gl.uniform2f(u.uOff, dx * st, dy * st); });
    } else {
      const cx = num(1), cy = num(2), amount = num(3), mode = job[4] === 'spin' ? 2 : 1;
      const R = Math.hypot(Math.max(cx, w - cx), Math.max(cy, h - cy));
      for (let st = mode === 1 ? amount / 100 * 0.2 : amount / 100 * (20 * Math.PI / 180); st * R >= 0.5; st /= 2) {
        step(u => { gl.uniform1i(u.uMode, mode); gl.uniform2f(u.uC, cx, cy); gl.uniform1f(u.uS, st); gl.uniform1f(u.uCos, Math.cos(st)); gl.uniform1f(u.uSin, Math.sin(st)); });
      }
    }
    finish(src, 0);
  }

  /** The simple filters (FS_SIMPLE), with the cell averages for Pixelate and the premultiplied picture for Chromatic. */
  private simple(job: FxJob, input: WebGLTexture, out: WebGLTexture) {
    const { gl } = this.st;
    const { w, h } = this;
    const op = job[0];
    const num = (i: number) => Number(job[i]) || 0;
    let aux: WebGLTexture = input, own: WebGLTexture | null = null;
    let opNo = SIMPLE_OP[op] ?? 6, i0 = 0, f0 = 0, f1 = 0, cx = 0, cy = 0;
    if (op === 'invert' || op === 'desaturate' || op === 'sepia' || op === 'findEdges') f0 = num(1) / 100;
    else if (op === 'posterize') f0 = Math.max(2, Math.min(255, Math.round(num(1))));
    else if (op === 'threshold') f0 = num(1);
    else if (op === 'noise') { f0 = num(1) / 100 * (job[2] ? 0.5 : 1); f1 = job[3] ? 1 : 0; i0 = job[2] ? 1 : 0; }
    else if (op === 'pixelate') {
      // cell averages (alpha-weighted, as pixelate() in core/fx.ts) on a reduced copy, read back per cell
      const cell = Math.max(2, Math.round(num(1)));
      const lw = Math.ceil(w / cell), lh = Math.ceil(h / cell);
      const fmt = this.st.fmt;
      void fmt;
      const rows = this.tmp('rows', lw, h, gl.NEAREST);
      const cells = this.tmp('cells', lw, lh, gl.NEAREST);
      this.pass(this.st.cell, rows, lw, h, [['uIn', input]], u => { gl.uniform2i(u.uSrcSize, w, h); gl.uniform2i(u.uDir, 1, 0); gl.uniform1i(u.uF, cell); gl.uniform1i(u.uPremul, 1); });
      this.pass(this.st.cell, cells, lw, lh, [['uIn', rows]], u => { gl.uniform2i(u.uSrcSize, lw, h); gl.uniform2i(u.uDir, 0, 1); gl.uniform1i(u.uF, cell); gl.uniform1i(u.uPremul, 0); });
      aux = cells; i0 = cell; opNo = 6;
    } else if (op === 'chromatic') {
      const [fa] = this.work();
      this.pass(this.st.premul, fa, w, h, [['uIn', input]], () => {});
      aux = fa; f0 = num(1) / 100 * 0.012; cx = num(2); cy = num(3);
    } else if (op === 'emboss') {
      const an = num(1) * Math.PI / 180;
      cx = Math.cos(an) * num(2); cy = -Math.sin(an) * num(2); f0 = num(3) / 100; i0 = job[4] ? 1 : 0;
    }
    this.pass(this.st.simple, out, w, h, [['uIn', input], ['uSel', this.sel ?? input], ['uAux', aux]], u => {
      gl.uniform2i(u.uSize, w, h); gl.uniform1i(u.uOp, opNo); gl.uniform1i(u.uHasSel, this.sel ? 1 : 0);
      gl.uniform1i(u.uI0, i0); gl.uniform1f(u.uF0, f0); gl.uniform1f(u.uF1, f1); gl.uniform1f(u.uF2, 0); gl.uniform2f(u.uC, cx, cy);
      if (op === 'sepia') {
        // SEPIA_STOPS in core/fx.ts
        gl.uniform3fv(u.uStopC, new Float32Array([38, 22, 12, 160, 112, 70, 246, 232, 206]));
        gl.uniform1fv(u.uStopP, new Float32Array([0, 0.55, 1]));
      }
    });
    if (own) this.free(own);
  }

  /** One stage from texture `input` (named `key` for the blur cache) into `out`. */
  private stage(d: GpuStageDesc, input: WebGLTexture, key: string, out: WebGLTexture, docW: number, docH: number) {
    const { gl } = this.st;
    const sel = this.sel ?? input;
    if (d.kind === 'fx') { this.fx(d.job, d.keep, input, out); return; }
    if (d.kind === 'hsl') {
      const p = d.p;
      this.pass(this.st.hsl, out, this.w, this.h, [['uIn', input], ['uSel', sel]], u => {
        gl.uniform1i(u.uHasSel, this.sel ? 1 : 0);
        gl.uniform1fv(u.uHue, new Float32Array(p.hue)); gl.uniform1fv(u.uSat, new Float32Array(p.sat)); gl.uniform1fv(u.uLum, new Float32Array(p.lum));
      });
      return;
    }
    if (d.kind === 'tone') {
      const p = d.p, ts = tintChroma(p.shHue), th = tintChroma(p.hiHue);
      this.pass(this.st.tone, out, this.w, this.h, [['uIn', input], ['uSel', sel]], u => {
        gl.uniform1i(u.uHasSel, this.sel ? 1 : 0);
        gl.uniform3f(u.uTS, ts[0], ts[1], ts[2]); gl.uniform3f(u.uTH, th[0], th[1], th[2]);
        gl.uniform1f(u.uAS, p.shSat / 100 * 0.35); gl.uniform1f(u.uAH, p.hiSat / 100 * 0.35);
        gl.uniform1f(u.uMid, 0.5 - p.balance / 100 * 0.3);
      });
      return;
    }
    if (d.kind === 'lut') {
      const data = new Uint8Array(256 * 4);
      for (let i = 0; i < 256; i++) { data[i * 4] = d.r[i]; data[i * 4 + 1] = d.g[i]; data[i * 4 + 2] = d.b[i]; data[i * 4 + 3] = 255; }
      gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
      this.pass(this.st.lut, out, this.w, this.h, [['uIn', input], ['uLut', this.lutTex], ['uSel', sel]], u => gl.uniform1i(u.uHasSel, this.sel ? 1 : 0));
      return;
    }
    const p = d.p;
    const sharp = p.sharpness / 100 * 1.6, clar = p.clarity / 100 * 0.7;
    const small = sharp ? this.getSmall(input, key) : null;
    const large = clar ? this.getLarge(input, key) : null;
    this.pass(this.st.enh, out, this.w, this.h, [['uIn', input], ['uSmall', small ?? input], ['uLarge', large ?? input], ['uSel', sel]], u => {
      gl.uniform2i(u.uSize, this.w, this.h);
      gl.uniform2i(u.uOrigin, this.ox, this.oy);
      gl.uniform1i(u.uHasSel, this.sel ? 1 : 0);
      gl.uniform1i(u.uHasSmall, small ? 1 : 0);
      gl.uniform1i(u.uHasLarge, large ? 1 : 0);
      // the same constants as enhance()
      gl.uniform1f(u.uGamma, Math.pow(2, -p.brightness / 100));
      gl.uniform1f(u.uCf, p.contrast >= 0 ? 1 + (p.contrast / 100) * 1.2 : 1 + (p.contrast / 100) * 0.8);
      gl.uniform1f(u.uBp, -(p.blacks / 100) * 0.15);
      gl.uniform1f(u.uWp, 1 - (p.whites / 100) * 0.15);
      gl.uniform1f(u.uSh, p.shadows / 100 * 0.4);
      gl.uniform1f(u.uHl, p.highlights / 100 * 0.4);
      gl.uniform1f(u.uWr, 1 + p.warmth / 100 * 0.12);
      gl.uniform1f(u.uWb, 1 - p.warmth / 100 * 0.12);
      gl.uniform1f(u.uTg, 1 - p.tint / 100 * 0.1);
      gl.uniform1f(u.uHshift, ((p.hue % 360) + 360) % 360 / 360);
      gl.uniform1f(u.uSkin, p.skin / 100);
      gl.uniform1f(u.uSat, 1 + p.saturation / 100);
      gl.uniform1f(u.uVib, p.vibrance / 100 * 1.3);
      gl.uniform1f(u.uSharp, sharp);
      gl.uniform1f(u.uClar, clar);
      gl.uniform1f(u.uGrain, p.grain / 100 * 0.16);
      gl.uniform1f(u.uVamt, p.vignette / 100);
      gl.uniform1i(u.uHasVig, p.vignette ? 1 : 0);
      if (p.vignette) {
        // vignetteFn() in core/adjust.ts
        const r = (p.vigRoundness + 100) / 200;
        const ar = Math.sqrt(docW * docH) / 2;
        gl.uniform2f(u.uVc, docW / 2, docH / 2);
        gl.uniform2f(u.uVr, (docW / 2) * (1 - r) + ar * r, (docH / 2) * (1 - r) + ar * r);
        gl.uniform1f(u.uInner, 0.2 + (p.vigMidpoint / 100) * 0.9);
        gl.uniform1f(u.uWidth, 0.05 + (p.vigFeather / 100) * 1.1);
      }
    });
  }

  /**
   * Run `stages` on the base and draw the result for the screen, with the original left of `split`
   * (layer x; null = off). Returns the canvas to draw into the layer, or null if the GPU is gone.
   */
  display(stages: { d: GpuStageDesc; key: string }[], baseKey: string, split: number | null, docW: number, docH: number): HTMLCanvasElement | null {
    if (!this.ok) return null;
    const { gl, canvas } = this.st;
    let input = this.base, key = baseKey;
    stages.forEach((s, i) => {
      const out = i % 2 === 0 ? (this.a ??= this.rgba8()) : (this.b ??= this.rgba8());
      this.stage(s.d, input, key, out, docW, docH);
      input = out; key = s.key;
    });
    if (canvas.width !== this.w || canvas.height !== this.h) { canvas.width = this.w; canvas.height = this.h; }
    if (gl.drawingBufferWidth !== this.w || gl.drawingBufferHeight !== this.h) return null;
    this.pass(this.st.show, null, this.w, this.h, [['uIn', input], ['uBase', this.base]], u => {
      gl.uniform2i(u.uSize, this.w, this.h);
      gl.uniform1f(u.uSplit, split == null ? -1 : split);
    });
    return canvas;
  }

  /** Run one stage on CPU-side pixels (straight RGBA); the result, or null if the GPU is gone. */
  run(d: GpuStageDesc, input: Uint8ClampedArray, docW: number, docH: number): Uint8ClampedArray | null {
    if (!this.ok) return null;
    const gl = this.st.gl;
    const src = this.rgba8();
    gl.bindTexture(gl.TEXTURE_2D, src);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, this.w, this.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, input);
    const out = (this.a ??= this.rgba8());
    this.stage(d, src, 'run', out, docW, docH);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.st.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, out, 0);
    const res = new Uint8ClampedArray(this.w * this.h * 4);
    gl.readPixels(0, 0, this.w, this.h, gl.RGBA, gl.UNSIGNED_BYTE, res);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.free(src);
    // the blurs were made from that one-off input
    this.smallKey = this.largeKey = '';
    return gl.isContextLost() ? null : res;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    const gl = this.st.gl;
    for (const t of this.textures) gl.deleteTexture(t);
    this.textures.clear();
    // give the large drawing buffer back
    this.st.canvas.width = this.st.canvas.height = 1;
  }
}
