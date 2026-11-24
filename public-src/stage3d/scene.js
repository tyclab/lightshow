import { performanceReport } from '../performance.js';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { roomObjectGeometry } from './room-geometry.js';
import { paintFloors } from './floor-pattern.js';
import { meanLightRGB, landingRGB, onCeiling, roomViews, STAGE_FOV, E_FILL, E_WHITE, PAR_LEVEL, FLOOR_COLOUR, GROUND_COLOUR, OBJECT_COLOUR } from './world.js';

/**
 * The 3D stage: the rig in a dark, hazy room, drawn with three.js.
 *
 * Everything is instanced — one draw for every lamp head, one for every beam,
 * one for every cell of every bar — so a rig of a few hundred lights draws at
 * the display's rate on the machine running the show. Fixture effects avoid real
 * lights (dozens of spotlights would not keep that rate): a lamp's lens, a
 * cell and a bulb glow in their own colour, a par's beam is a cone of light in
 * the haze, soft at its edges and fading along its length, and where a beam
 * meets the floor, the ceiling or a wall it leaves a pool lying on that
 * surface. The haze setting thickens the beams and the fog.
 *
 * An imported room's surfaces shade under a dim fill, the same whatever the
 * outputs do; what a light gives the room is drawn where the light is: its own
 * glow, the room objects that are the light, and one pool where its light
 * lands, the lux it throws there as its surface reflects it (world.roomRig). A
 * pool shows from the side its surface faces; one on a ceiling from above as
 * well, since no ceiling is drawn to hide it. Light adds in a linear half-float
 * buffer, and the output keeps a pixel past white in its hue.
 *
 * Loaded on its own (three.js is most of it), the first time a stage
 * opens. `createStageScene` throws when the browser has no WebGL.
 *
 * It imports nothing of the app's: the room's size and the colour of a light
 * (world.js) are handed in, so this chunk shares no code with the page's and
 * the page loads, and opens offline, without it.
 */

// The output pass brings a pixel past white back by its largest channel, so it keeps its hue and saturation.
THREE.ShaderChunk.tonemapping_pars_fragment = THREE.ShaderChunk.tonemapping_pars_fragment.replace(
  'vec3 CustomToneMapping( vec3 color ) { return color; }',
  'vec3 CustomToneMapping( vec3 color ) { return color / max( 1.0, max( color.r, max( color.g, color.b ) ) ); }');

const BG = 0x050507;
// What a software renderer calls itself: SwiftShader, Mesa's llvmpipe and softpipe, Microsoft's Basic Render Driver.
const SOFTWARE = /swiftshader|llvmpipe|softpipe|basic render|software/i;
const OFF = 0.035;      // what an unlit lens or cell shows: its shape, not a light
const DAMPING = 0.08;
const GLOW = { lamp: 1.1, cell: 0.5 };
const ROOM_GLOW = { lamp: 0.45, cell: 0.09 };
// The floor's picture: up to 5 mm a texel, at most 2048 texels a side (1024 on a software renderer).
const FLOOR_DENSITY = 200, FLOOR_TEXELS = 2048;

// A beam's clip rides with its place and colour (aLeast, aMost, aWhere: see BEAM_FRAGMENT), so haze that no room
// edge and no wall can cut reads no texel.
const BEAM_VERTEX = /* glsl */`
  attribute vec3 aLeast;
  attribute vec3 aMost;
  attribute vec4 aWhere;
  varying vec3 vColor;
  varying float vT;
  varying vec3 vNormal;
  varying vec3 vView;
  varying vec3 vWorld;
  varying vec3 vApex;
  flat varying vec3 vLeast;
  flat varying vec3 vMost;
  flat varying vec4 vWhere;
  void main() {
    vec4 world = instanceMatrix * vec4(position, 1.0);
    vec4 view = modelViewMatrix * world;
    vView = view.xyz;
    vNormal = normalize(normalMatrix * mat3(instanceMatrix) * normal);
    vColor = instanceColor;
    vT = -position.y;
    vWorld = (modelMatrix * world).xyz;
    vApex = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
    vLeast = aLeast;
    vMost = aMost;
    vWhere = aWhere;
    gl_Position = projectionMatrix * view;
  }
`;

// Each beam's clip (world.js coneClip): the least and the greatest corner of the box its haze stays in, and where
// in uClip's texels its rooms' edges and its walls' boxes are: the first edge, how many edges the room of its lamp
// has, how many the room it lands in, and how many walls follow them. clipAt and crosses are POOL_FRAGMENT's, word
// for word, and the loops are built as its loops are: none leaves early (see there).
const BEAM_FRAGMENT = /* glsl */`
  uniform float uHaze;
  uniform sampler2D uClip;
  uniform int uClipWidth;
  varying vec3 vColor;
  varying float vT;
  varying vec3 vNormal;
  varying vec3 vView;
  varying vec3 vWorld;
  varying vec3 vApex;
  flat varying vec3 vLeast;
  flat varying vec3 vMost;
  flat varying vec4 vWhere;
  vec4 clipAt(int i) { return texelFetch(uClip, ivec2(i % uClipWidth, i / uClipWidth), 0); }
  bool crosses(vec3 from, vec3 to, int at) {
    vec3 o = from - clipAt(at).xyz, d = to - from;
    float enter = 0.0, leave = 1.0;
    bool reaches = true;
    for (int i = 1; i <= 3; i++) {
      vec4 axis = clipAt(at + i);
      float p = dot(o, axis.xyz), along = dot(d, axis.xyz);
      if (abs(along) < 1e-9) reaches = reaches && abs(p) <= axis.w;
      else {
        float a = (-axis.w - p) / along, b = (axis.w - p) / along;
        enter = max(enter, min(a, b)); leave = min(leave, max(a, b));
      }
    }
    return reaches && enter <= leave;
  }
  void main() {
    // Haze shows where its lamp's light is: in the room box, in one of the lamp's rooms, and not past a wall from
    // the lamp. What the box cuts reads no edge, and what the rooms' edges cut reads no wall: the counts drop to nought.
    bool lit = vWorld.x >= vLeast.x && vWorld.y >= vLeast.y && vWorld.z >= vLeast.z && vWorld.x <= vMost.x && vWorld.y <= vMost.y && vWorld.z <= vMost.z;
    int first = int(vWhere.x + 0.5);
    int own = int(vWhere.y + 0.5);
    int landing = int(vWhere.z + 0.5);
    int edges = lit ? own + landing : 0;
    if (edges > 0) {
      // Each room by its own edges, so two outlines that overlap leave no hole where they do.
      bool inOwn = false;
      bool inLanding = false;
      for (int i = 0; i < edges; i++) {
        vec4 e = clipAt(first + i);
        bool passed = (e.y > vWorld.z) != (e.w > vWorld.z) && vWorld.x < (e.z - e.x) * (vWorld.z - e.y) / (e.w - e.y) + e.x;
        if (passed && i < own) inOwn = !inOwn;
        if (passed && i >= own) inLanding = !inLanding;
      }
      lit = inOwn || inLanding;
    }
    int walls = lit ? int(vWhere.w + 0.5) : 0;
    for (int i = 0; i < walls; i++) lit = lit && !crosses(vApex, vWorld, first + own + landing + i * 4);
    if (!lit) discard;
    // Brightest through the middle of the cone, where the eye looks through
    // the most haze, and fading from the lens to where it lands.
    float facing = pow(abs(dot(normalize(vNormal), normalize(-vView))), 1.6);
    float along = pow(clamp(1.0 - vT, 0.0, 1.0), 1.3) * smoothstep(0.0, 0.05, vT);
    gl_FragColor = vec4(vColor * uHaze * facing * along, 1.0);
    #include <colorspace_fragment>
  }
`;

// A pool's quad spans −1…1 along and across the pool; only its window is drawn (world.poolWindow: centre and half
// size), and poolRun is how much of each half axis is the light's own run, where the pool is level.
const POOL_VERTEX = /* glsl */`
  attribute vec4 poolWindow;
  attribute vec2 poolRun;
  attribute float poolFloor;
  varying vec3 vColor;
  varying vec2 vAt;
  flat varying vec2 vRun;
  flat varying float vFloor;
  varying vec3 vWorld;
  varying vec3 vCentre;
  flat varying int vPool;
  void main() {
    vColor = instanceColor;
    vAt = poolWindow.xy + poolWindow.zw * position.xz;
    vRun = poolRun;
    vec4 world = modelMatrix * instanceMatrix * vec4(vAt.x, 0.0, vAt.y, 1.0);
    vWorld = world.xyz;
    vCentre = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
    vPool = gl_InstanceID;
    vFloor = poolFloor;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

// Each pool's clip (world.js poolClip) as texels of uClip from the pool's own header: its surface box
// (centre, then three axes with their half sizes), then where its room's edges and its walls' boxes are.
// No loop leaves early (return, continue, discard): Direct3D's compiler fails on one that does with an
// internal error, and the browser then takes the whole context away at the pool's first draw.
const POOL_FRAGMENT = /* glsl */`
  uniform sampler2D uClip;
  uniform int uClipWidth;
  uniform sampler2D uFloor;
  uniform vec4 uFloorBox;
  uniform bool uFloorOn;
  varying vec3 vColor;
  varying vec2 vAt;
  flat varying vec2 vRun;
  flat varying float vFloor;
  varying vec3 vWorld;
  varying vec3 vCentre;
  flat varying int vPool;
  vec4 clipAt(int i) { return texelFetch(uClip, ivec2(i % uClipWidth, i / uClipWidth), 0); }
  bool inBox(vec3 p, int at) {
    vec3 d = p - clipAt(at).xyz;
    bool inside = true;
    for (int i = 1; i <= 3; i++) { vec4 axis = clipAt(at + i); inside = inside && abs(dot(d, axis.xyz)) <= axis.w; }
    return inside;
  }
  bool crosses(vec3 from, vec3 to, int at) {
    vec3 o = from - clipAt(at).xyz, d = to - from;
    float enter = 0.0, leave = 1.0;
    bool reaches = true;
    for (int i = 1; i <= 3; i++) {
      vec4 axis = clipAt(at + i);
      float p = dot(o, axis.xyz), along = dot(d, axis.xyz);
      if (abs(along) < 1e-9) reaches = reaches && abs(p) <= axis.w;
      else {
        float a = (-axis.w - p) / along, b = (axis.w - p) / along;
        enter = max(enter, min(a, b)); leave = min(leave, max(a, b));
      }
    }
    return reaches && enter <= leave;
  }
  void main() {
    int head = vPool * 5;
    vec4 where = clipAt(head + 4);
    bool lit = clipAt(head).w <= 0.5 || inBox(vWorld, head);
    int edges = int(where.y + 0.5);
    if (edges > 0) {
      bool inside = false;
      for (int i = 0; i < edges; i++) {
        vec4 e = clipAt(int(where.x + 0.5) + i);
        if ((e.y > vWorld.z) != (e.w > vWorld.z) && vWorld.x < (e.z - e.x) * (vWorld.z - e.y) / (e.w - e.y) + e.x) inside = !inside;
      }
      lit = lit && inside;
    }
    int walls = int(where.w + 0.5);
    for (int i = 0; i < walls; i++) lit = lit && !crosses(vCentre, vWorld, int(where.z + 0.5) + i * 4);
    if (!lit) discard;
    // Past the light's own run the pool falls off as (1 − d²)²: half its level 0.54 of the way out (world.POOL_HALF).
    vec2 past = max(abs(vAt) - vRun, 0.0) / (1.0 - vRun);
    float fall = 1.0 - min(dot(past, past), 1.0);
    vec3 light = vColor * fall * fall;
    // A pool on the floor of a room carries its light alone and takes the floor's colour where it lands: its boards.
    if (uFloorOn && vFloor > 0.5) light *= texture(uFloor, (vWorld.xz - uFloorBox.xy) / uFloorBox.zw).rgb;
    gl_FragColor = vec4(light, 1.0);
    #include <colorspace_fragment>
  }
`;

// The fill's sky and key light, in their shares of it (0.75 and 0.45), scaled so a level white surface shows
// E_FILL / E_WHITE of white: three.js shades a surface of colour c lit with intensity I as c × I / π (read back in
// stage-colour.spec.js: 0.97 to 1.02 of that, with its specular share).
const SKY = new THREE.Color(0xc8d0e0), KEY = new THREE.Vector3(-3, 6, 4);
const FILL = Math.PI * E_FILL / E_WHITE / (0.75 * (0.2126 * SKY.r + 0.7152 * SKY.g + 0.0722 * SKY.b) + 0.45 * KEY.clone().normalize().y);

const CLIP_WIDTH = 1024;
/** uClip's texels for these lights' pools: five per pool, then the room edges and wall boxes they point to. */
function poolClipTexture(lights) {
  const texels = [], tail = [];
  const box = (target, { centre, axes, half }, flag = 0) => {
    target.push([centre.x, centre.y, centre.z, flag]);
    axes.forEach((axis, i) => target.push([axis.x, axis.y, axis.z, half[i]]));
  };
  const head = lights.length * 5;
  for (const { pool } of lights) {
    const clip = pool?.clip;
    if (clip?.surface) box(texels, clip.surface, 1);
    else for (let i = 0; i < 4; i++) texels.push([0, 0, 0, 0]);
    const room = head + tail.length;
    for (const [i, [x, z]] of (clip?.room || []).entries()) { const [x1, z1] = clip.room[(i + 1) % clip.room.length]; tail.push([x, z, x1, z1]); }
    const walls = head + tail.length;
    for (const wall of clip?.walls || []) box(tail, wall);
    texels.push([room, clip?.room?.length || 0, walls, clip?.walls?.length || 0]);
  }
  texels.push(...tail);
  const height = Math.max(1, Math.ceil(texels.length / CLIP_WIDTH));
  const data = new Float32Array(CLIP_WIDTH * height * 4);
  texels.forEach((texel, i) => data.set(texel, i * 4));
  const texture = new THREE.DataTexture(data, CLIP_WIDTH, height, THREE.RGBAFormat, THREE.FloatType);
  texture.needsUpdate = true;
  return texture;
}

// Past any room, as world.js writes it: a beam with no clip of its own (the generic venue) shows everywhere.
const OUT = 1e6;
/**
 * These beams' clips for the beam shader: each beam's box and where its edges and walls are, to ride with the beam
 * (aLeast, aMost, aWhere), and uClip's texels they point to: the edges of its lamp's room, those of the room it
 * lands in, then its walls' boxes.
 */
function beamClips(pars) {
  const beams = Math.max(1, pars.length), least = new Float32Array(beams * 3), most = new Float32Array(beams * 3), where = new Float32Array(beams * 4);
  const texels = [];
  pars.forEach(({ clip }, k) => {
    const lo = clip?.lo ?? { x: -OUT, y: -OUT, z: -OUT }, hi = clip?.hi ?? { x: OUT, y: OUT, z: OUT };
    least.set([lo.x, lo.y, lo.z], k * 3);
    most.set([hi.x, hi.y, hi.z], k * 3);
    const first = texels.length, [own = [], landing = []] = clip?.rooms || [];
    for (const polygon of [own, landing]) for (const [i, [x, z]] of polygon.entries()) { const [x1, z1] = polygon[(i + 1) % polygon.length]; texels.push([x, z, x1, z1]); }
    for (const { centre, axes, half } of clip?.walls || []) {
      texels.push([centre.x, centre.y, centre.z, 0]);
      axes.forEach((axis, i) => texels.push([axis.x, axis.y, axis.z, half[i]]));
    }
    where.set([first, own.length, landing.length, clip?.walls?.length || 0], k * 4);
  });
  const height = Math.max(1, Math.ceil(texels.length / CLIP_WIDTH));
  const data = new Float32Array(CLIP_WIDTH * height * 4);
  texels.forEach((texel, i) => data.set(texel, i * 4));
  const texture = new THREE.DataTexture(data, CLIP_WIDTH, height, THREE.RGBAFormat, THREE.FloatType);
  texture.needsUpdate = true;
  return { texture, least, most, where };
}

/**
 * A soft round dot, for the glow around lenses, bulbs and cells. Its fall is in its colour, as sRGB, not in its alpha:
 * the stage adds light in linear values, and a full colour times the decoded fall shows the fall the dot was drawn with.
 */
function glowTexture() {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgb(255,255,255)');
  g.addColorStop(0.25, 'rgb(115,115,115)');
  g.addColorStop(1, 'rgb(0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/**
 * @param canvas   where to draw
 * @param options  `haze` 0–1; `room` — { width, depth, trussHeight } in metres
 *                 (world.js); `lightRGB` — a light's emitters as linear RGB
 *                 (world.lightRGB)
 */
export function createStageScene(canvas, { haze = 0.6, room, lightRGB }) {
  const { width: STAGE_W, depth: STAGE_D, trussHeight: TRUSS_H } = room;
  const genericViews = {
    audience: { position: [0, 1.7, STAGE_D / 2 + 8], target: [0, 1.9, 0] },
    above: { position: [0, 15, 3], target: [0, 0, 0] },
    side: { position: [STAGE_W / 2 + 9, 3.2, 1.5], target: [0, 1.9, 0] },
  };
  let views = genericViews;
  let activeView = 'audience';

  // Light adds as light: every part draws into a linear half-float buffer, which the output pass encodes once. A GPU
  // multisamples that buffer; a software renderer draws it without, as multisampling it costs one three times the frame.
  const context = canvas.getContext('webgl2', { alpha: false, depth: true, stencil: false, antialias: false, powerPreference: 'high-performance' });
  const named = context?.getExtension('WEBGL_debug_renderer_info');
  const software = SOFTWARE.test(String(context?.getParameter(named ? named.UNMASKED_RENDERER_WEBGL : context.RENDERER)));
  const renderer = new THREE.WebGLRenderer({ canvas, context: context ?? undefined, antialias: !software, outputBufferType: THREE.HalfFloatType });
  renderer.toneMapping = THREE.CustomToneMapping;
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.setClearColor(BG, 1);

  const scene = new THREE.Scene();
  let dirty = true;
  let lastLights = null;
  const invalidate = () => { dirty = true; };
  scene.fog = new THREE.FogExp2(BG, 0.03);
  const camera = new THREE.PerspectiveCamera(STAGE_FOV, 1, 0.1, 200);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = DAMPING;
  controls.maxPolarAngle = Math.PI / 2 - 0.02;
  controls.minDistance = 2;
  controls.maxDistance = 45;
  controls.addEventListener('change', invalidate);
  // The orbit centre stays inside the room, so a pan cannot lose it.
  controls.addEventListener('change', () => {
    if (!roomBounds) return;
    const { width, depth, height } = roomBounds, t = controls.target;
    t.set(Math.max(-width / 2, Math.min(width / 2, t.x)), Math.max(0, Math.min(height, t.y)), Math.max(-depth / 2, Math.min(depth / 2, t.z)));
  });

  // ── The room ──
  const disposables = [];
  const keep = (...things) => { disposables.push(...things); return things[0]; };
  const floor = new THREE.Mesh(
    keep(new THREE.PlaneGeometry(STAGE_W + 30, STAGE_D + 36)),
    keep(new THREE.MeshBasicMaterial({ color: 0x09090c })),
  );
  floor.rotation.x = -Math.PI / 2;
  const deck = new THREE.Mesh(
    keep(new THREE.PlaneGeometry(STAGE_W, STAGE_D)),
    keep(new THREE.MeshBasicMaterial({ color: 0x141418 })),
  );
  deck.rotation.x = -Math.PI / 2;
  deck.position.y = 0.002;
  const wall = new THREE.Mesh(
    keep(new THREE.PlaneGeometry(STAGE_W + 6, TRUSS_H + 3)),
    keep(new THREE.MeshBasicMaterial({ color: 0x0b0b0e })),
  );
  wall.position.set(0, (TRUSS_H + 3) / 2, -STAGE_D / 2 - 0.6);
  scene.add(floor, deck, wall);
  let roomGroup = null;
  let roomDisposables = [];
  // The room replaced, freed once the new one has drawn: its materials' programs pass to the new room's.
  let retired = [];
  let cutaway = true;
  let roomWalls = [];
  let roomLightMaterials = new Map();
  let objectLights = [];
  let screens = [];
  let screenTexture = null;
  let roomBounds = null;

  function fitRoom() {
    views = roomViews(roomBounds, camera.aspect, roomModel?.listeners?.[0]);
    const distance = Math.max(...Object.values(views).map(({ position, target }) => Math.hypot(...position.map((value, index) => value - target[index]))));
    controls.maxDistance = Math.max(20, distance * 3);
    camera.far = Math.max(200, controls.maxDistance * 2);
    camera.updateProjectionMatrix();
  }

  function setCutaway(value) {
    invalidate();
    cutaway = value;
    for (const { mesh, model } of roomWalls) {
      const height = value ? Math.min(0.9, model.size.y) : model.size.y;
      mesh.scale.y = height / model.size.y;
      mesh.position.y = model.position.y - (model.size.y - height) / 2;
    }
  }

  /** The floor's picture over `bounds`, texel rows running with z: each room's pattern or colour, the ground's elsewhere. */
  function floorTexture({ bounds, rooms }) {
    const most = Math.min(software ? FLOOR_TEXELS / 2 : FLOOR_TEXELS, renderer.capabilities?.maxTextureSize ?? FLOOR_TEXELS);
    const perMetre = Math.min(FLOOR_DENSITY, most / Math.max(bounds.width, bounds.depth));
    const width = Math.max(1, Math.round(bounds.width * perMetre)), height = Math.max(1, Math.round(bounds.depth * perMetre));
    const texels = paintFloors({ width, height, x0: -bounds.width / 2, y0: -bounds.depth / 2, dx: bounds.width / width, dy: bounds.depth / height,
      ground: GROUND_COLOUR, rooms: rooms.map((area) => ({ polygon: area.polygon, color: area.color || FLOOR_COLOUR, pattern: area.floorPattern })) });
    const texture = new THREE.DataTexture(texels, width, height, THREE.RGBAFormat);
    Object.assign(texture, { colorSpace: THREE.SRGBColorSpace, magFilter: THREE.LinearFilter, minFilter: THREE.LinearMipmapLinearFilter,
      generateMipmaps: true, anisotropy: renderer.capabilities?.getMaxAnisotropy?.() ?? 1, needsUpdate: true });
    return texture;
  }

  /** The floor plane over the room box, mapped as the pools read the floor's picture: u along x, v along z. */
  function floorGeometry({ width, depth }) {
    const geometry = new THREE.PlaneGeometry(width, depth).rotateX(-Math.PI / 2);
    const { position, uv } = geometry.attributes;
    for (let i = 0; i < position.count; i++) uv.setXY(i, position.getX(i) / width + 0.5, position.getZ(i) / depth + 0.5);
    return geometry;
  }

  /** Pools on the floor read its picture, or carry the colour of what they land on where there is none. */
  function showFloor(map, bounds) {
    for (const material of poolMaterials) {
      const { uFloor, uFloorBox, uFloorOn } = material.uniforms;
      uFloor.value = map;
      uFloorOn.value = !!map;
      if (bounds) uFloorBox.value.set(-bounds.width / 2, -bounds.depth / 2, bounds.width, bounds.depth);
    }
  }

  let roomModel;
  function setRoom(model) {
    // The room this scene already shows: a view that mounts again keeps it, and its materials' programs.
    if (model === roomModel) return;
    roomModel = model;
    invalidate();
    if (roomGroup) { scene.remove(roomGroup); roomGroup.clear(); }
    retired.push(...roomDisposables);
    roomDisposables = [];
    roomWalls = [];
    roomLightMaterials = new Map();
    lastLights = null;
    screens = [];
    if (screenTexture) { screenTexture.dispose(); screenTexture = null; }
    roomGroup = null;
    showFloor(null);
    floor.visible = deck.visible = wall.visible = !model;
    roomBounds = model?.bounds || null;
    views = genericViews;
    if (model) {
      roomGroup = new THREE.Group();
      const keepRoom = (resource) => { roomDisposables.push(resource); return resource; };
      // The floor: one picture over the room box, each room's boards or tiles in it, the ground between them.
      const floorMap = keepRoom(floorTexture(model));
      const ground = new THREE.Mesh(keepRoom(floorGeometry(model.bounds)),
        keepRoom(new THREE.MeshStandardMaterial({ map: floorMap, roughness: 0.9, side: THREE.DoubleSide })));
      roomGroup.add(ground);
      showFloor(floorMap, model.bounds);
      // A dim fill, so the room reads whatever the outputs do: E_FILL lux on a level surface (world.js).
      roomGroup.add(keepRoom(new THREE.HemisphereLight(SKY, 0x30323a, 0.75 * FILL)));
      const key = keepRoom(new THREE.DirectionalLight(0xffffff, 0.45 * FILL));
      key.position.copy(KEY);
      roomGroup.add(key);
      for (const object of model.objects) {
        const geometry = keepRoom(roomObjectGeometry(object));
        // A screen shows the room picture as it is; everything else is a surface the light falls on.
        const material = object.role === 'screen' ? new THREE.MeshBasicMaterial({ color: object.color || OBJECT_COLOUR })
          : new THREE.MeshStandardMaterial({ color: object.color || OBJECT_COLOUR, roughness: 0.85, emissiveIntensity: object.lightBindingId ? 0.25 : 1 });
        material.opacity = object.opacity ?? 1;
        material.transparent = material.opacity < 1;
        material.depthWrite = !material.transparent;
        const mesh = new THREE.Mesh(geometry, keepRoom(material));
        mesh.position.set(object.position.x, object.position.y, object.position.z);
        mesh.rotation.set(object.rotation?.x || 0, object.rotation?.y || 0, object.rotation?.z || 0);
        mesh.userData.roomObject = object.id;
        if (object.kind !== 'mesh' && !object.lightBindingId) {
          const outline = new THREE.LineSegments(keepRoom(new THREE.EdgesGeometry(geometry)),
            keepRoom(new THREE.LineBasicMaterial({ color: 0x171a21, transparent: true, opacity: 0.3 * material.opacity, depthWrite: material.depthWrite })));
          mesh.add(outline);
        }
        if (object.lightBindingId) {
          // A glowing shell's own light: emitted at its colour whatever the emissive intensity, lit or not, lighting nothing else.
          const glow = new THREE.Color(object.lightAfterglow || '#000000').multiplyScalar(1 / material.emissiveIntensity);
          material.emissive.copy(glow);
          roomLightMaterials.set(object.id, { material, baseColor: material.color.clone(), tint: new THREE.Color(object.lightTint || '#ffffff'), glow });
        }
        if (object.role === 'wall') roomWalls.push({ mesh, model: object });
        if (object.role === 'screen') screens.push({ material: mesh.material, color: object.color || OBJECT_COLOUR });
        roomGroup.add(mesh);
      }
      scene.add(roomGroup);
      fitRoom();
      setCutaway(cutaway);
      controls.minDistance = 0.3;
    } else {
      controls.minDistance = 2;
      controls.maxDistance = 45;
      camera.far = 200;
      camera.updateProjectionMatrix();
    }
    lampGlowMaterial.size = model ? ROOM_GLOW.lamp : GLOW.lamp;
    cellGlowMaterial.size = model ? ROOM_GLOW.cell : GLOW.cell;
    view(activeView);
  }

  const trussMaterial = keep(new THREE.MeshBasicMaterial({ color: 0x2a2a30 }));
  const bodyMaterial = keep(new THREE.MeshBasicMaterial({ color: 0x1c1c21 }));
  const lensMaterial = keep(new THREE.MeshBasicMaterial({ color: 0xffffff }));
  const cellMaterial = keep(new THREE.MeshBasicMaterial({ color: 0xffffff }));
  let beamClip = beamClips([]).texture;
  const beamMaterial = keep(new THREE.ShaderMaterial({
    uniforms: { uHaze: { value: haze }, uClip: { value: beamClip }, uClipWidth: { value: CLIP_WIDTH } },
    vertexShader: BEAM_VERTEX,
    fragmentShader: BEAM_FRAGMENT,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  }));
  // Two sheets of pools, each with its own clips: those that show from the side their surface faces, and those on
  // a ceiling, which show from both (one draw, nothing culled).
  const poolClips = [poolClipTexture([]), poolClipTexture([])];
  const poolMaterials = [THREE.FrontSide, THREE.DoubleSide].map((side, sheet) => keep(new THREE.ShaderMaterial({
    uniforms: { uClip: { value: poolClips[sheet] }, uClipWidth: { value: CLIP_WIDTH },
      uFloor: { value: null }, uFloorBox: { value: new THREE.Vector4(0, 0, 1, 1) }, uFloorOn: { value: false } },
    vertexShader: POOL_VERTEX,
    fragmentShader: POOL_FRAGMENT,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side,
    forceSinglePass: true,
  })));
  const glowMap = keep(glowTexture());
  const glowMaterial = (size) => keep(new THREE.PointsMaterial({
    size, map: glowMap, vertexColors: true, transparent: true, depthWrite: false,
    // Bound overlapping halos so adding strip sections cannot turn their colour white.
    blending: THREE.CustomBlending, blendEquation: THREE.MaxEquation,
    blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, premultipliedAlpha: true, sizeAttenuation: true,
  }));
  const lampGlowMaterial = glowMaterial(GLOW.lamp);
  const cellGlowMaterial = glowMaterial(GLOW.cell);

  // The cone, apex at the origin, opening down −y to a radius of 1 at y = −1;
  // each beam scales it to its length and spread and turns it along its aim.
  const beamGeometry = keep(new THREE.ConeGeometry(1, 1, 36, 12, true).translate(0, -0.5, 0));
  const poolGeometry = keep(new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2));
  const bodyGeometry = keep(new THREE.CylinderGeometry(0.11, 0.15, 0.28, 18).translate(0, 0.14, 0));
  const lensGeometry = keep(new THREE.CircleGeometry(0.1, 24).rotateX(Math.PI / 2));
  const bulbGeometry = keep(new THREE.SphereGeometry(0.13, 18, 12));
  const cellGeometry = keep(new THREE.BoxGeometry(1, 1, 1));
  const shellEdges = keep(new THREE.EdgesGeometry(cellGeometry));
  const shellMaterial = keep(new THREE.MeshStandardMaterial({ color: 0x1a1c22, metalness: 0.5, roughness: 0.2, transparent: true, opacity: 0.28, depthWrite: false }));
  const shellEdgeMaterial = keep(new THREE.LineBasicMaterial({ color: 0xa0a6b4, transparent: true, opacity: 0.75 }));

  let rigGroup = null;
  let rigDisposables = [];
  let parts = null;
  let units = 0;

  const down = new THREE.Vector3(0, -1, 0);
  const tmpQ = new THREE.Quaternion();
  const tmpM = new THREE.Matrix4();
  const tmpV = new THREE.Vector3();
  const tmpS = new THREE.Vector3();
  const tmpX = new THREE.Vector3();
  const tmpY = new THREE.Vector3();
  const tmpZ = new THREE.Vector3();

  function instanced(geometry, material, count) {
    const mesh = new THREE.InstancedMesh(geometry, material, Math.max(1, count));
    mesh.count = count;
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, count) * 3), 3);
    mesh.frustumCulled = false;
    return mesh;
  }

  function points(count, material) {
    const geometry = new THREE.BufferGeometry();
    rigDisposables.push(geometry);
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(Math.max(1, count) * 3), 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(Math.max(1, count) * 3), 3));
    geometry.setDrawRange(0, count);
    const p = new THREE.Points(geometry, material);
    p.frustumCulled = false;
    return p;
  }

  let rigPlaced = null;
  /** Build the rig from placeRig(): its lamps, beams, pools, cells and trusses; the placement it shows already is kept. */
  function setRig(placed, unitCount) {
    if (placed === rigPlaced && unitCount === units) return;
    rigPlaced = placed;
    if (performanceReport) performanceReport.count('scene.rigBuilds');
    invalidate();
    lastLights = null;
    objectLights = placed.objectLights || [];
    for (const { material, baseColor, glow } of roomLightMaterials.values()) {
      material.emissive.copy(glow);
      material.color.copy(baseColor);
    }
    if (rigGroup) {
      scene.remove(rigGroup);
      rigGroup.traverse((o) => { if (o.isInstancedMesh) o.dispose(); });
      for (const thing of rigDisposables) thing.dispose();
      rigDisposables = [];
    }
    rigGroup = new THREE.Group();
    units = unitCount;
    const pars = placed.lamps.filter((l) => l.kind === 'par');
    const bulbs = placed.lamps.filter((l) => l.kind === 'bulb');
    // Every pool: a par's own, then those of the lights that throw no beam (world.roomRig).
    const pooled = [...pars, ...(placed.pools || [])];
    const sheets = [pooled.filter(({ pool }) => !onCeiling(pool)), pooled.filter(({ pool }) => onCeiling(pool))];

    const bodies = instanced(bodyGeometry, bodyMaterial, pars.length);
    const lenses = instanced(lensGeometry, lensMaterial, pars.length);
    // The cone, with each beam's clip beside its place and colour.
    const clips = beamClips(pars), cones = beamGeometry.clone();
    rigDisposables.push(cones);
    for (const [name, values, size] of [['aLeast', clips.least, 3], ['aMost', clips.most, 3], ['aWhere', clips.where, 4]]) {
      cones.setAttribute(name, new THREE.InstancedBufferAttribute(values, size));
    }
    const beams = instanced(cones, beamMaterial, pars.length);
    // Each sheet draws a quad of its own, with what each of its pools draws of it and how much of it is level (the
    // pool's window and run). The sheet of ceiling pools is made only for a rig that has one: any other draws and
    // links nothing for it.
    const pools = sheets.map((lights, sheet) => {
      if (sheet && !lights.length) return null;
      const quad = poolGeometry.clone();
      rigDisposables.push(quad);
      const windows = new Float32Array(Math.max(1, lights.length) * 4), runs = new Float32Array(Math.max(1, lights.length) * 2);
      const floors = new Float32Array(Math.max(1, lights.length));
      lights.forEach(({ pool }, k) => {
        windows.set(pool?.window ?? [0, 0, 1, 1], k * 4);
        runs.set(pool?.run ?? [0, 0], k * 2);
        floors[k] = pool?.floor ? 1 : 0;
      });
      quad.setAttribute('poolWindow', new THREE.InstancedBufferAttribute(windows, 4));
      quad.setAttribute('poolRun', new THREE.InstancedBufferAttribute(runs, 2));
      quad.setAttribute('poolFloor', new THREE.InstancedBufferAttribute(floors, 1));
      return instanced(quad, poolMaterials[sheet], lights.length);
    }).filter(Boolean);
    // Where each light's pool is coloured: its sheet's colours and its place among them.
    const poolOf = new Map();
    const bulbMesh = instanced(bulbGeometry, lensMaterial, bulbs.length);
    const cellMesh = instanced(cellGeometry, cellMaterial, placed.cells.length);
    const lampGlow = points(pars.length + bulbs.length, lampGlowMaterial);
    const cellGlow = points(placed.cells.length, cellGlowMaterial);

    pars.forEach((par, k) => {
      const aim = tmpV.set(par.aim.x, par.aim.y, par.aim.z).normalize();
      tmpQ.setFromUnitVectors(down, aim);
      // The body runs back from the lens (+y, which the turn sends behind it).
      const body = par.body ?? 1;
      tmpM.compose(new THREE.Vector3(par.position.x, par.position.y, par.position.z), tmpQ, tmpS.set(body, body, body));
      bodies.setMatrixAt(k, tmpM);
      tmpM.compose(new THREE.Vector3(par.position.x, par.position.y, par.position.z).addScaledVector(aim, 0.005), tmpQ, tmpS.set(body, body, body));
      lenses.setMatrixAt(k, tmpM);
      tmpM.compose(new THREE.Vector3(par.position.x, par.position.y, par.position.z), tmpQ, tmpS.set(par.radius, par.length, par.radius));
      beams.setMatrixAt(k, tmpM);
      lampGlow.geometry.attributes.position.setXYZ(k, par.position.x + aim.x * 0.05, par.position.y + aim.y * 0.05, par.position.z + aim.z * 0.05);
    });
    sheets.forEach((lights, sheet) => lights.forEach((light, k) => {
      // The flat pool turned onto its surface (world.poolOn): x along the slant, y out of the surface, z across.
      const { pool } = light;
      if (pool) tmpM.makeBasis(tmpX.set(pool.along.x, pool.along.y, pool.along.z).multiplyScalar(pool.major),
        tmpY.set(pool.normal.x, pool.normal.y, pool.normal.z), tmpZ.set(pool.across.x, pool.across.y, pool.across.z).multiplyScalar(pool.minor))
        .setPosition(pool.at.x, pool.at.y, pool.at.z);
      else tmpM.makeScale(0, 0, 0);
      pools[sheet].setMatrixAt(k, tmpM);
      poolOf.set(light, [pools[sheet].instanceColor, k]);
    }));
    bulbs.forEach((bulb, k) => {
      const body = bulb.body ?? 1;
      tmpM.compose(new THREE.Vector3(bulb.position.x, bulb.position.y, bulb.position.z), new THREE.Quaternion(), tmpS.set(body, body, body));
      bulbMesh.setMatrixAt(k, tmpM);
      lampGlow.geometry.attributes.position.setXYZ(pars.length + k, bulb.position.x, bulb.position.y, bulb.position.z);
    });
    placed.cells.forEach((cell, k) => {
      tmpQ.identity();
      if (cell.length) tmpQ.setFromUnitVectors(down, tmpV.set(cell.from.x - cell.to.x, cell.from.y - cell.to.y, cell.from.z - cell.to.z).normalize());
      tmpM.compose(new THREE.Vector3(cell.position.x, cell.position.y, cell.position.z), tmpQ, tmpS.set(cell.size, cell.length || cell.size, cell.size));
      cellMesh.setMatrixAt(k, tmpM);
      cellGlow.geometry.attributes.position.setXYZ(k, cell.position.x, cell.position.y, cell.position.z);
    });
    // A fixture drawn from its Rig plot has no room object: a dark, see-through body spans its pixels.
    for (const body of placed.bodies || []) {
      const shell = new THREE.Mesh(cellGeometry, shellMaterial);
      shell.position.set(body.position.x, body.position.y, body.position.z);
      shell.scale.set(body.size.x, body.size.y, body.size.z);
      shell.add(new THREE.LineSegments(shellEdges, shellEdgeMaterial));
      rigGroup.add(shell);
    }
    for (const truss of placed.trusses) {
      const geometry = new THREE.BoxGeometry(truss.to - truss.from, 0.22, 0.22);
      rigDisposables.push(geometry);
      const bar = new THREE.Mesh(geometry, trussMaterial);
      bar.position.set((truss.from + truss.to) / 2, truss.y + 0.11, truss.z);
      rigGroup.add(bar);
    }
    sheets.forEach((lights, sheet) => {
      poolClips[sheet].dispose();
      poolClips[sheet] = poolMaterials[sheet].uniforms.uClip.value = poolClipTexture(lights);
    });
    beamClip.dispose();
    beamClip = beamMaterial.uniforms.uClip.value = clips.texture;
    for (const mesh of [bodies, lenses, beams, ...pools, bulbMesh, cellMesh]) mesh.instanceMatrix.needsUpdate = true;
    lampGlow.geometry.attributes.position.needsUpdate = true;
    cellGlow.geometry.attributes.position.needsUpdate = true;
    rigGroup.add(beams, ...pools, bodies, lenses, bulbMesh, cellMesh, lampGlow, cellGlow);
    scene.add(rigGroup);
    parts = { pars, bulbs, cells: placed.cells, under: placed.pools || [], bodies, lenses, beams, pools, poolOf, bulbMesh, cellMesh, lampGlow, cellGlow };
  }

  const rgb = new Float32Array(3);
  const sourceRGB = new Float32Array(3);
  /** Colour every light from a frame: one emitter set per unit of the rig. */
  function setLights(frame) {
    if (!parts || !frame || frame === lastLights) return;
    lastLights = frame;
    const { pars, bulbs, cells, under, lenses, beams, poolOf, bulbMesh, cellMesh, lampGlow, cellGlow } = parts;
    const changed = new Set();
    const write = (attr, k, r, g, b) => {
      const at = k * 3;
      r = Math.fround(r); g = Math.fround(g); b = Math.fround(b);
      if (attr.array[at] === r && attr.array[at + 1] === g && attr.array[at + 2] === b) return;
      attr.array[at] = r; attr.array[at + 1] = g; attr.array[at + 2] = b;
      changed.add(attr);
    };
    const put = (attr, k, level) => {
      const off = Math.max(rgb[0], rgb[1], rgb[2]) === 0;
      write(attr, k, off ? OFF : rgb[0] * level, off ? OFF : rgb[1] * level, off ? OFF : rgb[2] * level);
    };
    const glow = (attr, k, level) => {
      write(attr, k, rgb[0] * level, rgb[1] * level, rgb[2] * level);
    };
    // A pool: its light at its level, as its surface reflects it (white where it has none, as in the generic venue). On
    // a room's floor the pool shader takes the colour from the floor's picture.
    const floorShown = poolMaterials[0].uniforms.uFloorOn.value;
    const reflected = (attr, k, pool) => {
      const [r, g, b] = (floorShown && pool?.floor) || !pool?.reflectance ? [1, 1, 1] : pool.reflectance, level = pool?.level ?? 0;
      write(attr, k, rgb[0] * level * r, rgb[1] * level * g, rgb[2] * level * b);
    };
    pars.forEach((par, k) => {
      landingRGB(par, frame, rgb, sourceRGB);
      put(lenses.instanceColor, k, 1);
      // The cone is as strong as the light its pool takes, full from what a beam of unknown lumen lands.
      glow(beams.instanceColor, k, Math.min(1, (par.pool?.level ?? PAR_LEVEL) / PAR_LEVEL));
      reflected(...poolOf.get(par), par.pool);
      glow(lampGlow.geometry.attributes.color, k, par.body === 0 ? 0 : 0.9);
    });
    under.forEach((light) => {
      landingRGB(light, frame, rgb, sourceRGB);
      reflected(...poolOf.get(light), light.pool);
    });
    bulbs.forEach((bulb, k) => {
      if (bulb.sources) meanLightRGB(bulb.sources, frame, rgb, sourceRGB);
      else lightRGB(frame[bulb.unit], rgb);
      put(bulbMesh.instanceColor, k, 1);
      glow(lampGlow.geometry.attributes.color, pars.length + k, 1);
    });
    cells.forEach((cell, k) => {
      if (cell.sources) meanLightRGB(cell.sources, frame, rgb, sourceRGB);
      else lightRGB(frame[cell.unit], rgb);
      put(cellMesh.instanceColor, k, 1);
      glow(cellGlow.geometry.attributes.color, k, cell.length ? 0 : 0.8);
    });
    objectLights.forEach((light) => {
      const surface = roomLightMaterials.get(light.objectId);
      if (!surface) return;
      const { material, baseColor, tint, glow } = surface;
      meanLightRGB(light.sources, frame, rgb, sourceRGB);
      rgb[0] *= tint.r; rgb[1] *= tint.g; rgb[2] *= tint.b;
      const r = rgb[0] + glow.r, g = rgb[1] + glow.g, b = rgb[2] + glow.b;
      if (material.emissive.r === r && material.emissive.g === g && material.emissive.b === b) return;
      material.emissive.setRGB(r, g, b);
      const neutral = 1 - Math.max(rgb[0], rgb[1], rgb[2]);
      material.color.setRGB(baseColor.r * neutral + rgb[0] * 0.35, baseColor.g * neutral + rgb[1] * 0.35, baseColor.b * neutral + rgb[2] * 0.35);
      invalidate();
    });
    for (const attr of changed) attr.needsUpdate = true;
    if (changed.size) invalidate();
  }

  function setHaze(value) {
    invalidate();
    const v = Math.max(0, Math.min(1, value));
    beamMaterial.uniforms.uHaze.value = v * 0.55;
    scene.fog.density = 0.012 + v * 0.03;
  }
  setHaze(haze);

  function view(name) {
    activeView = name;
    const v = views[name] || views.audience;
    camera.position.set(...v.position);
    controls.target.set(...v.target);
    controls.update();
  }
  view('audience');

  // Keys on the canvas: arrows orbit, + and − move closer and further.
  const spherical = new THREE.Spherical();
  function nudge({ turn = 0, tilt = 0, zoom = 1 }) {
    const offset = tmpV.copy(camera.position).sub(controls.target);
    spherical.setFromVector3(offset);
    spherical.theta += turn;
    spherical.phi = Math.max(0.15, Math.min(Math.PI / 2 - 0.02, spherical.phi + tilt));
    spherical.radius = Math.max(controls.minDistance, Math.min(controls.maxDistance, spherical.radius * zoom));
    camera.position.copy(controls.target).add(offset.setFromSpherical(spherical));
    controls.update();
  }

  /** Orbit around the surface under a canvas point, keeping the distance; false when nothing is there. */
  const raycaster = new THREE.Raycaster();
  function focusAt(clientX, clientY) {
    const box = canvas.getBoundingClientRect();
    raycaster.setFromCamera(new THREE.Vector2(((clientX - box.left) / box.width) * 2 - 1, -((clientY - box.top) / box.height) * 2 + 1), camera);
    const targets = [roomGroup, rigGroup].filter(Boolean);
    const hit = raycaster.intersectObjects(targets, true).find((h) => h.object.isMesh && h.object.visible)
      || (roomGroup ? null : raycaster.intersectObject(deck, false)[0]);
    if (!hit) return false;
    camera.position.add(tmpV.copy(hit.point).sub(controls.target));
    controls.target.copy(hit.point);
    controls.update();
    invalidate();
    return true;
  }

  let sizedTo = '';
  function resize() {
    invalidate();
    const box = canvas.parentElement ? canvas.parentElement.getBoundingClientRect() : canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(box.width));
    const h = Math.max(1, Math.round(box.height));
    // Setting a canvas's size, even to the same one, reallocates its drawing buffer.
    if (sizedTo === `${w}x${h}`) return;
    sizedTo = `${w}x${h}`;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    if (roomBounds) { fitRoom(); view(activeView); }
  }

  /** The live room picture on the room's screens (RGB24, row-major from the top-left); null darkens them again. */
  function setPicture(image) {
    if (performanceReport) performanceReport.count('scene.pictureInputs');
    if (!image) {
      for (const screen of screens) {
        if (!screen.material.map) continue;
        invalidate();
        screen.material.map = null; screen.material.color.set(screen.color); screen.material.needsUpdate = true;
      }
      return;
    }
    if (!screens.length) return;
    invalidate();
    const { width, height, data } = image;
    if (!screenTexture || screenTexture.image.width !== width || screenTexture.image.height !== height) {
      if (screenTexture) screenTexture.dispose();
      screenTexture = new THREE.DataTexture(new Uint8Array(width * height * 4), width, height, THREE.RGBAFormat);
      screenTexture.colorSpace = THREE.SRGBColorSpace;
      screenTexture.magFilter = THREE.LinearFilter;
      screenTexture.minFilter = THREE.LinearFilter;
      screenTexture.flipY = true;
    }
    const started = performanceReport ? performance.now() : 0;
    const rgba = screenTexture.image.data;
    for (let i = 0, j = 0; i < width * height; i++, j += 3) {
      rgba[i * 4] = data[j]; rgba[i * 4 + 1] = data[j + 1]; rgba[i * 4 + 2] = data[j + 2]; rgba[i * 4 + 3] = 255;
    }
    if (performanceReport) {
      performanceReport.count('scene.pictureConversions');
      performanceReport.sample('scene.pictureConversion', performance.now() - started);
    }
    screenTexture.needsUpdate = true;
    for (const screen of screens) {
      if (screen.material.map === screenTexture) continue;
      screen.material.map = screenTexture; screen.material.color.set('#ffffff'); screen.material.needsUpdate = true;
    }
  }

  let lastRenderAt = performance.now();
  function render() {
    const now = performance.now();
    // Preserve the 60 Hz decay per elapsed millisecond; pointer updates keep their normal factor.
    controls.dampingFactor = 1 - (1 - DAMPING) ** ((now - lastRenderAt) * 60 / 1000);
    controls.update();
    controls.dampingFactor = DAMPING;
    lastRenderAt = now;
    if (!dirty) return false;
    dirty = false;
    const started = performanceReport ? performance.now() : 0;
    renderer.render(scene, camera);
    for (const resource of retired) resource.dispose();
    retired = [];
    if (performanceReport) {
      performanceReport.count('scene.draws');
      performanceReport.sample('scene.renderSubmit', performance.now() - started);
    }
    return true;
  }

  function dispose() {
    controls.dispose();
    if (rigGroup) {
      scene.remove(rigGroup);
      rigGroup.traverse((o) => { if (o.isInstancedMesh) o.dispose(); });
    }
    for (const thing of rigDisposables) thing.dispose();
    for (const thing of [...roomDisposables, ...retired]) thing.dispose();
    if (screenTexture) screenTexture.dispose();
    for (const clip of poolClips) clip.dispose();
    beamClip.dispose();
    for (const thing of disposables) if (thing && thing.dispose) thing.dispose();
    renderer.dispose();
    // dispose() frees what the renderer allocated but not the context, which the
    // browser keeps (up to its limit) until the canvas is collected.
    renderer.forceContextLoss();
  }

  return {
    setRig, setLights, setHaze, setRoom, setCutaway, setPicture, view, nudge, focusAt, resize, render, dispose,
    /** The browser took the context away: this scene draws nothing more. */
    lost: () => renderer.getContext().isContextLost(),
    /** What is drawn, for tests and the page's description. */
    info: () => ({ units, pars: parts ? parts.pars.length : 0, bulbs: parts ? parts.bulbs.length : 0, cells: parts ? parts.cells.length : 0,
      pools: parts ? parts.pools.reduce((sum, mesh) => sum + mesh.count, 0) : 0 }),
  };
}
