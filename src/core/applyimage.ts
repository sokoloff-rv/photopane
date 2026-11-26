/**
 * Image → Apply Image («Внешний канал»): a layer, the merged picture or one of their channels blended onto
 * the active layer. The blend modes are those of Photoshop's Apply Image, with Add and Subtract taking a scale
 * and an offset (frequency separation: the blurred copy subtracted, scale 2, offset 128). The selection limits
 * the result. Computed on the GPU (instant while the settings change); `applyImageCpu` is the same maths for
 * machines without WebGL2.
 */

export type ApplyChannel = 'rgb' | 'r' | 'g' | 'b' | 'a';
export const APPLY_MODES = [
  'normal', '-', 'darken', 'multiply', 'color-burn', 'linear-burn', '-', 'lighten', 'screen', 'color-dodge', 'lighter', '-',
  'overlay', 'soft-light', 'hard-light', 'linear-light', '-', 'difference', 'exclusion', 'divide', '-', 'add', 'subtract',
] as const;
export type ApplyMode = Exclude<(typeof APPLY_MODES)[number], '-'>;
const MODE_ID: Record<ApplyMode, number> = {
  normal: 0, darken: 1, multiply: 2, 'color-burn': 3, 'linear-burn': 4, lighten: 5, screen: 6, 'color-dodge': 7, lighter: 8,
  overlay: 9, 'soft-light': 10, 'hard-light': 11, 'linear-light': 12, difference: 13, exclusion: 14, divide: 15, add: 16, subtract: 17,
};

export interface ApplyParams {
  channel: ApplyChannel;
  invert: boolean;
  mode: ApplyMode;
  /** 0…1 */
  opacity: number;
  /** Add / Subtract: the sum or difference is divided by scale (1…2) and offset (−255…255) added */
  scale: number;
  offset: number;
  preserveTransparency: boolean;
}

/* ---------------- the maths, per channel (0…1) ---------------- */
function blendCh(m: number, b: number, s: number, scale: number, offset: number): number {
  switch (m) {
    case 0: return s;
    case 1: return Math.min(b, s);
    case 2: return b * s;
    case 3: return b >= 1 ? 1 : s <= 0 ? 0 : 1 - Math.min(1, (1 - b) / s);
    case 4: return b + s - 1;
    case 5: return Math.max(b, s);
    case 6: return 1 - (1 - b) * (1 - s);
    case 7: return b <= 0 ? 0 : s >= 1 ? 1 : Math.min(1, b / (1 - s));
    case 8: return b + s;
    case 9: return b < 0.5 ? 2 * b * s : 1 - 2 * (1 - b) * (1 - s);
    case 10: {
      if (s <= 0.5) return b - (1 - 2 * s) * b * (1 - b);
      const D = b <= 0.25 ? ((16 * b - 12) * b + 4) * b : Math.sqrt(b);
      return b + (2 * s - 1) * (D - b);
    }
    case 11: return s < 0.5 ? 2 * b * s : 1 - 2 * (1 - b) * (1 - s);
    case 12: return b + 2 * s - 1;
    case 13: return Math.abs(b - s);
    case 14: return b + s - 2 * b * s;
    case 15: return s <= 0 ? (b > 0 ? 1 : 0) : b / s;
    case 16: return (b + s) / scale + offset / 255;
    default: return (b - s) / scale + offset / 255;
  }
}

/**
 * The result for the whole document area: `target` and `source` are document-sized straight RGBA, `sel` the
 * selection strength per pixel (null: everywhere). Returns new straight RGBA.
 */
export function applyImageCpu(target: Uint8ClampedArray, source: Uint8ClampedArray, sel: Uint8Array | null, p: ApplyParams): Uint8ClampedArray {
  const out = new Uint8ClampedArray(target.length);
  const m = MODE_ID[p.mode];
  const ch = p.channel === 'r' ? 0 : p.channel === 'g' ? 1 : p.channel === 'b' ? 2 : p.channel === 'a' ? 3 : -1;
  const s3 = [0, 0, 0];
  for (let i = 0, k = 0; i < target.length; i += 4, k++) {
    const ta = target[i + 3] / 255;
    // the source: its colour or one channel as grey; its own transparency weakens it (except the alpha channel)
    let sw = 1;
    if (ch < 0) { s3[0] = source[i] / 255; s3[1] = source[i + 1] / 255; s3[2] = source[i + 2] / 255; sw = source[i + 3] / 255; }
    else { const v = source[i + ch] / 255; s3[0] = s3[1] = s3[2] = v; if (ch < 3) sw = source[i + 3] / 255; }
    if (p.invert) { s3[0] = 1 - s3[0]; s3[1] = 1 - s3[1]; s3[2] = 1 - s3[2]; }
    const k0 = p.opacity * sw * (sel ? sel[k] / 255 : 1);
    if (k0 <= 0 || (p.preserveTransparency && ta <= 0)) { out[i] = target[i]; out[i + 1] = target[i + 1]; out[i + 2] = target[i + 2]; out[i + 3] = target[i + 3]; continue; }
    const A = p.preserveTransparency ? ta : ta + (1 - ta) * k0;
    for (let c = 0; c < 3; c++) {
      const b = target[i + c] / 255;
      const r = Math.min(1, Math.max(0, blendCh(m, b, s3[c], p.scale, p.offset)));
      // over transparency the blend has nothing under it: the source shows as it is
      const v = ta > 0 ? b + (r - b) * k0 : r;
      out[i + c] = (p.preserveTransparency || ta >= 1 ? v : (b * ta * (1 - k0) + r * k0) / A) * 255;
    }
    out[i + 3] = A * 255;
  }
  return out;
}

/* ---------------- the GPU ---------------- */
const VS = `#version 300 es
in vec2 p;
void main() { gl_Position = vec4(p, 0.0, 1.0); }`;

const FS = `#version 300 es
precision highp float; precision highp int;
uniform sampler2D uT, uS, uSel; uniform ivec2 uSize;
uniform int uMode, uCh, uInvert, uHasSel, uPreserve; uniform float uOpacity, uScale, uOffset;
out vec4 o;
float blendCh(float b, float s) {
  if (uMode == 0) return s;
  if (uMode == 1) return min(b, s);
  if (uMode == 2) return b * s;
  if (uMode == 3) return b >= 1.0 ? 1.0 : s <= 0.0 ? 0.0 : 1.0 - min(1.0, (1.0 - b) / s);
  if (uMode == 4) return b + s - 1.0;
  if (uMode == 5) return max(b, s);
  if (uMode == 6) return 1.0 - (1.0 - b) * (1.0 - s);
  if (uMode == 7) return b <= 0.0 ? 0.0 : s >= 1.0 ? 1.0 : min(1.0, b / (1.0 - s));
  if (uMode == 8) return b + s;
  if (uMode == 9) return b < 0.5 ? 2.0 * b * s : 1.0 - 2.0 * (1.0 - b) * (1.0 - s);
  if (uMode == 10) {
    if (s <= 0.5) return b - (1.0 - 2.0 * s) * b * (1.0 - b);
    float D = b <= 0.25 ? ((16.0 * b - 12.0) * b + 4.0) * b : sqrt(b);
    return b + (2.0 * s - 1.0) * (D - b);
  }
  if (uMode == 11) return s < 0.5 ? 2.0 * b * s : 1.0 - 2.0 * (1.0 - b) * (1.0 - s);
  if (uMode == 12) return b + 2.0 * s - 1.0;
  if (uMode == 13) return abs(b - s);
  if (uMode == 14) return b + s - 2.0 * b * s;
  if (uMode == 15) return s <= 0.0 ? (b > 0.0 ? 1.0 : 0.0) : b / s;
  if (uMode == 16) return (b + s) / uScale + uOffset / 255.0;
  return (b - s) / uScale + uOffset / 255.0;
}
void main() {
  // the canvas shows rows top-down: row 0 of the picture is the top row of the drawing buffer
  ivec2 q = ivec2(int(gl_FragCoord.x), uSize.y - 1 - int(gl_FragCoord.y));
  vec4 t = texelFetch(uT, q, 0), sc = texelFetch(uS, q, 0);
  vec3 s; float sw = 1.0;
  if (uCh < 0) { s = sc.rgb; sw = sc.a; }
  else { float v = uCh == 0 ? sc.r : uCh == 1 ? sc.g : uCh == 2 ? sc.b : sc.a; s = vec3(v); if (uCh < 3) sw = sc.a; }
  if (uInvert == 1) s = 1.0 - s;
  float k = uOpacity * sw * (uHasSel == 1 ? texelFetch(uSel, q, 0).a : 1.0);
  vec4 res = t;
  if (k > 0.0 && !(uPreserve == 1 && t.a <= 0.0)) {
    vec3 r = clamp(vec3(blendCh(t.r, s.r), blendCh(t.g, s.g), blendCh(t.b, s.b)), 0.0, 1.0);
    float A = uPreserve == 1 ? t.a : t.a + (1.0 - t.a) * k;
    vec3 v = t.a > 0.0 ? t.rgb + (r - t.rgb) * k : r;
    res = vec4(uPreserve == 1 || t.a >= 1.0 ? v : (t.rgb * t.a * (1.0 - k) + r * k) / A, A);
  }
  o = vec4(res.rgb * res.a, res.a);
}`;

/** The GPU version: target, source and selection as textures; the result in a document-sized canvas. */
export class ApplyImageGpu {
  readonly canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private u: Record<string, WebGLUniformLocation | null> = {};
  private tex: { t: WebGLTexture; s: WebGLTexture; sel: WebGLTexture };
  private hasSel = false;

  static create(w: number, h: number): ApplyImageGpu | null {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const gl = canvas.getContext('webgl2', { premultipliedAlpha: true, preserveDrawingBuffer: true, antialias: false, alpha: true, depth: false, stencil: false });
      if (!gl) return null;
      const max = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE) as number, gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number);
      if (w > max || h > max) return null;
      return new ApplyImageGpu(canvas, gl);
    } catch (e) { console.warn('PhotoPane: GPU Apply Image unavailable', e); return null; }
  }

  private constructor(canvas: HTMLCanvasElement, gl: WebGL2RenderingContext) {
    this.canvas = canvas; this.gl = gl;
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!; gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader');
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FS));
    gl.bindAttribLocation(p, 0, 'p');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || 'link');
    this.prog = p;
    for (const n of ['uT', 'uS', 'uSel', 'uSize', 'uMode', 'uCh', 'uInvert', 'uHasSel', 'uPreserve', 'uOpacity', 'uScale', 'uOffset']) this.u[n] = gl.getUniformLocation(p, n);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    const mk = () => {
      const t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      return t;
    };
    this.tex = { t: mk(), s: mk(), sel: mk() };
  }

  private upload(t: WebGLTexture, c: HTMLCanvasElement, alphaOnly = false) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, t);
    if (alphaOnly) gl.texImage2D(gl.TEXTURE_2D, 0, gl.ALPHA, gl.ALPHA, gl.UNSIGNED_BYTE, c);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, c);
  }
  setTarget(c: HTMLCanvasElement) { this.upload(this.tex.t, c); }
  setSource(c: HTMLCanvasElement) { this.upload(this.tex.s, c); }
  setSelection(mask: HTMLCanvasElement | null) { this.hasSel = !!mask; if (mask) this.upload(this.tex.sel, mask, true); }

  render(p: ApplyParams): HTMLCanvasElement {
    const gl = this.gl, u = this.u;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.prog);
    [this.tex.t, this.tex.s, this.tex.sel].forEach((t, i) => { gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, t); });
    gl.uniform1i(u.uT, 0); gl.uniform1i(u.uS, 1); gl.uniform1i(u.uSel, 2);
    gl.uniform2i(u.uSize, this.canvas.width, this.canvas.height);
    gl.uniform1i(u.uMode, MODE_ID[p.mode]);
    gl.uniform1i(u.uCh, p.channel === 'rgb' ? -1 : p.channel === 'r' ? 0 : p.channel === 'g' ? 1 : p.channel === 'b' ? 2 : 3);
    gl.uniform1i(u.uInvert, p.invert ? 1 : 0); gl.uniform1i(u.uHasSel, this.hasSel ? 1 : 0); gl.uniform1i(u.uPreserve, p.preserveTransparency ? 1 : 0);
    gl.uniform1f(u.uOpacity, p.opacity); gl.uniform1f(u.uScale, Math.max(1, p.scale)); gl.uniform1f(u.uOffset, p.offset);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return this.canvas;
  }

  dispose() {
    const gl = this.gl;
    for (const t of Object.values(this.tex)) gl.deleteTexture(t);
    gl.deleteProgram(this.prog);
    this.canvas.width = this.canvas.height = 1;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
