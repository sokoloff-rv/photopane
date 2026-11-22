/**
 * Sharp downscaling for the canvas view. Chrome's drawImage uses a bilinear filter for every
 * imageSmoothingQuality, which visibly softens the picture at zooms like 97% or 66%. Photoshop shows
 * such zooms crisply, so the view is resampled here with a Catmull-Rom (bicubic) kernel on the GPU.
 */

const VS = `#version 300 es
in vec2 p;
void main() { gl_Position = vec4(p, 0.0, 1.0); }`;

// Catmull-Rom kernel stretched by 1/scale (area-correct for downscaling), premultiplied alpha.
const FS = `#version 300 es
precision highp float;
uniform sampler2D img; uniform vec2 scale; uniform ivec2 srcSize; uniform float outH;
out vec4 o;
float cr(float x) {
  x = abs(x);
  if (x < 1.0) return (1.5 * x - 2.5) * x * x + 1.0;
  if (x < 2.0) return ((-0.5 * x + 2.5) * x - 4.0) * x + 2.0;
  return 0.0;
}
void main() {
  vec2 c = vec2(gl_FragCoord.x, outH - gl_FragCoord.y) / scale - 0.5;
  vec2 r = 2.0 / scale;
  int x0 = int(ceil(c.x - r.x)), x1 = int(floor(c.x + r.x));
  int y0 = int(ceil(c.y - r.y)), y1 = int(floor(c.y + r.y));
  vec4 acc = vec4(0.0); float ws = 0.0;
  for (int y = y0; y <= y1; y++) {
    float wy = cr((float(y) - c.y) * scale.y);
    int yy = clamp(y, 0, srcSize.y - 1);
    for (int x = x0; x <= x1; x++) {
      float w = cr((float(x) - c.x) * scale.x) * wy;
      acc += texelFetch(img, ivec2(clamp(x, 0, srcSize.x - 1), yy), 0) * w;
      ws += w;
    }
  }
  vec4 v = acc / ws;
  float a = clamp(v.a, 0.0, 1.0);
  o = vec4(clamp(v.rgb, 0.0, a), a);
}`;

interface State {
  canvas: HTMLCanvasElement; gl: WebGL2RenderingContext; tex: WebGLTexture;
  uScale: WebGLUniformLocation | null; uSize: WebGLUniformLocation | null; uOutH: WebGLUniformLocation | null;
  maxTex: number;
}
let state: State | null | undefined;

function init(): State | null {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2', { premultipliedAlpha: true, preserveDrawingBuffer: true, antialias: false, alpha: true });
    if (!gl) return null;
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!; gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader');
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || 'link');
    gl.useProgram(prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const tex = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.uniform1i(gl.getUniformLocation(prog, 'img'), 0);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    canvas.addEventListener('webglcontextlost', () => { state = undefined; });
    return {
      canvas, gl, tex,
      uScale: gl.getUniformLocation(prog, 'scale'), uSize: gl.getUniformLocation(prog, 'srcSize'), uOutH: gl.getUniformLocation(prog, 'outH'),
      maxTex: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
    };
  } catch (e) {
    console.warn('PhotoPane: sharp view resampling unavailable', e);
    return null;
  }
}

/** Halve with the browser (an exact 2×2 box at scale 0.5) until the remaining factor is moderate. */
function prehalve(src: HTMLCanvasElement, dw: number, dh: number): HTMLCanvasElement {
  let cur = src;
  while (dw / cur.width < 0.25 || dh / cur.height < 0.25) {
    const c = document.createElement('canvas');
    c.width = Math.max(dw, Math.ceil(cur.width / 2)); c.height = Math.max(dh, Math.ceil(cur.height / 2));
    const g = c.getContext('2d')!;
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
    g.drawImage(cur, 0, 0, c.width, c.height);
    cur = c;
  }
  return cur;
}

/**
 * Resample `src` to exactly dw×dh pixels into `out` (resized as needed).
 * Returns false when the GPU path is unavailable; the caller then draws with the browser's filter.
 */
export function resampleSharp(src: HTMLCanvasElement, dw: number, dh: number, out: HTMLCanvasElement): boolean {
  if (state === undefined) state = init();
  const st = state;
  if (!st || st.gl.isContextLost() || dw < 1 || dh < 1) return false;
  const s = prehalve(src, dw, dh);
  if (s.width > st.maxTex || s.height > st.maxTex || dw > st.maxTex || dh > st.maxTex) return false;
  const gl = st.gl;
  if (st.canvas.width !== dw || st.canvas.height !== dh) { st.canvas.width = dw; st.canvas.height = dh; }
  gl.viewport(0, 0, dw, dh);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, st.tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, s);
  gl.uniform2f(st.uScale, dw / s.width, dh / s.height);
  gl.uniform2i(st.uSize, s.width, s.height);
  gl.uniform1f(st.uOutH, dh);
  gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  if (out.width !== dw || out.height !== dh) { out.width = dw; out.height = dh; }
  const g = out.getContext('2d')!;
  g.clearRect(0, 0, dw, dh);
  g.drawImage(st.canvas, 0, 0);
  return true;
}
