/**
 * The Adjust dialog on the GPU. The CPU version of `enhance()` takes seconds per change on a 24 MP photo
 * (and the blurred copies for sharpness/clarity several more), which makes the sliders and the
 * before/after line stutter. Here the same per-pixel maths runs in a WebGL2 fragment shader, together with
 * the selection blend and the before/after split, and the result is drawn straight into the layer.
 * Preview and the final result come from the same shader, so OK gives exactly what was shown.
 * Returns null where WebGL2 is missing or the layer is too large; the caller then uses the CPU path.
 */
import type { AdjustSession, EnhanceParams } from './adjust';

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

/* The per-pixel part of enhance() in core/adjust.ts, step for step. */
const FS_MAIN = `#version 300 es
precision highp float; precision highp int;
uniform sampler2D uSrc, uSmall, uLarge, uSel;
uniform ivec2 uSize; uniform ivec2 uOrigin; uniform int uFlip; uniform float uSplit;
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
  int x = int(gl_FragCoord.x);
  int y = uFlip == 1 ? uSize.y - 1 - int(gl_FragCoord.y) : int(gl_FragCoord.y);
  ivec2 q = ivec2(x, y);
  vec4 s = texelFetch(uSrc, q, 0);
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
      float k = uSat * (1.0 + uVib * (1.0 - min(1.0, cur * 1.5)));
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
  if (float(x) < uSplit) res = s;
  if (uHasSel == 1) res = mix(s, res, texelFetch(uSel, q, 0).r);
  o = vec4(res.rgb * res.a, res.a);
}`;

interface Prog { p: WebGLProgram; u: Record<string, WebGLUniformLocation | null> }
interface GL {
  canvas: HTMLCanvasElement; gl: WebGL2RenderingContext;
  main: Prog; blur: Prog; down: Prog;
  /** internal format for blurred copies: half float when it can be rendered to */
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
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
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
    const main = prog(FS_MAIN, ['uSrc', 'uSmall', 'uLarge', 'uSel', 'uSize', 'uOrigin', 'uFlip', 'uSplit', 'uHasSel', 'uHasSmall', 'uHasLarge', 'uHasVig',
      'uGamma', 'uCf', 'uBp', 'uWp', 'uSh', 'uHl', 'uWr', 'uWb', 'uTg', 'uHshift', 'uSkin', 'uSat', 'uVib', 'uSharp', 'uClar', 'uGrain', 'uVamt', 'uVc', 'uVr', 'uInner', 'uWidth']);
    const blur = prog(FS_BLUR, ['uIn', 'uSize', 'uDir', 'uSigma', 'uPremul']);
    const down = prog(FS_DOWN, ['uIn', 'uSize', 'uF']);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    const half = !!gl.getExtension('EXT_color_buffer_float') || !!gl.getExtension('EXT_color_buffer_half_float');
    const fmt = half ? { internal: gl.RGBA16F, type: gl.HALF_FLOAT } : { internal: gl.RGBA8, type: gl.UNSIGNED_BYTE };
    const vp = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array;
    const maxSize = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE) as number, gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number, vp[0], vp[1]);
    canvas.addEventListener('webglcontextlost', () => { shared = undefined; });
    return { canvas, gl, main, blur, down, fmt, maxSize, fbo: gl.createFramebuffer()! };
  } catch (e) {
    console.warn('PhotoPane: GPU adjustments unavailable', e);
    return null;
  }
}

export class EnhanceGPU {
  private src: WebGLTexture;
  private sel: WebGLTexture | null = null;
  private small: WebGLTexture | null = null;
  private large: WebGLTexture | null = null;
  private temps: WebGLTexture[] = [];
  private disposed = false;

  static create(s: AdjustSession): EnhanceGPU | null {
    if (shared === undefined) shared = init();
    const st = shared;
    if (!st || st.gl.isContextLost() || s.w > st.maxSize || s.h > st.maxSize) return null;
    try { return new EnhanceGPU(st, s); }
    catch (e) { console.warn('PhotoPane: GPU adjustments unavailable', e); return null; }
  }

  private constructor(private st: GL, private s: AdjustSession) {
    const gl = st.gl;
    this.src = this.texture(gl.RGBA8, s.w, s.h, gl.RGBA, gl.UNSIGNED_BYTE, s.orig.data, gl.NEAREST);
    if (s.sel) this.sel = this.texture(gl.R8, s.w, s.h, gl.RED, gl.UNSIGNED_BYTE, s.sel, gl.NEAREST);
    if (gl.getError() === gl.OUT_OF_MEMORY) throw new Error('out of GPU memory');
  }

  private texture(internal: number, w: number, h: number, format: number, type: number, data: ArrayBufferView | null, filter: number): WebGLTexture {
    const gl = this.st.gl;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, data);
    this.temps.push(t);
    return t;
  }

  /** Render target; 8-bit for full-size copies (half float would double the memory of a 24 MP layer). */
  private target(w: number, h: number, filter: number, eightBit = false): WebGLTexture {
    const { gl, fmt } = this.st;
    return eightBit ? this.texture(gl.RGBA8, w, h, gl.RGBA, gl.UNSIGNED_BYTE, null, filter) : this.texture(fmt.internal, w, h, gl.RGBA, fmt.type, null, filter);
  }

  private free(t: WebGLTexture) {
    this.st.gl.deleteTexture(t);
    this.temps = this.temps.filter(x => x !== t);
  }

  /** Draw a full-screen pass of `prog` into texture `out` (w×h). */
  private pass(prog: Prog, out: WebGLTexture, w: number, h: number, input: WebGLTexture, set: (u: Prog['u']) => void) {
    const gl = this.st.gl;
    gl.useProgram(prog.p);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.st.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, out, 0);
    gl.viewport(0, 0, w, h);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, input);
    gl.uniform1i(prog.u.uIn, 0);
    set(prog.u);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** Two-pass Gaussian of `input` (w×h) into a new texture; `premul` when the input is the straight-alpha source. */
  private gauss(input: WebGLTexture, w: number, h: number, sigma: number, premul: boolean, filter: number, eightBit = false): WebGLTexture {
    const { blur } = this.st;
    const tmp = this.target(w, h, this.st.gl.NEAREST, eightBit), out = this.target(w, h, filter, eightBit);
    this.pass(blur, tmp, w, h, input, u => { const gl = this.st.gl; gl.uniform2i(u.uSize, w, h); gl.uniform2i(u.uDir, 1, 0); gl.uniform1f(u.uSigma, sigma); gl.uniform1i(u.uPremul, premul ? 1 : 0); });
    this.pass(blur, out, w, h, tmp, u => { const gl = this.st.gl; gl.uniform2i(u.uSize, w, h); gl.uniform2i(u.uDir, 0, 1); gl.uniform1f(u.uSigma, sigma); gl.uniform1i(u.uPremul, 0); });
    this.free(tmp);
    return out;
  }

  /** Fine blur for sharpness (same radius as the CPU version, 8-bit like its result). */
  private getSmall() {
    return (this.small ??= this.gauss(this.src, this.s.w, this.s.h, 1.2, true, this.st.gl.NEAREST, true));
  }

  /** Wide blur for clarity: computed on a reduced copy (it is very smooth anyway) and sampled bilinearly. */
  private getLarge() {
    if (this.large) return this.large;
    const { gl, down } = this.st;
    const { w, h } = this.s;
    const sigma = Math.max(8, Math.min(60, Math.max(w, h) / 60));
    const f = Math.max(1, Math.floor(sigma / 4));
    const lw = Math.ceil(w / f), lh = Math.ceil(h / f);
    const reduced = this.target(lw, lh, gl.NEAREST);
    this.pass(down, reduced, lw, lh, this.src, u => { gl.uniform2i(u.uSize, w, h); gl.uniform1i(u.uF, f); });
    // the box average already blurs by f²/12; the Gaussian adds the rest
    this.large = this.gauss(reduced, lw, lh, Math.sqrt(Math.max(0.25, sigma * sigma - f * f / 12)) / f, false, gl.LINEAR);
    this.free(reduced);
    return this.large;
  }

  /**
   * Render the adjusted layer (premultiplied) into the shared WebGL canvas and return it,
   * or null if the GPU went away. `split` is the before/after line in document x (null = off).
   */
  render(p: EnhanceParams, docW: number, docH: number, split: number | null): HTMLCanvasElement | null {
    const st = this.st;
    const gl = st.gl;
    if (this.disposed || gl.isContextLost() || shared !== st) return null;
    const { w, h } = this.s;
    const sharp = p.sharpness / 100 * 1.6, clar = p.clarity / 100 * 0.7;
    const small = sharp ? this.getSmall() : null;
    const large = clar ? this.getLarge() : null;
    if (st.canvas.width !== w || st.canvas.height !== h) { st.canvas.width = w; st.canvas.height = h; }
    if (gl.drawingBufferWidth !== w || gl.drawingBufferHeight !== h) return null;
    const m = st.main, u = m.u;
    gl.useProgram(m.p);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    const bind = (unit: number, tex: WebGLTexture | null, loc: WebGLUniformLocation | null) => {
      gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, tex ?? this.src); gl.uniform1i(loc, unit);
    };
    bind(0, this.src, u.uSrc); bind(1, small, u.uSmall); bind(2, large, u.uLarge); bind(3, this.sel, u.uSel);
    gl.uniform2i(u.uSize, w, h);
    gl.uniform2i(u.uOrigin, this.s.ox, this.s.oy);
    gl.uniform1i(u.uFlip, 1);
    gl.uniform1f(u.uSplit, split == null ? -1 : Math.max(0, Math.min(w, Math.round(split - this.s.ox))));
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
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return st.canvas;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    const gl = this.st.gl;
    for (const t of this.temps) gl.deleteTexture(t);
    this.temps = [];
    // give the large drawing buffer back
    this.st.canvas.width = this.st.canvas.height = 1;
  }
}
