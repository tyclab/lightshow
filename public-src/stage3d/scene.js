import { performanceReport } from '../performance.js';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { roomObjectGeometry } from './room-geometry.js';
import { meanLightRGB, ROOM_LIGHTS, roomViews, STAGE_FOV } from './world.js';

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
 * An imported room is lit: its surfaces shade under a dim fill and take the
 * colour of the lights near them from ROOM_LIGHTS point lights, each standing
 * in its room where a cluster of its emitters is (world.roomLights) and mixing
 * their live colours. A fixed number of lights keeps every frame and every
 * patch on the same shader programs. The walls, floors and ceilings as built
 * shadow those lights, drawn full height, cut away or hidden: a mesh of them
 * that only the lights' shadow cameras see, whose maps render again only when
 * the room, the rig or a light's place changes.
 *
 * Loaded on its own (three.js is most of it), the first time the Stage view
 * opens. `createStageScene` throws when the browser has no WebGL.
 *
 * It imports nothing of the app's: the room's size and the colour of a light
 * (world.js) are handed in, so this chunk shares no code with the page's and
 * the page loads, and opens offline, without it.
 */

const BG = 0x050507;
const OFF = 0.035;      // what an unlit lens or cell shows: its shape, not a light
const DAMPING = 0.08;
// A cluster's summed linear RGB times this is its point light's intensity (candela at decay 2).
const ROOM_LIGHT_GAIN = 0.9;
const GLOW = { lamp: 1.1, cell: 0.5 };
const ROOM_GLOW = { lamp: 0.45, cell: 0.09 };
// Room light's shadows: 256² maps whose near plane takes in a wall beside a lamp, the receiver moved off a
// surface the blockers share; slabs just under the floor and over the ceiling; the layer only shadow cameras render.
const SHADOW = { size: 256, near: 0.05, normalBias: 0.03 };
const SLAB = { gap: 0.01, depth: 0.02 };
const BLOCKERS = 1;

const BEAM_VERTEX = /* glsl */`
  varying vec3 vColor;
  varying float vT;
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    vec4 world = instanceMatrix * vec4(position, 1.0);
    vec4 view = modelViewMatrix * world;
    vView = view.xyz;
    vNormal = normalize(normalMatrix * mat3(instanceMatrix) * normal);
    vColor = instanceColor;
    vT = -position.y;
    gl_Position = projectionMatrix * view;
  }
`;

const BEAM_FRAGMENT = /* glsl */`
  uniform float uHaze;
  varying vec3 vColor;
  varying float vT;
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    // Brightest through the middle of the cone, where the eye looks through
    // the most haze, and fading from the lens to where it lands.
    float facing = pow(abs(dot(normalize(vNormal), normalize(-vView))), 1.6);
    float along = pow(clamp(1.0 - vT, 0.0, 1.0), 1.3) * smoothstep(0.0, 0.05, vT);
    gl_FragColor = vec4(vColor * uHaze * facing * along, 1.0);
    #include <colorspace_fragment>
  }
`;

const POOL_VERTEX = /* glsl */`
  varying vec3 vColor;
  varying vec2 vUv;
  varying vec3 vWorld;
  varying vec3 vCentre;
  flat varying int vPool;
  void main() {
    vColor = instanceColor;
    vUv = uv;
    vec4 world = modelMatrix * instanceMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    vCentre = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
    vPool = gl_InstanceID;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

// Each pool's clip (world.js poolClip) as texels of uClip from the pool's own header: its surface box
// (centre, then three axes with their half sizes), then where its room's edges and its walls' boxes are.
const POOL_FRAGMENT = /* glsl */`
  uniform float uStrength;
  uniform sampler2D uClip;
  uniform int uClipWidth;
  varying vec3 vColor;
  varying vec2 vUv;
  varying vec3 vWorld;
  varying vec3 vCentre;
  flat varying int vPool;
  vec4 clipAt(int i) { return texelFetch(uClip, ivec2(i % uClipWidth, i / uClipWidth), 0); }
  bool inBox(vec3 p, int at) {
    vec3 d = p - clipAt(at).xyz;
    for (int i = 1; i <= 3; i++) { vec4 axis = clipAt(at + i); if (abs(dot(d, axis.xyz)) > axis.w) return false; }
    return true;
  }
  bool crosses(vec3 from, vec3 to, int at) {
    vec3 o = from - clipAt(at).xyz, d = to - from;
    float enter = 0.0, leave = 1.0;
    for (int i = 1; i <= 3; i++) {
      vec4 axis = clipAt(at + i);
      float p = dot(o, axis.xyz), along = dot(d, axis.xyz);
      if (abs(along) < 1e-9) { if (abs(p) > axis.w) return false; continue; }
      float a = (-axis.w - p) / along, b = (axis.w - p) / along;
      enter = max(enter, min(a, b)); leave = min(leave, max(a, b));
    }
    return enter <= leave;
  }
  void main() {
    int head = vPool * 5;
    vec4 where = clipAt(head + 4);
    if (clipAt(head).w > 0.5 && !inBox(vWorld, head)) discard;
    int edges = int(where.y + 0.5);
    if (edges > 0) {
      bool inside = false;
      for (int i = 0; i < edges; i++) {
        vec4 e = clipAt(int(where.x + 0.5) + i);
        if ((e.y > vWorld.z) != (e.w > vWorld.z) && vWorld.x < (e.z - e.x) * (vWorld.z - e.y) / (e.w - e.y) + e.x) inside = !inside;
      }
      if (!inside) discard;
    }
    int walls = int(where.w + 0.5);
    for (int i = 0; i < walls; i++) if (crosses(vCentre, vWorld, int(where.z + 0.5) + i * 4)) discard;
    float d = length(vUv - 0.5) * 2.0;
    float fall = pow(clamp(1.0 - d, 0.0, 1.0), 1.8);
    gl_FragColor = vec4(vColor * fall * uStrength, 1.0);
    #include <colorspace_fragment>
  }
`;

const CLIP_WIDTH = 1024;
/** uClip's texels for these pars' pools: five per pool, then the room edges and wall boxes they point to. */
function poolClipTexture(pars) {
  const texels = [], tail = [];
  const box = (target, { centre, axes, half }, flag = 0) => {
    target.push([centre.x, centre.y, centre.z, flag]);
    axes.forEach((axis, i) => target.push([axis.x, axis.y, axis.z, half[i]]));
  };
  const head = pars.length * 5;
  for (const { pool } of pars) {
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

/**
 * Everything that stops room light, in world space at full height: every wall as built, its openings
 * open, and a thin slab under each room's floor and over its ceiling (the room box's without polygons).
 * Only its positions: the shadow pass needs nothing else.
 */
function blockerGeometry(model) {
  const parts = [];
  const matrix = new THREE.Matrix4(), turn = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1);
  for (const object of model.objects) {
    if (object.role !== 'wall') continue;
    const r = object.rotation || { x: 0, y: 0, z: 0 };
    turn.setFromEuler(new THREE.Euler(r.x, r.y, r.z));
    parts.push(roomObjectGeometry(object).applyMatrix4(matrix.compose(new THREE.Vector3(object.position.x, object.position.y, object.position.z), turn, one)));
  }
  const { width, depth, height } = model.bounds;
  const outlines = model.rooms?.length ? model.rooms.map((area) => area.polygon)
    : [[[-width / 2, -depth / 2], [width / 2, -depth / 2], [width / 2, depth / 2], [-width / 2, depth / 2]]];
  for (const outline of outlines) for (const y of [-SLAB.gap - SLAB.depth, height + SLAB.gap]) {
    const shape = new THREE.Shape(outline.map(([x, z]) => new THREE.Vector2(x, -z)));
    parts.push(new THREE.ExtrudeGeometry(shape, { depth: SLAB.depth, bevelEnabled: false }).rotateX(-Math.PI / 2).translate(0, y, 0));
  }
  let count = 0;
  for (const part of parts) count += part.index ? part.index.count : part.attributes.position.count;
  const positions = new Float32Array(count * 3);
  let at = 0;
  for (const part of parts) {
    const source = part.attributes.position;
    const n = part.index ? part.index.count : source.count;
    for (let i = 0; i < n; i++, at += 3) {
      const k = part.index ? part.index.getX(i) : i;
      positions[at] = source.getX(k); positions[at + 1] = source.getY(k); positions[at + 2] = source.getZ(k);
    }
    part.dispose();
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.computeBoundingSphere();
  return geometry;
}

/** A soft round dot, for the glow around lenses, bulbs and cells. */
function glowTexture() {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(255,255,255,0.45)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
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

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.setClearColor(BG, 1);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.autoUpdate = false;
  const refreshShadows = () => { renderer.shadowMap.needsUpdate = true; };

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
  // The room's lights, made once: the same count in every room and frame keeps the lit materials' programs.
  const roomLights = Array.from({ length: ROOM_LIGHTS }, () => {
    const light = new THREE.PointLight(0xffffff, 0, 0, 2);
    light.visible = false;
    light.castShadow = true;
    light.shadow.mapSize.set(SHADOW.size, SHADOW.size);
    light.shadow.camera.near = SHADOW.near;
    light.shadow.camera.layers.set(BLOCKERS);
    light.shadow.normalBias = SHADOW.normalBias;
    scene.add(light);
    return light;
  });
  let roomLightOn = true;
  let clusters = [];
  let roomGroup = null;
  let roomDisposables = [];
  let cutaway = true;
  let roomWalls = [];
  let roomLightMaterials = new Map();
  let objectLights = [];
  let objectClusters = [];
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

  let roomModel;
  function setRoom(model) {
    // The room this scene already shows: a view that mounts again keeps it, and its materials' programs.
    if (model === roomModel) return;
    roomModel = model;
    invalidate();
    if (roomGroup) { scene.remove(roomGroup); roomGroup.clear(); }
    for (const resource of roomDisposables) resource.dispose();
    roomDisposables = [];
    roomWalls = [];
    roomLightMaterials = new Map();
    lastLights = null;
    screens = [];
    if (screenTexture) { screenTexture.dispose(); screenTexture = null; }
    roomGroup = null;
    floor.visible = deck.visible = wall.visible = !model;
    roomBounds = model?.bounds || null;
    views = genericViews;
    if (model) {
      roomGroup = new THREE.Group();
      const keepRoom = (resource) => { roomDisposables.push(resource); return resource; };
      const ground = new THREE.Mesh(
        keepRoom(new THREE.PlaneGeometry(model.bounds.width, model.bounds.depth)),
        keepRoom(new THREE.MeshStandardMaterial({ color: 0x2a2d35, roughness: 0.95, side: THREE.DoubleSide })),
      );
      ground.rotation.x = -Math.PI / 2;
      ground.receiveShadow = true;
      roomGroup.add(ground);
      for (const area of model.rooms) {
        const shape = new THREE.Shape(area.polygon.map(([x, z]) => new THREE.Vector2(x, -z)));
        const geometry = keepRoom(new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2));
        const material = keepRoom(new THREE.MeshStandardMaterial({ color: area.color || 0x3a3e48, roughness: 0.9, side: THREE.DoubleSide }));
        const mesh = new THREE.Mesh(geometry, material);
        mesh.position.y = 0.003;
        mesh.receiveShadow = true;
        roomGroup.add(mesh);
      }
      // Seen by the shadow cameras only, never drawn; kept visible, since the shadow pass skips what is not.
      const blockers = new THREE.Mesh(keepRoom(blockerGeometry(model)),
        keepRoom(new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, shadowSide: THREE.DoubleSide })));
      blockers.layers.set(BLOCKERS);
      blockers.castShadow = true;
      roomGroup.add(blockers);
      // A dim fill, so the room reads with its lights off; its lights colour it from there.
      roomGroup.add(keepRoom(new THREE.HemisphereLight(0xc8d0e0, 0x30323a, 0.75)));
      const key = keepRoom(new THREE.DirectionalLight(0xffffff, 0.45));
      key.position.set(-3, 6, 4);
      roomGroup.add(key);
      for (const object of model.objects) {
        const geometry = keepRoom(roomObjectGeometry(object));
        // A screen shows the room picture as it is; everything else is a surface the light falls on.
        const material = object.role === 'screen' ? new THREE.MeshBasicMaterial({ color: object.color || '#747985' })
          : new THREE.MeshStandardMaterial({ color: object.color || '#747985', roughness: 0.85, emissiveIntensity: object.lightBindingId ? 0.25 : 1 });
        material.opacity = object.opacity ?? 1;
        material.transparent = material.opacity < 1;
        material.depthWrite = !material.transparent;
        const mesh = new THREE.Mesh(geometry, keepRoom(material));
        mesh.position.set(object.position.x, object.position.y, object.position.z);
        mesh.rotation.set(object.rotation?.x || 0, object.rotation?.y || 0, object.rotation?.z || 0);
        mesh.userData.roomObject = object.id;
        mesh.receiveShadow = true;
        if (object.kind !== 'mesh' && !object.lightBindingId) {
          const outline = new THREE.LineSegments(keepRoom(new THREE.EdgesGeometry(geometry)),
            keepRoom(new THREE.LineBasicMaterial({ color: 0x171a21, transparent: true, opacity: 0.3 * material.opacity, depthWrite: material.depthWrite })));
          mesh.add(outline);
        }
        if (object.lightBindingId) roomLightMaterials.set(object.id, { material, baseColor: material.color.clone(), tint: new THREE.Color(object.lightTint || '#ffffff') });
        if (object.role === 'wall') roomWalls.push({ mesh, model: object });
        if (object.role === 'screen') screens.push({ material: mesh.material, color: object.color || '#747985' });
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
    placeRoomLights();
    view(activeView);
  }

  const trussMaterial = keep(new THREE.MeshBasicMaterial({ color: 0x2a2a30 }));
  const bodyMaterial = keep(new THREE.MeshBasicMaterial({ color: 0x1c1c21 }));
  const lensMaterial = keep(new THREE.MeshBasicMaterial({ color: 0xffffff }));
  const cellMaterial = keep(new THREE.MeshBasicMaterial({ color: 0xffffff }));
  const beamMaterial = keep(new THREE.ShaderMaterial({
    uniforms: { uHaze: { value: haze } },
    vertexShader: BEAM_VERTEX,
    fragmentShader: BEAM_FRAGMENT,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  }));
  let poolClip = poolClipTexture([]);
  const poolMaterial = keep(new THREE.ShaderMaterial({
    uniforms: { uStrength: { value: 0.9 }, uClip: { value: poolClip }, uClipWidth: { value: CLIP_WIDTH } },
    vertexShader: POOL_VERTEX,
    fragmentShader: POOL_FRAGMENT,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  }));
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
    objectClusters = placed.objectClusters || [];
    clusters = placed.clusters || [];
    placeRoomLights();
    for (const { material, baseColor } of roomLightMaterials.values()) {
      material.emissive.setRGB(0, 0, 0);
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

    const bodies = instanced(bodyGeometry, bodyMaterial, pars.length);
    const lenses = instanced(lensGeometry, lensMaterial, pars.length);
    const beams = instanced(beamGeometry, beamMaterial, pars.length);
    const pools = instanced(poolGeometry, poolMaterial, pars.length);
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
      // The flat pool turned onto its surface (world.poolOn): x along the slant, y out of the surface, z across.
      const { pool } = par;
      if (pool) tmpM.makeBasis(tmpX.set(pool.along.x, pool.along.y, pool.along.z).multiplyScalar(pool.major),
        tmpY.set(pool.normal.x, pool.normal.y, pool.normal.z), tmpZ.set(pool.across.x, pool.across.y, pool.across.z).multiplyScalar(pool.minor))
        .setPosition(pool.at.x, pool.at.y, pool.at.z);
      else tmpM.makeScale(0, 0, 0);
      pools.setMatrixAt(k, tmpM);
      lampGlow.geometry.attributes.position.setXYZ(k, par.position.x + aim.x * 0.05, par.position.y + aim.y * 0.05, par.position.z + aim.z * 0.05);
    });
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
    poolClip.dispose();
    poolClip = poolMaterial.uniforms.uClip.value = poolClipTexture(pars);
    for (const mesh of [bodies, lenses, beams, pools, bulbMesh, cellMesh]) mesh.instanceMatrix.needsUpdate = true;
    lampGlow.geometry.attributes.position.needsUpdate = true;
    cellGlow.geometry.attributes.position.needsUpdate = true;
    rigGroup.add(beams, pools, bodies, lenses, bulbMesh, cellMesh, lampGlow, cellGlow);
    scene.add(rigGroup);
    parts = { pars, bulbs, cells: placed.cells, bodies, lenses, beams, pools, bulbMesh, cellMesh, lampGlow, cellGlow };
  }

  const rgb = new Float32Array(3);
  const sourceRGB = new Float32Array(3);
  /** Colour every light from a frame: one emitter set per unit of the rig. */
  function setLights(frame) {
    if (!parts || !frame || frame === lastLights) return;
    lastLights = frame;
    const { pars, bulbs, cells, lenses, beams, pools, bulbMesh, cellMesh, lampGlow, cellGlow } = parts;
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
    const lit = clusters.length ? new Float32Array(clusters.length * 3) : null;
    const add = (emitter) => {
      if (!lit || emitter.cluster === undefined) return;
      const at = emitter.cluster * 3, weight = emitter.weight;
      lit[at] += rgb[0] * weight; lit[at + 1] += rgb[1] * weight; lit[at + 2] += rgb[2] * weight;
    };
    pars.forEach((par, k) => {
      if (par.sources) meanLightRGB(par.sources, frame, rgb, sourceRGB);
      else lightRGB(frame[par.unit], rgb);
      put(lenses.instanceColor, k, 1);
      glow(beams.instanceColor, k, 1);
      glow(pools.instanceColor, k, par.pool?.level ?? 1);
      glow(lampGlow.geometry.attributes.color, k, par.body === 0 ? 0 : 0.9);
      add(par);
    });
    bulbs.forEach((bulb, k) => {
      if (bulb.sources) meanLightRGB(bulb.sources, frame, rgb, sourceRGB);
      else lightRGB(frame[bulb.unit], rgb);
      put(bulbMesh.instanceColor, k, 1);
      glow(lampGlow.geometry.attributes.color, pars.length + k, 1);
      add(bulb);
    });
    cells.forEach((cell, k) => {
      if (cell.sources) meanLightRGB(cell.sources, frame, rgb, sourceRGB);
      else lightRGB(frame[cell.unit], rgb);
      put(cellMesh.instanceColor, k, 1);
      glow(cellGlow.geometry.attributes.color, k, cell.length ? 0 : 0.8);
      add(cell);
    });
    objectLights.forEach((light, k) => {
      const surface = roomLightMaterials.get(light.objectId);
      if (!surface) return;
      const { material, baseColor, tint } = surface;
      meanLightRGB(light.sources, frame, rgb, sourceRGB);
      rgb[0] *= tint.r; rgb[1] *= tint.g; rgb[2] *= tint.b;
      if (objectClusters[k]) add(objectClusters[k]);
      if (material.emissive.r === rgb[0] && material.emissive.g === rgb[1] && material.emissive.b === rgb[2]) return;
      material.emissive.setRGB(rgb[0], rgb[1], rgb[2]);
      const neutral = 1 - Math.max(rgb[0], rgb[1], rgb[2]);
      material.color.setRGB(baseColor.r * neutral + rgb[0] * 0.35, baseColor.g * neutral + rgb[1] * 0.35, baseColor.b * neutral + rgb[2] * 0.35);
      invalidate();
    });
    for (const attr of changed) attr.needsUpdate = true;
    if (changed.size) invalidate();
    if (lit) roomLights.forEach((light, c) => {
      if (c >= clusters.length) return;
      const r = lit[c * 3] * ROOM_LIGHT_GAIN, g = lit[c * 3 + 1] * ROOM_LIGHT_GAIN, b = lit[c * 3 + 2] * ROOM_LIGHT_GAIN;
      const peak = Math.max(r, g, b), was = light.userData.rgb;
      if (was && was[0] === r && was[1] === g && was[2] === b) return;
      light.userData.rgb = [r, g, b];
      light.intensity = peak;
      if (peak > 0) light.color.setRGB(r / peak, g / peak, b / peak);
      invalidate();
    });
  }

  /** The room's lights where the clusters of the rig it shows stand. All of them are on whenever a room is
   * (unused ones dark), so a patch with fewer clusters never changes the light count the programs were built for. */
  function placeRoomLights() {
    invalidate();
    refreshShadows();
    roomLights.forEach((light, c) => {
      const at = clusters[c];
      light.visible = !!roomModel && roomLightOn;
      light.intensity = 0;
      light.userData.rgb = null;
      if (at && roomBounds) light.position.set(at.x, at.y, at.z);
      // Out to the room box's farthest corner, a metre past its walls where objects may stand.
      if (roomBounds) {
        const { width, depth, height } = roomBounds, p = light.position;
        light.shadow.camera.far = Math.hypot(width / 2 + 1 + Math.abs(p.x), Math.max(Math.abs(p.y + 1), Math.abs(height + 1 - p.y)), depth / 2 + 1 + Math.abs(p.z));
        light.shadow.camera.updateProjectionMatrix();
      }
    });
    lastLights = null;
  }

  function setRoomLight(on) {
    if (roomLightOn === !!on) return;
    roomLightOn = !!on;
    placeRoomLights();
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
    const shadows = renderer.shadowMap.needsUpdate;
    renderer.render(scene, camera);
    if (performanceReport) {
      // three clears the request once the maps are drawn, and keeps it while no light casts a shadow.
      if (shadows && !renderer.shadowMap.needsUpdate) performanceReport.count('scene.shadowMaps');
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
    for (const thing of roomDisposables) thing.dispose();
    if (screenTexture) screenTexture.dispose();
    poolClip.dispose();
    for (const thing of disposables) if (thing && thing.dispose) thing.dispose();
    renderer.dispose();
    // dispose() frees what the renderer allocated but not the context, which the
    // browser keeps (up to its limit) until the canvas is collected.
    renderer.forceContextLoss();
  }

  return {
    setRig, setLights, setHaze, setRoom, setCutaway, setRoomLight, setPicture, view, nudge, focusAt, resize, render, dispose,
    /** What is drawn, for tests and the page's description. */
    info: () => ({ units, pars: parts ? parts.pars.length : 0, bulbs: parts ? parts.bulbs.length : 0, cells: parts ? parts.cells.length : 0,
      roomLights: roomLights.filter((light) => light.visible).map((light) => ({ intensity: light.intensity, color: light.color.getHex(), at: light.position.toArray() })) }),
  };
}
