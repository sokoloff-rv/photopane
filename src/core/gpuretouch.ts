/**
 * The retouch brushes (Blur, Sharpen, Smudge, Dodge, Burn, Color Replacement) on the GPU.
 *
 * On the CPU every stroke started by reading the whole layer back from the video card (about 0.2 s on a
 * 24 MP photo) and every dab looped over its pixels in JavaScript (tens of milliseconds for a large Blur or
 * Smudge). Here the layer is copied into a texture once per stroke (a copy on the video card), dabs and
 * results are drawn by shaders, and only the area a pointer move changed is drawn back into the layer
 * canvas (again on the video card). The pixels come out as the CPU versions in retouch.ts compute them.
 *
 * begin() returns null where WebGL2 is missing or the layer is too large; the tools then use the CPU.
 */
import type { Surface } from './layer';
import type { Selection } from './selection';

export type RetouchKind = 'blur' | 'smudge' | 'tone' | 'sharpen' | 'replace';

/** What a pointer move's area shows: the tool and its settings. */
export interface PresentParams {
  kind: RetouchKind;
  /** Dodge (true) or Burn; range 0 shadows, 1 midtones, 2 highlights */
  dodge?: boolean; range?: number;
  /** Color Replacement: hue and saturation of the foreground colour (0..1) */
  fgH?: number; fgS?: number;
}

const VS = `#version 300 es
in vec2 p;
void main() { gl_Position = vec4(p, 0.0, 1.0); }`;

/**
 * The textures hold the layer's pixels as the canvas stores them (colour × alpha), so pixels a stroke does
 * not change go back exactly as they were; the brushes compute on straight colour (st) as the CPU does.
 */
const PM = `
vec4 st(vec4 p) { return p.a > 0.0 ? vec4(p.rgb / p.a, p.a) : vec4(0.0); }
vec4 pm(vec4 c) { return vec4(c.rgb * c.a, c.a); }`;

/** The dab's weight at a surface pixel: falloff × strength, the selection, nothing outside the document. */
const DAB = PM + `
uniform vec2 uC; uniform float uR, uHard, uStr;
uniform ivec2 uOff, uDoc; uniform int uHasSel; uniform sampler2D uSel;
float dabW(ivec2 q) {
  float t = length((vec2(q) + 0.5 - uC) / uR);
  if (t >= 1.0) return 0.0;
  float w = t <= uHard ? 1.0 : 1.0 - smoothstep(uHard, 1.0, t);
  ivec2 dq = q + uOff;
  if (dq.x < 0 || dq.y < 0 || dq.x >= uDoc.x || dq.y >= uDoc.y) return 0.0;
  if (uHasSel == 1) w *= texelFetch(uSel, dq, 0).a;
  return w * uStr;
}`;

/** Coverage of the stroke (Dodge/Burn, Sharpen, Color Replacement): drawn with MAX blending. */
const FS_COV = `#version 300 es
precision highp float; precision highp int;
${DAB}
uniform sampler2D uOrig; uniform int uReplace; uniform ivec2 uSample; uniform int uHasSample; uniform float uTol;
out vec4 o;
void main() {
  ivec2 q = ivec2(gl_FragCoord.xy);
  float w = dabW(q);
  if (uReplace == 1 && w > 0.0) {
    // Color Replacement: only pixels close to the colour sampled under this dab
    vec4 a = st(texelFetch(uOrig, q, 0));
    if (uHasSample == 0 || a.a == 0.0) w = 0.0;
    else {
      vec3 smp = st(texelFetch(uOrig, uSample, 0)).rgb * 255.0;
      vec3 df = abs(a.rgb * 255.0 - smp);
      float diff = max(df.r, max(df.g, df.b));
      if (diff > uTol) w = 0.0;
      else w *= uTol > 0.0 ? min(1.0, (uTol - diff) / (uTol * 0.35 + 1.0)) : 1.0;
    }
  }
  o = vec4(w);
}`;

/** One Blur dab, into a scratch texture the size of the dab's area: the 5×5 average, as BlurTool.op. */
const FS_BLUR = `#version 300 es
precision highp float; precision highp int;
${DAB}
uniform sampler2D uA; uniform ivec2 uRect; uniform ivec2 uSurf;
out vec4 o;
void main() {
  ivec2 q = uRect + ivec2(gl_FragCoord.xy);
  vec4 s = texelFetch(uA, q, 0);
  float k = dabW(q);
  if (k <= 0.0) { o = s; return; }
  vec4 acc = vec4(0.0); float n = 0.0;
  for (int y = -2; y <= 2; y++) for (int x = -2; x <= 2; x++) {
    ivec2 p = q + ivec2(x, y);
    if (p.x < 0 || p.y < 0 || p.x >= uSurf.x || p.y >= uSurf.y) continue;
    acc += st(texelFetch(uA, p, 0)); n += 1.0;
  }
  vec4 c = st(s);
  o = pm(c + (acc / n - c) * k * 0.6);
}`;

/**
 * One Smudge dab (as SmudgeTool.op): the picture from where the previous dab was (uD back, taken between
 * pixels) mixes in by weight × strength. Mixed as colour × alpha, as the textures hold it.
 */
const FS_SMUDGE = `#version 300 es
precision highp float; precision highp int;
${DAB}
uniform sampler2D uA; uniform ivec2 uRect; uniform ivec2 uSurf; uniform vec2 uD;
out vec4 o;
vec4 at(ivec2 p) { return texelFetch(uA, clamp(p, ivec2(0), uSurf - 1), 0); }
void main() {
  ivec2 q = uRect + ivec2(gl_FragCoord.xy);
  vec4 d = texelFetch(uA, q, 0);
  float w = dabW(q);
  if (w <= 0.0) { o = d; return; }
  vec2 sp = vec2(q) - uD;
  ivec2 i0 = ivec2(floor(sp)); vec2 t = sp - floor(sp);
  vec4 b = mix(mix(at(i0), at(i0 + ivec2(1, 0)), t.x), mix(at(i0 + ivec2(0, 1)), at(i0 + ivec2(1, 1)), t.x), t.y);
  o = d + (b - d) * w;
}`;

/** The result of a pointer move's area, drawn upright into the output canvas (colour × alpha, as canvases keep it). */
const FS_OUT = `#version 300 es
precision highp float; precision highp int;
uniform sampler2D uOrig, uA, uCov;
uniform ivec2 uRect, uSurf; uniform int uCanvasH;
uniform int uKind, uDodge, uRange; uniform float uFgH, uFgS;
out vec4 o;
${PM}
float hue2rgb(float p, float q, float t) {
  if (t < 0.0) t += 1.0; if (t > 1.0) t -= 1.0;
  if (t < 1.0 / 6.0) return p + (q - p) * 6.0 * t;
  if (t < 0.5) return q;
  if (t < 2.0 / 3.0) return p + (q - p) * (2.0 / 3.0 - t) * 6.0;
  return p;
}
vec3 tone(vec3 c0, float c) {
  float L = dot(c0, vec3(0.299, 0.587, 0.114));
  float a = c * 0.5, L2;
  bool dodge = uDodge == 1;
  if (uRange == 1) L2 = dodge ? pow(L, 1.0 / (1.0 + a)) : 1.0 - pow(1.0 - L, 1.0 / (1.0 + a * 0.8));
  else {
    float tw = uRange == 0 ? (1.0 - L) * (1.0 - L) : L * L;
    L2 = dodge ? L + (1.0 - L) * a * tw * 0.8 : L - L * a * tw * 0.8;
  }
  vec3 R = L > 1e-4 ? c0 * (L2 / L) : vec3(L2);
  float mx = max(R.r, max(R.g, R.b));
  if (mx > 1.0) { float den = mx - L2; R += (L2 - R) * ((mx - 1.0) / (den != 0.0 ? den : 1.0)); }
  return R;
}
vec3 replaceColor(vec3 c0, float c) {
  float mx = max(c0.r, max(c0.g, c0.b)), mn = min(c0.r, min(c0.g, c0.b));
  float l = (mx + mn) / 2.0;
  vec3 r;
  if (uFgS == 0.0) r = vec3(l);
  else {
    float q = l < 0.5 ? l * (1.0 + uFgS) : l + uFgS - l * uFgS, p = 2.0 * l - q;
    r = vec3(hue2rgb(p, q, uFgH + 1.0 / 3.0), hue2rgb(p, q, uFgH), hue2rgb(p, q, uFgH - 1.0 / 3.0));
  }
  return c0 + (r - c0) * c;
}
float lum(vec4 v) { return dot(v.rgb * 255.0, vec3(0.299, 0.587, 0.114)); }   // v straight
vec3 sharpen(ivec2 q, vec4 s, float c) {
  // as SharpenTool.endMove: brightness only, the faintest grain left, barely past the neighbours
  float y = lum(s), sLA = 0.0, sA = 0.0, lo = 255.0, hi = 0.0;
  for (int dy = -2; dy <= 2; dy++) for (int dx = -2; dx <= 2; dx++) {
    ivec2 p = q + ivec2(dx, dy);
    if (p.x < 0 || p.y < 0 || p.x >= uSurf.x || p.y >= uSurf.y) continue;
    vec4 v = st(texelFetch(uOrig, p, 0));
    float w = float((dx == 0 ? 6 : abs(dx) == 1 ? 4 : 1) * (dy == 0 ? 6 : abs(dy) == 1 ? 4 : 1));
    float a = v.a * 255.0, l = lum(v);
    sLA += w * l * a; sA += w * a;
    if (abs(dx) <= 1 && abs(dy) <= 1 && a > 0.0) { lo = min(lo, l); hi = max(hi, l); }
  }
  float detail = y - sLA / sA;
  detail = detail > 3.0 ? detail - 3.0 : detail < -3.0 ? detail + 3.0 : 0.0;
  if (detail == 0.0) return s.rgb;
  float over = min(3.0, (hi - lo) * 0.1);
  float y2 = clamp(y + detail * 3.0, lo - over, hi + over);
  return s.rgb + (y2 - y) * c / 255.0;
}
void main() {
  ivec2 q = uRect + ivec2(int(gl_FragCoord.x), uCanvasH - 1 - int(gl_FragCoord.y));
  if (uKind == 0) { o = texelFetch(uA, q, 0); return; }
  vec4 p = texelFetch(uOrig, q, 0);
  float c = uKind == 4 ? 0.0 : texelFetch(uCov, q, 0).r;
  if (c <= 0.0 || p.a == 0.0) { o = p; return; }
  vec4 s = st(p);
  vec3 r = uKind == 1 ? tone(s.rgb, c) : uKind == 2 ? sharpen(q, s, c) : replaceColor(s.rgb, c);
  o = pm(vec4(clamp(r, 0.0, 1.0), s.a));
}`;

interface Prog { p: WebGLProgram; u: Map<string, WebGLUniformLocation | null> }
interface Tex { t: WebGLTexture; f: WebGLFramebuffer; w: number; h: number }

const KIND_ID: Record<string, number> = { blur: 0, smudge: 0, tone: 1, sharpen: 2, replace: 3, orig: 4 };
/** Largest output area drawn at once (larger areas go in tiles). */
const TILE = 2048;

let instance: GpuRetouch | null | undefined;

export class GpuRetouch {
  private gl: WebGL2RenderingContext;
  private canvas: HTMLCanvasElement;
  private progs: Record<'cov' | 'blur' | 'smudge' | 'out', Prog>;
  private quad: WebGLBuffer;
  private orig: Tex | null = null;
  private work: Tex | null = null;
  private cov: Tex | null = null;
  private scratch: Tex | null = null;
  private sel: { t: WebGLTexture; of: Selection } | null = null;
  private maxSize: number;
  private surf = { w: 0, h: 0, x: 0, y: 0 };
  private doc = { w: 0, h: 0 };
  private hasSel = false;
  private releaseTimer = 0;

  /** The shared instance, or null without WebGL2. */
  private static get(): GpuRetouch | null {
    if (instance !== undefined) return instance;
    try {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const gl = canvas.getContext('webgl2', { premultipliedAlpha: true, preserveDrawingBuffer: true, antialias: false, alpha: true, depth: false, stencil: false });
      instance = gl ? new GpuRetouch(canvas, gl) : null;
    } catch (e) { console.warn('PhotoPane: GPU retouch unavailable', e); instance = null; }
    return instance;
  }

  /**
   * Start a stroke on `surface` (its canvas is copied to the video card). Null: the CPU does this stroke
   * (no WebGL2, the layer is too large, or the context was lost).
   */
  static begin(surface: Surface, docW: number, docH: number, selection: Selection | null, kind: RetouchKind): GpuRetouch | null {
    const g = GpuRetouch.get();
    if (!g || g.gl.isContextLost()) return null;
    if (surface.w > g.maxSize || surface.h > g.maxSize || docW > g.maxSize || docH > g.maxSize) return null;
    try { g.start(surface, docW, docH, selection, kind); return g; }
    catch (e) { console.warn('PhotoPane: GPU retouch failed, using the CPU', e); return null; }
  }

  private constructor(canvas: HTMLCanvasElement, gl: WebGL2RenderingContext) {
    this.canvas = canvas; this.gl = gl;
    this.maxSize = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE) as number, gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number, 16384);
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!; gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader');
      return s;
    };
    const vs = sh(gl.VERTEX_SHADER, VS);
    const prog = (fs: string): Prog => {
      const p = gl.createProgram()!;
      gl.attachShader(p, vs); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
      gl.bindAttribLocation(p, 0, 'p');
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || 'link');
      return { p, u: new Map() };
    };
    this.progs = { cov: prog(FS_COV), blur: prog(FS_BLUR), smudge: prog(FS_SMUDGE), out: prog(FS_OUT) };
    this.quad = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    // the canvas's own values (colour × alpha): no rounding on the way in or out
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); this.orig = this.work = this.cov = this.scratch = null; this.sel = null; });
  }

  /* ---------- textures ---------- */

  private makeTex(w: number, h: number, internal: number, format: number, old: Tex | null): Tex {
    const gl = this.gl;
    if (old && old.w === w && old.h === h) return old;
    if (old) { gl.deleteTexture(old.t); gl.deleteFramebuffer(old.f); }
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, gl.UNSIGNED_BYTE, null);
    const f = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    return { t, f, w, h };
  }

  /** A scratch texture at least w × h (grown in steps, kept between dabs). */
  private scratchTex(w: number, h: number): Tex {
    const s = this.scratch;
    if (s && s.w >= w && s.h >= h) return s;
    const W = Math.max(w, s?.w ?? 0, 256), H = Math.max(h, s?.h ?? 0, 256);
    this.scratch = this.makeTex(Math.ceil(W / 128) * 128, Math.ceil(H / 128) * 128, this.gl.RGBA8, this.gl.RGBA, s);
    return this.scratch;
  }

  private start(surface: Surface, docW: number, docH: number, selection: Selection | null, kind: RetouchKind) {
    const gl = this.gl;
    clearTimeout(this.releaseTimer);
    // blits and clears obey the scissor box the last output left set
    gl.disable(gl.SCISSOR_TEST);
    const w = surface.w, h = surface.h;
    this.surf = { w, h, x: surface.x, y: surface.y };
    this.doc = { w: docW, h: docH };
    // the layer as it is before the stroke
    this.orig = this.makeTex(w, h, gl.RGBA8, gl.RGBA, this.orig);
    gl.bindTexture(gl.TEXTURE_2D, this.orig.t);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, surface.canvas);
    if (kind === 'blur' || kind === 'smudge') {
      // Blur and Smudge work on their own results: a working copy
      this.work = this.makeTex(w, h, gl.RGBA8, gl.RGBA, this.work);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.orig.f);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.work.f);
      gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    } else {
      this.cov = this.makeTex(w, h, gl.R8, gl.RED, this.cov);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.cov.f);
      gl.disable(gl.SCISSOR_TEST);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    }
    this.hasSel = !!selection;
    if (selection && this.sel?.of !== selection) {
      if (this.sel) gl.deleteTexture(this.sel.t);
      const t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.ALPHA, gl.ALPHA, gl.UNSIGNED_BYTE, selection.mask);
      this.sel = { t, of: selection };
    }
  }

  /** After the stroke: the large textures are freed when no stroke follows for a while. */
  end() {
    clearTimeout(this.releaseTimer);
    this.releaseTimer = window.setTimeout(() => this.release(), 20000);
  }

  private release() {
    const gl = this.gl;
    for (const k of ['orig', 'work', 'cov', 'scratch'] as const) {
      const x = this[k];
      if (x) { gl.deleteTexture(x.t); gl.deleteFramebuffer(x.f); this[k] = null; }
    }
    if (this.sel) { gl.deleteTexture(this.sel.t); this.sel = null; }
  }

  /* ---------- drawing ---------- */

  private use(name: keyof GpuRetouch['progs']): (n: string) => WebGLUniformLocation | null {
    const gl = this.gl, pr = this.progs[name];
    gl.useProgram(pr.p);
    return (n: string) => {
      if (!pr.u.has(n)) pr.u.set(n, gl.getUniformLocation(pr.p, n));
      return pr.u.get(n)!;
    };
  }

  private bindTex(unit: number, t: WebGLTexture | null) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, t);
  }

  /** The dab uniforms (centre and radius in surface pixels). */
  private dabUniforms(u: (n: string) => WebGLUniformLocation | null, cx: number, cy: number, r: number, hard: number, str: number) {
    const gl = this.gl;
    gl.uniform2f(u('uC'), cx, cy); gl.uniform1f(u('uR'), r); gl.uniform1f(u('uHard'), hard); gl.uniform1f(u('uStr'), str);
    gl.uniform2i(u('uOff'), this.surf.x, this.surf.y); gl.uniform2i(u('uDoc'), this.doc.w, this.doc.h);
    gl.uniform1i(u('uHasSel'), this.hasSel ? 1 : 0);
    this.bindTex(3, this.hasSel && this.sel ? this.sel.t : null);
    gl.uniform1i(u('uSel'), 3);
  }

  /** Coverage of one dab (Dodge/Burn, Sharpen, Color Replacement); `sample` in surface pixels. */
  covDab(cx: number, cy: number, r: number, hard: number, str: number, x0: number, y0: number, x1: number, y1: number,
    replace?: { sample: [number, number] | null; tol: number }) {
    const gl = this.gl;
    if (!this.cov || !this.orig) return;
    const u = this.use('cov');
    this.dabUniforms(u, cx, cy, r, hard, str);
    this.bindTex(0, this.orig.t); gl.uniform1i(u('uOrig'), 0);
    gl.uniform1i(u('uReplace'), replace ? 1 : 0);
    gl.uniform1i(u('uHasSample'), replace?.sample ? 1 : 0);
    gl.uniform2i(u('uSample'), replace?.sample?.[0] ?? 0, replace?.sample?.[1] ?? 0);
    gl.uniform1f(u('uTol'), replace?.tol ?? 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.cov.f);
    gl.viewport(0, 0, this.cov.w, this.cov.h);
    gl.enable(gl.SCISSOR_TEST); gl.scissor(x0, y0, x1 - x0, y1 - y0);
    gl.enable(gl.BLEND); gl.blendEquation(gl.MAX); gl.blendFunc(gl.ONE, gl.ONE);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disable(gl.BLEND);
  }

  /** One Blur dab over x0..x1 × y0..y1 (surface pixels). */
  blurDab(cx: number, cy: number, r: number, hard: number, str: number, x0: number, y0: number, x1: number, y1: number) {
    const gl = this.gl, w = x1 - x0, h = y1 - y0;
    if (!this.work || w <= 0 || h <= 0) return;
    const sc = this.scratchTex(w, h);
    const u = this.use('blur');
    this.dabUniforms(u, cx, cy, r, hard, str);
    this.bindTex(0, this.work.t); gl.uniform1i(u('uA'), 0);
    gl.uniform2i(u('uRect'), x0, y0); gl.uniform2i(u('uSurf'), this.surf.w, this.surf.h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, sc.f);
    gl.viewport(0, 0, sc.w, sc.h);
    gl.enable(gl.SCISSOR_TEST); gl.scissor(0, 0, w, h);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.copyInto(sc, 0, 0, this.work, x0, y0, w, h);
  }

  /** One Smudge dab over x0..x1 × y0..y1: drags the picture by dx, dy (from the previous dab). */
  smudgeDab(cx: number, cy: number, r: number, hard: number, str: number, dx: number, dy: number, x0: number, y0: number, x1: number, y1: number) {
    const gl = this.gl, w = x1 - x0, h = y1 - y0;
    if (!this.work || w <= 0 || h <= 0) return;
    const sc = this.scratchTex(w, h);
    const u = this.use('smudge');
    this.dabUniforms(u, cx, cy, r, hard, str);
    this.bindTex(0, this.work.t); gl.uniform1i(u('uA'), 0);
    gl.uniform2i(u('uRect'), x0, y0); gl.uniform2i(u('uSurf'), this.surf.w, this.surf.h);
    gl.uniform2f(u('uD'), dx, dy);
    gl.bindFramebuffer(gl.FRAMEBUFFER, sc.f);
    gl.viewport(0, 0, sc.w, sc.h);
    gl.enable(gl.SCISSOR_TEST); gl.scissor(0, 0, w, h);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.copyInto(sc, 0, 0, this.work, x0, y0, w, h);
  }

  private copyInto(src: Tex, sx: number, sy: number, dst: Tex, dx: number, dy: number, w: number, h: number) {
    const gl = this.gl;
    gl.disable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, src.f);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, dst.f);
    gl.blitFramebuffer(sx, sy, sx + w, sy + h, dx, dy, dx + w, dy + h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
  }

  /**
   * Draw the area x, y, w, h (surface pixels) of the stroke's result into the layer canvas `ctx`: computed in
   * the output canvas, then copied (both on the video card).
   */
  present(rect: { x: number; y: number; w: number; h: number }, params: PresentParams | 'orig', ctx: CanvasRenderingContext2D) {
    const gl = this.gl;
    if (!this.orig) return;
    const x0 = Math.max(0, rect.x), y0 = Math.max(0, rect.y);
    const x1 = Math.min(this.surf.w, rect.x + rect.w), y1 = Math.min(this.surf.h, rect.y + rect.h);
    if (x1 <= x0 || y1 <= y0) return;
    const cw = Math.min(TILE, x1 - x0), ch = Math.min(TILE, y1 - y0);
    // the output canvas only grows (resizing reallocates it)
    if (this.canvas.width < cw || this.canvas.height < ch) {
      this.canvas.width = Math.max(this.canvas.width, Math.ceil(cw / 128) * 128);
      this.canvas.height = Math.max(this.canvas.height, Math.ceil(ch / 128) * 128);
    }
    const CW = this.canvas.width, CH = this.canvas.height;
    const p = params === 'orig' ? null : params;
    const u = this.use('out');
    this.bindTex(0, this.orig.t); gl.uniform1i(u('uOrig'), 0);
    this.bindTex(1, this.work?.t ?? null); gl.uniform1i(u('uA'), 1);
    this.bindTex(2, this.cov?.t ?? null); gl.uniform1i(u('uCov'), 2);
    gl.uniform2i(u('uSurf'), this.surf.w, this.surf.h);
    gl.uniform1i(u('uCanvasH'), CH);
    gl.uniform1i(u('uKind'), KIND_ID[p ? p.kind : 'orig']);
    gl.uniform1i(u('uDodge'), p?.dodge ? 1 : 0); gl.uniform1i(u('uRange'), p?.range ?? 1);
    gl.uniform1f(u('uFgH'), p?.fgH ?? 0); gl.uniform1f(u('uFgS'), p?.fgS ?? 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, CW, CH);
    gl.enable(gl.SCISSOR_TEST);
    for (let ty = y0; ty < y1; ty += TILE) for (let tx = x0; tx < x1; tx += TILE) {
      const w = Math.min(TILE, x1 - tx), h = Math.min(TILE, y1 - ty);
      gl.uniform2i(u('uRect'), tx, ty);
      // the top-left w × h of the canvas (GL counts rows from the bottom)
      gl.scissor(0, CH - h, w, h);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      ctx.clearRect(tx, ty, w, h);
      ctx.drawImage(this.canvas, 0, 0, w, h, tx, ty, w, h);
    }
    gl.disable(gl.SCISSOR_TEST);
  }
}
