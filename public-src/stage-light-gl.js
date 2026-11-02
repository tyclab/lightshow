import { SIDE, RADIUS, UNLIT, GLOW_SPREAD, GLOW_SIGMA, BLOOM_SPREAD, BLOOM_SIGMA, LAMP_DISC, rgbOf } from './stage-cells.js';

/*
 * The light layer in WebGL 2: every bar cell and every lamp of the plot in a fixed
 * handful of draws a frame, whatever the number of colours. A 2D canvas fills one
 * path per distinct colour and the GPU process rasterises each one; here a frame is
 * one upload of the cells' colours and five draws:
 *
 *   1. each cell's glow source (5 px, 1 px corners) into a texture;
 *   2. and 3. that texture blurred across, then down onto the canvas (σ 3 CSS px,
 *      as the 2D layer's canvas filter blurs it);
 *   4. each cell over it (7 px, 2 px corners), stacked as the 2D layer stacks them;
 *   5. each lamp's bloom and disc, in patch order as the elements stacked them.
 *
 * Shapes are drawn by their distance to the edge, a pixel's coverage being half a
 * pixel either side of it. A lamp's bloom is the 15 px disc blurred with σ 7 px,
 * looked up by distance in a profile worked out once (bloomProfile).
 */

const QUAD = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
const MAX_TAPS = 32;
export const BLOOM_STEPS = 64;

const SHAPE_VS = `#version 300 es
layout(location = 0) in vec2 corner;
layout(location = 1) in vec2 centre;
layout(location = 2) in vec4 colour;
uniform vec2 viewport;
uniform float scale;
uniform float reach;
out vec2 local;
out vec4 tint;
void main() {
  vec2 at = centre * scale;
  vec2 p = at + corner * (reach * scale + 1.0);
  local = p - at;
  tint = colour;
  gl_Position = vec4((p / viewport * 2.0 - 1.0) * vec2(1.0, -1.0), 0.0, 1.0);
}`;

const CELL_FS = `#version 300 es
precision highp float;
in vec2 local;
in vec4 tint;
uniform float scale;
uniform float halfSide;
uniform float corner;
out vec4 outColour;
void main() {
  float h = halfSide * scale, r = corner * scale;
  vec2 q = abs(local) - vec2(h - r);
  float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
  float a = clamp(0.5 - d, 0.0, 1.0);
  outColour = vec4(tint.rgb * a, a);
}`;

const LAMP_VS = `#version 300 es
layout(location = 0) in vec2 corner;
layout(location = 1) in vec2 centre;
layout(location = 2) in vec4 colour;
layout(location = 3) in vec2 shape;
uniform vec2 viewport;
uniform float scale;
uniform float bloomReach;
out vec2 local;
out vec4 tint;
out vec2 disc;
void main() {
  float reach = shape.y > 0.5 ? max(bloomReach, shape.x) : shape.x;
  vec2 at = centre * scale;
  vec2 p = at + corner * (reach * scale + 1.0);
  local = p - at;
  tint = colour;
  disc = shape;
  gl_Position = vec4((p / viewport * 2.0 - 1.0) * vec2(1.0, -1.0), 0.0, 1.0);
}`;

const LAMP_FS = `#version 300 es
precision highp float;
in vec2 local;
in vec4 tint;
in vec2 disc;
uniform float scale;
uniform float bloomReach;
uniform float profile[${BLOOM_STEPS}];
out vec4 outColour;
void main() {
  float d = length(local);
  float cover = clamp(disc.x * scale + 0.5 - d, 0.0, 1.0);
  float bloom = 0.0;
  if (disc.y > 0.5) {
    float at = d / scale / bloomReach * float(${BLOOM_STEPS - 1});
    int i = int(floor(at));
    if (i < ${BLOOM_STEPS - 1}) bloom = mix(profile[i], profile[i + 1], fract(at));
  }
  float a = cover + bloom * (1.0 - cover);
  outColour = vec4(tint.rgb * a, a);
}`;

const BLUR_VS = `#version 300 es
layout(location = 0) in vec2 corner;
void main() { gl_Position = vec4(corner, 0.0, 1.0); }`;

const BLUR_FS = `#version 300 es
precision highp float;
uniform sampler2D source;
uniform ivec2 direction;
uniform float weights[${MAX_TAPS}];
uniform int taps;
out vec4 outColour;
vec4 at(ivec2 p, ivec2 size) {
  // Outside the canvas is transparent, as a canvas filter treats it.
  if (p.x < 0 || p.y < 0 || p.x >= size.x || p.y >= size.y) return vec4(0.0);
  return texelFetch(source, p, 0);
}
void main() {
  ivec2 size = textureSize(source, 0);
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 sum = at(p, size) * weights[0];
  for (int i = 1; i < ${MAX_TAPS}; i++) {
    if (i >= taps) break;
    sum += (at(p + direction * i, size) + at(p - direction * i, size)) * weights[i];
  }
  outColour = sum;
}`;

/** Normalised one-sided Gaussian weights for σ backing pixels: the centre, then each step out to 3σ. */
export function gaussianWeights(sigma) {
  const taps = Math.max(1, Math.min(MAX_TAPS, Math.ceil(3 * sigma) + 1));
  const weights = new Float32Array(MAX_TAPS);
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    weights[i] = Math.exp(-(i * i) / (2 * sigma * sigma));
    sum += i ? 2 * weights[i] : weights[i];
  }
  for (let i = 0; i < taps; i++) weights[i] /= sum;
  return { weights, taps };
}

// The error function, to 1.5e-7 (Abramowitz and Stegun 7.1.26).
function erf(x) {
  const s = Math.sign(x), a = Math.abs(x), t = 1 / (1 + 0.3275911 * a);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
  return s * y;
}
const phi = (x) => 0.5 * (1 + erf(x / Math.SQRT2));

/**
 * The bloom of a disc of `radius` blurred with σ `sigma` (CSS pixels): its opacity at
 * BLOOM_STEPS distances from the centre out to `reach`, the disc radius plus 3σ.
 * Each value is the Gaussian's weight over the disc, integrated along one axis in
 * closed form and numerically along the other.
 */
export function bloomProfile(radius = LAMP_DISC + BLOOM_SPREAD, sigma = BLOOM_SIGMA) {
  const reach = radius + 3 * sigma;
  const profile = new Float32Array(BLOOM_STEPS);
  const rows = 256;
  for (let k = 0; k < BLOOM_STEPS; k++) {
    const d = (reach * k) / (BLOOM_STEPS - 1);
    let sum = 0;
    for (let j = 0; j < rows; j++) {
      const y = -radius + ((j + 0.5) * 2 * radius) / rows;
      const w = Math.sqrt(Math.max(0, radius * radius - y * y));
      const gy = Math.exp(-(y * y) / (2 * sigma * sigma)) / (sigma * Math.sqrt(2 * Math.PI));
      sum += gy * (phi((d + w) / sigma) - phi((d - w) / sigma)) * ((2 * radius) / rows);
    }
    profile[k] = sum;
  }
  profile[BLOOM_STEPS - 1] = 0;
  return { profile, reach };
}

function compile(gl, vs, fs) {
  const program = gl.createProgram();
  for (const [type, source] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    gl.attachShader(program, shader);
    gl.deleteShader(shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`light layer shaders: ${log}`);
  }
  const uniforms = {};
  const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < count; i++) {
    const name = gl.getActiveUniform(program, i).name.replace(/\[0\]$/, '');
    uniforms[name] = gl.getUniformLocation(program, name);
  }
  return { program, uniforms };
}

// The drawing buffer is kept between frames so the layer reads back as drawn (a
// test sampling its pixels, a screenshot) when an unchanged picture is not drawn again.
const CONTEXT = { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: true };

/**
 * The light layer on `canvas` in WebGL 2, or null where there is none. `onRestored`
 * is called when a lost context comes back, for a repaint.
 */
export function createGlPainter(canvas, { onRestored = () => {} } = {}) {
  const gl = typeof WebGL2RenderingContext === 'function' ? canvas.getContext('webgl2', CONTEXT) : null;
  if (!gl) return null;
  const bloom = bloomProfile();
  let state = null;
  let size = { width: canvas.width, height: canvas.height, scale: 1 };
  let lost = false;

  function target() {
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    for (const [key, value] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, key, value);
    const framebuffer = gl.createFramebuffer();
    return { texture, framebuffer };
  }
  function sizeTargets() {
    for (const t of [state.glow, state.across]) {
      gl.bindTexture(gl.TEXTURE_2D, t.texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, Math.max(1, size.width), Math.max(1, size.height), 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.texture, 0);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
  function instanced(attributes) {
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, state.quad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    for (const [location, buffer, components, type, normalised] of attributes) {
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, components, type, normalised, 0, 0);
      gl.vertexAttribDivisor(location, 1);
    }
    gl.bindVertexArray(null);
    return vao;
  }
  function setUp() {
    state = {
      shape: compile(gl, SHAPE_VS, CELL_FS),
      lamp: compile(gl, LAMP_VS, LAMP_FS),
      blur: compile(gl, BLUR_VS, BLUR_FS),
      quad: gl.createBuffer(),
      cellCentres: gl.createBuffer(), cellColours: gl.createBuffer(),
      lampCentres: gl.createBuffer(), lampColours: gl.createBuffer(), lampShapes: gl.createBuffer(),
      glow: target(), across: target(),
      cells: -1, at: null, colourBytes: null,
    };
    gl.bindBuffer(gl.ARRAY_BUFFER, state.quad);
    gl.bufferData(gl.ARRAY_BUFFER, QUAD, gl.STATIC_DRAW);
    state.cellVao = instanced([[1, state.cellCentres, 2, gl.FLOAT, false], [2, state.cellColours, 4, gl.UNSIGNED_BYTE, true]]);
    state.lampVao = instanced([[1, state.lampCentres, 2, gl.FLOAT, false], [2, state.lampColours, 4, gl.UNSIGNED_BYTE, true], [3, state.lampShapes, 2, gl.FLOAT, false]]);
    state.quadVao = gl.createVertexArray();
    gl.bindVertexArray(state.quadVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, state.quad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    gl.useProgram(state.lamp.program);
    gl.uniform1fv(state.lamp.uniforms.profile, bloom.profile);
    gl.uniform1f(state.lamp.uniforms.bloomReach, bloom.reach);
    sizeTargets();
  }

  const onLost = (event) => { event.preventDefault(); lost = true; state = null; };
  const onRestore = () => { lost = false; setUp(); onRestored(); };
  canvas.addEventListener('webglcontextlost', onLost);
  canvas.addEventListener('webglcontextrestored', onRestore);
  try { setUp(); } catch (error) {
    canvas.removeEventListener('webglcontextlost', onLost);
    canvas.removeEventListener('webglcontextrestored', onRestore);
    const lose = gl.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext();
    throw error;
  }

  // The cells in the order the 2D layer fills them, a path per colour in the order
  // the colours first appear, so overlapping cells stack as they did there.
  function cells(centres, colours) {
    const count = centres.length / 2;
    if (state.cells !== count) {
      state.cells = count;
      state.at = new Float32Array(count * 2);
      state.colourBytes = new Uint8Array(count * 4);
      gl.bindBuffer(gl.ARRAY_BUFFER, state.cellCentres);
      gl.bufferData(gl.ARRAY_BUFFER, state.at.byteLength, gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, state.cellColours);
      gl.bufferData(gl.ARRAY_BUFFER, state.colourBytes.byteLength, gl.DYNAMIC_DRAW);
    }
    const byColour = new Map();
    for (let i = 0; i < count; i++) {
      const colour = colours[i] || UNLIT;
      const list = byColour.get(colour);
      if (list) list.push(i);
      else byColour.set(colour, [i]);
    }
    const { at, colourBytes: bytes } = state;
    let k = 0;
    for (const [colour, list] of byColour) {
      const [r, g, b] = rgbOf(colour);
      for (const i of list) {
        at[k * 2] = centres[i * 2]; at[k * 2 + 1] = centres[i * 2 + 1];
        bytes[k * 4] = r; bytes[k * 4 + 1] = g; bytes[k * 4 + 2] = b; bytes[k * 4 + 3] = 255;
        k++;
      }
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, state.cellCentres);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, at);
    gl.bindBuffer(gl.ARRAY_BUFFER, state.cellColours);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, bytes);
    return count;
  }

  function lamps(list) {
    const centres = new Float32Array(list.length * 2), colours = new Uint8Array(list.length * 4), shapes = new Float32Array(list.length * 2);
    list.forEach((lamp, i) => {
      centres[i * 2] = lamp.x; centres[i * 2 + 1] = lamp.y;
      colours.set([lamp.rgb[0], lamp.rgb[1], lamp.rgb[2], 255], i * 4);
      shapes[i * 2] = lamp.radius; shapes[i * 2 + 1] = lamp.bloom ? 1 : 0;
    });
    for (const [buffer, data] of [[state.lampCentres, centres], [state.lampColours, colours], [state.lampShapes, shapes]]) {
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    }
    return list.length;
  }

  function shapes(count, halfSide, corner) {
    const { program, uniforms } = state.shape;
    gl.useProgram(program);
    gl.uniform2f(uniforms.viewport, size.width, size.height);
    gl.uniform1f(uniforms.scale, size.scale);
    gl.uniform1f(uniforms.reach, halfSide);
    gl.uniform1f(uniforms.halfSide, halfSide);
    gl.uniform1f(uniforms.corner, corner);
    gl.bindVertexArray(state.cellVao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
  }

  function blur(from, to, direction, sigma) {
    const { program, uniforms } = state.blur;
    const { weights, taps } = gaussianWeights(sigma);
    gl.useProgram(program);
    gl.bindFramebuffer(gl.FRAMEBUFFER, to);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, from);
    gl.uniform1i(uniforms.source, 0);
    gl.uniform2i(uniforms.direction, direction[0], direction[1]);
    gl.uniform1fv(uniforms.weights, weights);
    gl.uniform1i(uniforms.taps, taps);
    gl.bindVertexArray(state.quadVao);
    // Every pixel of the target is written: nothing to blend with.
    gl.disable(gl.BLEND);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.enable(gl.BLEND);
  }

  return {
    kind: 'webgl2',
    get lost() { return lost; },
    resize(width, height, scale) {
      size = { width, height, scale };
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      if (state) sizeTargets();
    },
    paint({ centres, colours, lamps: lampList }) {
      if (!state || gl.isContextLost()) return;
      const count = cells(centres, colours);
      const lit = lamps(lampList);
      gl.viewport(0, 0, size.width, size.height);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.clearColor(0, 0, 0, 0);
      if (count) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, state.glow.framebuffer);
        gl.clear(gl.COLOR_BUFFER_BIT);
        shapes(count, (SIDE + 2 * GLOW_SPREAD) / 2, RADIUS + GLOW_SPREAD);
        blur(state.glow.texture, state.across.framebuffer, [1, 0], GLOW_SIGMA * size.scale);
        blur(state.across.texture, null, [0, 1], GLOW_SIGMA * size.scale);
        shapes(count, SIDE / 2, RADIUS);
      } else {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
      if (lit) {
        const { program, uniforms } = state.lamp;
        gl.useProgram(program);
        gl.uniform2f(uniforms.viewport, size.width, size.height);
        gl.uniform1f(uniforms.scale, size.scale);
        gl.bindVertexArray(state.lampVao);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, lit);
      }
      gl.bindVertexArray(null);
    },
    dispose() {
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestore);
      // Give the context back now rather than when the canvas is collected: the
      // browser keeps only so many.
      const lose = gl.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
      state = null;
    },
  };
}
