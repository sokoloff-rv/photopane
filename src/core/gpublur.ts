/**
 * Field Blur, Iris Blur and Tilt-Shift on the GPU. Five blur levels (0 … the strongest blur) are made with
 * Gaussian passes on reduced copies; a shader works out the blur amount of every pixel (from the pins,
 * the ellipse or the focus band, exactly as blurAt() in tools/blurgallery.ts) and blends the two nearest
 * levels, plus the bokeh highlights. Moving pins or changing a blur takes a few milliseconds instead of
 * recomputing the levels on the CPU.
 * create() returns null where WebGL2 is missing or the image is too large; the tool then uses the CPU.
 */
export interface BlurShape {
  mode: 'field' | 'iris' | 'tilt';
  pins: { x: number; y: number; blur: number }[];
  iris: { cx: number; cy: number; rx: number; ry: number; feather: number; blur: number };
  tilt: { cx: number; cy: number; angle: number; focus: number; trans: number; blur: number };
  bokeh: number;
}

export const MAX_PINS = 32;
const LEVELS = 5;

const VS = `#version 300 es
in vec2 p;
void main() { gl_Position = vec4(p, 0.0, 1.0); }`;

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

/* Separable Gaussian on premultiplied colour. */
const FS_BLUR = `#version 300 es
precision highp float; precision highp int;
uniform sampler2D uIn; uniform ivec2 uSize; uniform ivec2 uDir; uniform float uSigma;
out vec4 o;
void main() {
  ivec2 q = ivec2(gl_FragCoord.xy);
  int r = int(ceil(uSigma * 3.0));
  float k = -0.5 / (uSigma * uSigma);
  vec4 acc = texelFetch(uIn, q, 0); float ws = 1.0;
  for (int i = 1; i <= r; i++) {
    float w = exp(float(i * i) * k);
    acc += (texelFetch(uIn, clamp(q + uDir * i, ivec2(0), uSize - 1), 0) + texelFetch(uIn, clamp(q - uDir * i, ivec2(0), uSize - 1), 0)) * w;
    ws += 2.0 * w;
  }
  o = acc / ws;
}`;

/* Blend of the blur levels by the blur map, with bokeh; uOut: 0 = screen (flipped, premultiplied), 1 = straight. */
const FS_MIX = `#version 300 es
precision highp float; precision highp int;
uniform sampler2D uSrc, uL1, uL2, uL3, uL4;
uniform ivec2 uSize; uniform vec2 uOrigin; uniform float uScale; uniform int uOut;
uniform int uMode; uniform float uR, uBokeh;
uniform vec3 uPins[${MAX_PINS}]; uniform int uPinCount;
uniform vec4 uIris; uniform vec2 uIrisFB;
uniform vec4 uTilt; uniform vec2 uTiltTB;
out vec4 o;
float blurAt(vec2 d) {
  if (uMode == 1) {
    vec2 u = (d - uIris.xy) / uIris.zw;
    return uIrisFB.y * smoothstep(uIrisFB.x, 1.0, length(u));
  }
  if (uMode == 2) {
    vec2 nrm = vec2(-sin(uTilt.z), cos(uTilt.z));
    return uTiltTB.y * smoothstep(uTilt.w, uTilt.w + uTiltTB.x, abs(dot(d - uTilt.xy, nrm)));
  }
  if (uPinCount == 1) return uPins[0].z;
  float sw = 0.0, sb = 0.0;
  for (int i = 0; i < ${MAX_PINS}; i++) {
    if (i >= uPinCount) break;
    vec2 v = d - uPins[i].xy;
    float w = 1.0 / (dot(v, v) + 1.0);
    sw += w; sb += w * uPins[i].z;
  }
  return sb / sw;
}
void main() {
  ivec2 q = ivec2(int(gl_FragCoord.x), uOut == 0 ? uSize.y - 1 - int(gl_FragCoord.y) : int(gl_FragCoord.y));
  vec2 uv = (vec2(q) + 0.5) / vec2(uSize);
  vec2 d = uOrigin + (vec2(q) + 0.5) / uScale;
  float b = uR > 0.0 ? blurAt(d) : 0.0;
  float f = clamp(b / max(uR, 1e-6) * 4.0, 0.0, 4.0);
  vec4 s0 = texelFetch(uSrc, q, 0); s0 = vec4(s0.rgb * s0.a, s0.a);
  vec4 c = s0 * max(0.0, 1.0 - abs(f))
    + texture(uL1, uv) * max(0.0, 1.0 - abs(f - 1.0)) + texture(uL2, uv) * max(0.0, 1.0 - abs(f - 2.0))
    + texture(uL3, uv) * max(0.0, 1.0 - abs(f - 3.0)) + texture(uL4, uv) * max(0.0, 1.0 - abs(f - 4.0));
  if (uBokeh > 0.0 && f > 0.0 && c.a > 0.0) {
    vec3 st = c.rgb / c.a;
    float L = dot(st, vec3(0.299, 0.587, 0.114));
    c.rgb *= 1.0 + uBokeh / 100.0 * 1.8 * (f / 4.0) * smoothstep(0.5, 0.92, L);
  }
  c.rgb = min(c.rgb, vec3(c.a));
  if (uOut == 0) o = c;
  else o = c.a > 0.0 ? vec4(c.rgb / c.a, c.a) : vec4(0.0);
}`;

interface Prog { p: WebGLProgram; u: Record<string, WebGLUniformLocation | null> }

export class GpuBlur {
  private gl: WebGL2RenderingContext;
  readonly canvas: HTMLCanvasElement;
  private down: Prog; private blur: Prog; private mix: Prog;
  private fbo: WebGLFramebuffer;
  private src: WebGLTexture;
  private levels: WebGLTexture[] = [];
  private levelsR = -1;
  private textures = new Set<WebGLTexture>();
  private fmt: { internal: number; type: number };

  /** `source`: the pixels (straight RGBA) at the size the result is wanted; ox/oy and scale map them to the document. */
  static create(source: ImageData): GpuBlur | null {
    try {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl2', { premultipliedAlpha: true, preserveDrawingBuffer: true, antialias: false, alpha: true, depth: false, stencil: false });
      if (!gl) return null;
      const max = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE) as number, gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number);
      if (source.width > max || source.height > max) return null;
      return new GpuBlur(canvas, gl, source);
    } catch (e) { console.warn('PhotoPane: GPU blur unavailable', e); return null; }
  }

  private constructor(canvas: HTMLCanvasElement, gl: WebGL2RenderingContext, source: ImageData) {
    this.canvas = canvas; this.gl = gl;
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
    this.down = prog(FS_DOWN, ['uIn', 'uSize', 'uF']);
    this.blur = prog(FS_BLUR, ['uIn', 'uSize', 'uDir', 'uSigma']);
    this.mix = prog(FS_MIX, ['uSrc', 'uL1', 'uL2', 'uL3', 'uL4', 'uSize', 'uOrigin', 'uScale', 'uOut', 'uMode', 'uR', 'uBokeh', 'uPins', 'uPinCount', 'uIris', 'uIrisFB', 'uTilt', 'uTiltTB']);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
    const half = !!gl.getExtension('EXT_color_buffer_float') || !!gl.getExtension('EXT_color_buffer_half_float');
    this.fmt = half ? { internal: gl.RGBA16F, type: gl.HALF_FLOAT } : { internal: gl.RGBA8, type: gl.UNSIGNED_BYTE };
    this.fbo = gl.createFramebuffer()!;
    this.src = this.texture(gl.RGBA8, source.width, source.height, gl.RGBA, gl.UNSIGNED_BYTE, source.data, gl.NEAREST);
    canvas.width = source.width; canvas.height = source.height;
    if (gl.getError() === gl.OUT_OF_MEMORY) throw new Error('out of GPU memory');
  }

  get w() { return this.canvas.width; }
  get h() { return this.canvas.height; }

  private texture(internal: number, w: number, h: number, format: number, type: number, data: ArrayBufferView | null, filter: number) {
    const gl = this.gl;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, data);
    this.textures.add(t);
    return t;
  }
  private free(t: WebGLTexture) { this.gl.deleteTexture(t); this.textures.delete(t); }

  private pass(prog: Prog, out: WebGLTexture | null, w: number, h: number, inputs: [string, WebGLTexture][], set: (u: Prog['u']) => void) {
    const gl = this.gl;
    gl.useProgram(prog.p);
    if (out) { gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, out, 0); }
    else gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    inputs.forEach(([n, t], i) => { gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, t); gl.uniform1i(prog.u[n], i); });
    set(prog.u);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** Blur levels 1…4 for the strongest blur R (pixels of this image): Gaussians of σ = R·i/8 on reduced copies. */
  private makeLevels(R: number) {
    if (Math.abs(R - this.levelsR) < 1e-3 && this.levels.length) return;
    const gl = this.gl;
    for (const t of this.levels) this.free(t);
    this.levels = [];
    const { w, h } = this;
    for (let i = 1; i < LEVELS; i++) {
      const sigma = Math.max(0.3, (R * i) / (LEVELS - 1) / 2);
      const f = Math.max(1, Math.min(16, Math.floor(sigma / 3)));
      const lw = Math.max(1, Math.ceil(w / f)), lh = Math.max(1, Math.ceil(h / f));
      const reduced = this.texture(this.fmt.internal, lw, lh, gl.RGBA, this.fmt.type, null, gl.NEAREST);
      this.pass(this.down, reduced, lw, lh, [['uIn', this.src]], u => { gl.uniform2i(u.uSize, w, h); gl.uniform1i(u.uF, f); });
      // the box average already blurs by f²/12; the Gaussian adds the rest
      const s = Math.sqrt(Math.max(0.09, sigma * sigma - (f * f) / 12)) / f;
      const tmp = this.texture(this.fmt.internal, lw, lh, gl.RGBA, this.fmt.type, null, gl.NEAREST);
      const out = this.texture(this.fmt.internal, lw, lh, gl.RGBA, this.fmt.type, null, gl.LINEAR);
      this.pass(this.blur, tmp, lw, lh, [['uIn', reduced]], u => { gl.uniform2i(u.uSize, lw, lh); gl.uniform2i(u.uDir, 1, 0); gl.uniform1f(u.uSigma, s); });
      this.pass(this.blur, out, lw, lh, [['uIn', tmp]], u => { gl.uniform2i(u.uSize, lw, lh); gl.uniform2i(u.uDir, 0, 1); gl.uniform1f(u.uSigma, s); });
      this.free(reduced); this.free(tmp);
      this.levels.push(out);
    }
    this.levelsR = R;
  }

  /**
   * Render the blurred image. `R`: the strongest blur in document px, `scale`: image px per document px,
   * ox/oy: document position of the image origin. Screen output returns the canvas (premultiplied, for
   * drawImage); 'pixels' returns straight RGBA.
   */
  render(shape: BlurShape, R: number, scale: number, ox: number, oy: number, out: 'screen'): HTMLCanvasElement | null;
  render(shape: BlurShape, R: number, scale: number, ox: number, oy: number, out: 'pixels'): Uint8ClampedArray | null;
  render(shape: BlurShape, R: number, scale: number, ox: number, oy: number, out: 'screen' | 'pixels'): HTMLCanvasElement | Uint8ClampedArray | null {
    const gl = this.gl;
    if (gl.isContextLost()) return null;
    this.makeLevels(R * scale);
    const { w, h } = this;
    const pins = new Float32Array(MAX_PINS * 3);
    shape.pins.slice(0, MAX_PINS).forEach((p, i) => { pins[i * 3] = p.x; pins[i * 3 + 1] = p.y; pins[i * 3 + 2] = p.blur; });
    const target = out === 'pixels' ? this.texture(gl.RGBA8, w, h, gl.RGBA, gl.UNSIGNED_BYTE, null, gl.NEAREST) : null;
    const L = this.levels;
    this.pass(this.mix, target, w, h, [['uSrc', this.src], ['uL1', L[0]], ['uL2', L[1]], ['uL3', L[2]], ['uL4', L[3]]], u => {
      gl.uniform2i(u.uSize, w, h);
      gl.uniform2f(u.uOrigin, ox, oy);
      gl.uniform1f(u.uScale, scale);
      gl.uniform1i(u.uOut, out === 'pixels' ? 1 : 0);
      gl.uniform1i(u.uMode, shape.mode === 'field' ? 0 : shape.mode === 'iris' ? 1 : 2);
      gl.uniform1f(u.uR, R);
      gl.uniform1f(u.uBokeh, shape.bokeh);
      gl.uniform3fv(u.uPins, pins);
      gl.uniform1i(u.uPinCount, Math.min(MAX_PINS, shape.pins.length));
      const ir = shape.iris, tl = shape.tilt;
      gl.uniform4f(u.uIris, ir.cx, ir.cy, ir.rx, ir.ry); gl.uniform2f(u.uIrisFB, ir.feather, ir.blur);
      gl.uniform4f(u.uTilt, tl.cx, tl.cy, tl.angle, tl.focus); gl.uniform2f(u.uTiltTB, tl.trans, tl.blur);
    });
    if (!target) return gl.isContextLost() ? null : this.canvas;
    const res = new Uint8ClampedArray(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, res);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.free(target);
    return gl.isContextLost() ? null : res;
  }

  dispose() {
    for (const t of this.textures) this.gl.deleteTexture(t);
    this.textures.clear();
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
