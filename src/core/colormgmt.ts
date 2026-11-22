/**
 * Minimal ICC colour management for RGB matrix/TRC profiles (Adobe RGB, Display P3, ProPhoto…).
 * Document pixels stay in the document's colour space; the screen shows them converted to sRGB
 * (WebGL shader), and flattened exports are converted exactly.
 */

export interface RgbProfile {
  name: string;
  /** Linear RGB → linear sRGB (D65) */
  toSRGB: number[]; // 3x3 row-major
  /** Exact per channel decoding tables (256 entries, linear 0..1) */
  decode: [Float32Array, Float32Array, Float32Array];
}

const s15 = (dv: DataView, o: number) => dv.getInt32(o) / 65536;

/** XYZ (D50, ICC PCS) → linear sRGB (Bradford adapted). */
const XYZ50_TO_SRGB = [
  3.1338561, -1.6168667, -0.4906146,
  -0.9787684, 1.9161415, 0.0334540,
  0.0719453, -0.2289914, 1.4052427,
];

function mul3(a: number[], b: number[]): number[] {
  const r = new Array(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) r[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
  return r;
}

function readTag(dv: DataView, sig: string): { off: number; size: number } | null {
  const n = dv.getUint32(128);
  for (let i = 0; i < n; i++) {
    const o = 132 + i * 12;
    if (o + 12 > dv.byteLength) break;
    const s = String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
    if (s === sig) return { off: dv.getUint32(o + 4), size: dv.getUint32(o + 8) };
  }
  return null;
}

function readName(dv: DataView): string {
  const t = readTag(dv, 'desc');
  if (!t) return '';
  const type = String.fromCharCode(dv.getUint8(t.off), dv.getUint8(t.off + 1), dv.getUint8(t.off + 2), dv.getUint8(t.off + 3));
  try {
    if (type === 'desc') {
      const len = dv.getUint32(t.off + 8);
      let s = '';
      for (let i = 0; i < len - 1 && i < 200; i++) s += String.fromCharCode(dv.getUint8(t.off + 12 + i));
      return s;
    }
    if (type === 'mluc') {
      const recOff = t.off + 16;
      const len = dv.getUint32(recOff + 4), off = dv.getUint32(recOff + 8);
      let s = '';
      for (let i = 0; i < len / 2 && i < 200; i++) s += String.fromCharCode(dv.getUint16(t.off + off + i * 2));
      return s;
    }
  } catch { /* ignore */ }
  return '';
}

/** Decoding curve of one channel as a 256-entry table. */
function readTRC(dv: DataView, sig: string): { table: Float32Array } {
  const table = new Float32Array(256);
  const t = readTag(dv, sig);
  let fn: (x: number) => number = x => Math.pow(x, 2.2);
  if (t) {
    const type = String.fromCharCode(dv.getUint8(t.off), dv.getUint8(t.off + 1), dv.getUint8(t.off + 2), dv.getUint8(t.off + 3));
    if (type === 'curv') {
      const count = dv.getUint32(t.off + 8);
      if (count === 0) fn = x => x;
      else if (count === 1) { const g = dv.getUint16(t.off + 12) / 256; fn = x => Math.pow(x, g); }
      else {
        const vals: number[] = [];
        for (let i = 0; i < count; i++) vals.push(dv.getUint16(t.off + 12 + i * 2) / 65535);
        fn = x => { const p = x * (count - 1), i0 = Math.floor(p), i1 = Math.min(count - 1, i0 + 1); return vals[i0] + (vals[i1] - vals[i0]) * (p - i0); };
      }
    } else if (type === 'para') {
      const ft = dv.getUint16(t.off + 8);
      const p = [0, 0, 0, 0, 0, 0, 0].map((_, i) => (t.off + 12 + i * 4 + 4 <= dv.byteLength ? s15(dv, t.off + 12 + i * 4) : 0));
      const [g, a, b, c, d, e, f] = p;
      if (ft === 0) fn = x => Math.pow(x, g);
      else if (ft === 1) fn = x => (x >= -b / a ? Math.pow(a * x + b, g) : 0);
      else if (ft === 2) fn = x => (x >= -b / a ? Math.pow(a * x + b, g) + c : c);
      else if (ft === 3) fn = x => (x >= d ? Math.pow(a * x + b, g) : c * x);
      else fn = x => (x >= d ? Math.pow(a * x + b, g) + e : c * x + f);
    }
  }
  for (let i = 0; i < 256; i++) table[i] = Math.max(0, Math.min(1, fn(i / 255)));
  return { table };
}

/** Parse an ICC profile. Returns null for sRGB, non-RGB or unsupported (LUT-based) profiles. */
export function parseIcc(bytes: Uint8Array | undefined | null): RgbProfile | null {
  if (!bytes || bytes.length < 132) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const space = String.fromCharCode(dv.getUint8(16), dv.getUint8(17), dv.getUint8(18), dv.getUint8(19));
  if (space !== 'RGB ') return null;
  const name = readName(dv);
  if (/srgb/i.test(name)) return null;
  const rX = readTag(dv, 'rXYZ'), gX = readTag(dv, 'gXYZ'), bX = readTag(dv, 'bXYZ');
  if (!rX || !gX || !bX) return null;
  const xyz = (t: { off: number }) => [s15(dv, t.off + 8), s15(dv, t.off + 12), s15(dv, t.off + 16)];
  const r = xyz(rX), g = xyz(gX), b = xyz(bX);
  const toXYZ = [r[0], g[0], b[0], r[1], g[1], b[1], r[2], g[2], b[2]];
  const toSRGB = mul3(XYZ50_TO_SRGB, toXYZ);
  // close to identity → effectively sRGB
  const ident = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const trcR = readTRC(dv, 'rTRC'), trcG = readTRC(dv, 'gTRC'), trcB = readTRC(dv, 'bTRC');
  if (toSRGB.every((v, i) => Math.abs(v - ident[i]) < 0.02)) return null;
  return { name: name || 'RGB', toSRGB, decode: [trcR.table, trcG.table, trcB.table] };
}

/* ---------------- display: WebGL conversion ----------------
 * An SVG feColorMatrix filter in linearRGB looks simpler, but Chrome evaluates it with 8-bit intermediates,
 * which crushes the shadows (errors up to ~20 levels). A tiny shader does the same maths in float.
 */
const VS = `#version 300 es
in vec2 p; out vec2 uv;
void main() { uv = vec2((p.x + 1.0) * 0.5, (1.0 - p.y) * 0.5); gl_Position = vec4(p, 0.0, 1.0); }`;
const FS = `#version 300 es
precision highp float;
uniform sampler2D img; uniform sampler2D lut; uniform mat3 M;
in vec2 uv; out vec4 o;
float enc(float v) { v = clamp(v, 0.0, 1.0); return v <= 0.0031308 ? 12.92 * v : 1.055 * pow(v, 1.0 / 2.4) - 0.055; }
void main() {
  vec4 c = texture(img, uv);
  ivec3 k = ivec3(c.rgb * 255.0 + 0.5);
  vec3 lin = vec3(texelFetch(lut, ivec2(k.r, 0), 0).r, texelFetch(lut, ivec2(k.g, 0), 0).g, texelFetch(lut, ivec2(k.b, 0), 0).b);
  vec3 s = M * lin;
  o = vec4(enc(s.r), enc(s.g), enc(s.b), c.a);
}`;

interface GLState { canvas: HTMLCanvasElement; gl: WebGL2RenderingContext; img: WebGLTexture; lut: WebGLTexture; uM: WebGLUniformLocation | null; profile: RgbProfile | null }
let glState: GLState | null | undefined;

function initGL(): GLState | null {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2', { premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: false, alpha: true });
    if (!gl) return null;
    const sh = (type: number, src: string) => {
      const x = gl.createShader(type)!; gl.shaderSource(x, src); gl.compileShader(x);
      if (!gl.getShaderParameter(x, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(x) || 'shader');
      return x;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || 'link');
    gl.useProgram(prog);
    const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const tex = (unit: number) => {
      const t = gl.createTexture()!; gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    };
    const img = tex(0), lut = tex(1);
    gl.uniform1i(gl.getUniformLocation(prog, 'img'), 0);
    gl.uniform1i(gl.getUniformLocation(prog, 'lut'), 1);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    canvas.addEventListener('webglcontextlost', () => { glState = undefined; });
    return { canvas, gl, img, lut, uM: gl.getUniformLocation(prog, 'M'), profile: null };
  } catch (e) {
    console.warn('PhotoPane: WebGL colour conversion unavailable', e);
    return null;
  }
}

/** Draw `src` (document colour space) into `dst` converted to sRGB for the screen. */
export function drawForDisplay(src: HTMLCanvasElement, dst: HTMLCanvasElement, p: RgbProfile) {
  const g = dst.getContext('2d')!;
  if (glState === undefined) glState = initGL();
  const st = glState;
  const maxTex = st ? st.gl.getParameter(st.gl.MAX_TEXTURE_SIZE) as number : 0;
  if (!st || src.width > maxTex || src.height > maxTex || st.gl.isContextLost()) {
    // exact CPU fallback
    const sg = src.getContext('2d')!;
    const img = sg.getImageData(0, 0, src.width, src.height);
    convertToSRGB(img.data, p);
    g.putImageData(img, 0, 0);
    return;
  }
  const gl = st.gl;
  if (st.profile !== p) {
    const lut = new Float32Array(256 * 4);
    for (let i = 0; i < 256; i++) { lut[i * 4] = p.decode[0][i]; lut[i * 4 + 1] = p.decode[1][i]; lut[i * 4 + 2] = p.decode[2][i]; lut[i * 4 + 3] = 1; }
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, st.lut);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 256, 1, 0, gl.RGBA, gl.FLOAT, lut);
    gl.uniformMatrix3fv(st.uM, true, new Float32Array(p.toSRGB));
    st.profile = p;
  }
  if (st.canvas.width !== src.width || st.canvas.height !== src.height) { st.canvas.width = src.width; st.canvas.height = src.height; }
  gl.viewport(0, 0, src.width, src.height);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, st.img);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  g.clearRect(0, 0, dst.width, dst.height);
  g.drawImage(st.canvas, 0, 0);
}

/* ---------------- exact conversion for exports ---------------- */
const encodeSRGB = (() => {
  const t = new Uint8ClampedArray(4096);
  for (let i = 0; i < 4096; i++) { const v = i / 4095; t[i] = 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055); }
  return t;
})();

/** Convert RGBA pixels from the profile's space to sRGB in place. */
export function convertToSRGB(data: Uint8ClampedArray, p: RgbProfile) {
  const [dr, dg, db] = p.decode;
  const m = p.toSRGB;
  for (let i = 0; i < data.length; i += 4) {
    const r = dr[data[i]], g = dg[data[i + 1]], b = db[data[i + 2]];
    const R = m[0] * r + m[1] * g + m[2] * b, G = m[3] * r + m[4] * g + m[5] * b, B = m[6] * r + m[7] * g + m[8] * b;
    data[i] = encodeSRGB[Math.max(0, Math.min(4095, Math.round(R * 4095)))];
    data[i + 1] = encodeSRGB[Math.max(0, Math.min(4095, Math.round(G * 4095)))];
    data[i + 2] = encodeSRGB[Math.max(0, Math.min(4095, Math.round(B * 4095)))];
  }
}
