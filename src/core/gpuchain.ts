/**
 * The adjustment chain on the GPU: Adjust (the maths of enhance() in core/adjust.ts), Levels and Curves
 * (per-channel lookup tables) run as shader passes, one after another, each blended with the selection.
 * A chain made only of these windows is drawn entirely on the GPU, so its sliders stay smooth on large
 * photos; single passes can also run on pixels from the CPU (mixed chains, committing a step).
 * create() returns null where WebGL2 is missing or the layer is too large; the chain then uses the CPU.
 */
import type { EnhanceParams } from './adjust';

/** One step of the chain as the GPU sees it. */
export type GpuStageDesc =
  | { kind: 'enhance'; p: EnhanceParams }
  | { kind: 'lut'; r: Uint8ClampedArray; g: Uint8ClampedArray; b: Uint8ClampedArray };

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
  enh: Prog; lut: Prog; show: Prog; blur: Prog; down: Prog;
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
    const show = prog(FS_SHOW, ['uIn', 'uBase', 'uSize', 'uSplit']);
    const blur = prog(FS_BLUR, ['uIn', 'uSize', 'uDir', 'uSigma', 'uPremul']);
    const down = prog(FS_DOWN, ['uIn', 'uSize', 'uF']);
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
    return { canvas, gl, enh, lut, show, blur, down, fmt, maxSize, fbo: gl.createFramebuffer()! };
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

  /** One stage from texture `input` (named `key` for the blur cache) into `out`. */
  private stage(d: GpuStageDesc, input: WebGLTexture, key: string, out: WebGLTexture, docW: number, docH: number) {
    const { gl } = this.st;
    const sel = this.sel ?? input;
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
