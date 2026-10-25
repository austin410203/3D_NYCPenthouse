// The Aster — first-person walkthrough of the Blender-baked NYC penthouse scene.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { computeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import { roomsMaterial, shadeMaterial, cityMaterial } from './shaders.js';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

const A = 'assets/';
const isTouch = matchMedia('(pointer: coarse)').matches;
if (isTouch) document.body.classList.add('touch');
const lowEnd = isTouch || (navigator.hardwareConcurrency || 8) <= 4;

// Blender (z-up) -> three (y-up)
const B = (x, y, z) => new THREE.Vector3(x, z, -y);

// ------------------------------------------------------------------ renderer / scene
const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: !lowEnd, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, lowEnd ? 1.25 : 1.75));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.AgXToneMapping;
renderer.toneMappingExposure = 1.4;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(new THREE.Color(0.045, 0.055, 0.09), 0.00028);
const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.05, 9000);
camera.rotation.order = 'YXZ';
scene.add(new THREE.HemisphereLight(0x4a5878, 0x0c0a08, 0.35));   // only affects the few unbaked (foliage) materials

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.35, 0.5, 0.92);
if (!lowEnd) composer.addPass(bloom);
composer.addPass(new OutputPass());

// ------------------------------------------------------------------ loading
const manager = new THREE.LoadingManager();
const bar = document.getElementById('bar');
const ltext = document.getElementById('ltext');
manager.onProgress = (url, done, total) => {
  bar.style.width = (100 * done / total).toFixed(0) + '%';
  ltext.textContent = `載入場景中… ${done}/${total}`;
};
const draco = new DRACOLoader(manager).setDecoderPath('https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/libs/draco/gltf/');
const gltf = new GLTFLoader(manager).setDRACOLoader(draco);
const rgbe = new RGBELoader(manager);
const pmrem = new THREE.PMREMGenerator(renderer);

const loadHDR = (f) => new Promise((res, rej) => rgbe.load(A + f, res, undefined, rej));
const loadGLB = (f) => new Promise((res, rej) => gltf.load(A + f, (g) => res(g.scene), undefined, rej));
const loadBin = (f) => fetch(A + f).then((r) => r.arrayBuffer()).then((b) => new Float32Array(b));

const colliders = [];
const flames = [];
const emitScaled = [];
let envInt, envExt;

// ------------------------------------------------------------------ material setup
const FLAT = {   // city ground pieces (unbaked, night-dark)
  Roof: [0.010, 0.010, 0.012], Asphalt: [0.012, 0.012, 0.013], Sidewalk: [0.02, 0.02, 0.022], ParkGround: [0.006, 0.009, 0.005],
  LimestoneDark: [0.05, 0.045, 0.04], Steel: [0.05, 0.05, 0.05], Bark: [0.01, 0.008, 0.006],
};
const glassMat = (env, opacity = 0.14) => new THREE.MeshPhysicalMaterial({
  color: 0xdfe8e6, metalness: 0, roughness: 0.03, transparent: true, opacity, envMap: env, envMapIntensity: 1.0,
  depthWrite: false, side: THREE.DoubleSide,
});

// Exterior shells overlap the real penthouse volume (Blender hid the tower for interior shots); cut it out.
const CLIP_LO = 'vec3(-11.95, 26.05, 170.98)', CLIP_HI = 'vec3(11.95, 41.95, 175.45)';
function clipInterior(mat) {
  if (mat.isShaderMaterial) {
    if (!mat.fragmentShader.includes('varying vec3 vW')) return mat;
    mat.fragmentShader = mat.fragmentShader.replace('void main(){', `void main(){
  { vec3 cb = vec3(vW.x, -vW.z, vW.y); if (all(greaterThan(cb, ${CLIP_LO})) && all(lessThan(cb, ${CLIP_HI}))) discard; }`);
    return mat;
  }
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = 'varying vec3 vClipW;\n' + sh.vertexShader.replace('#include <project_vertex>',
      '#include <project_vertex>\n  vClipW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = 'varying vec3 vClipW;\n' + sh.fragmentShader.replace('void main() {', `void main() {
  { vec3 cb = vec3(vClipW.x, -vClipW.z, vClipW.y); if (all(greaterThan(cb, ${CLIP_LO})) && all(lessThan(cb, ${CLIP_HI}))) discard; }`);
  };
  mat.customProgramCacheKey = () => 'clipInterior';
  return mat;
}

function setupMaterials(root, area) {
  const env = area === 'int' ? envInt : envExt;
  root.traverse((o) => {
    if (!o.isMesh) return;
    const m = o.material;
    const name = m.name || '';
    const kind = (m.userData && m.userData.kind) || '';
    const pre = name.split('_')[0];
    let solid = true;
    if (pre === 'B') {
      m.envMap = env;
      m.envMapIntensity = 1.0;
      if (m.emissiveMap) m.emissiveMap.anisotropy = 8;
    } else if (pre === 'G') {
      o.material = glassMat(env, area === 'int' ? 0.1 : 0.16);
      o.renderOrder = 2;
      solid = area === 'int';          // street glass doors stay walkable; penthouse windows block
    } else if (pre === 'E') {
      // keep glTF emissive; nothing else to do
      solid = false;
    } else if (pre === 'L') {
      o.material = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.2, 1.7, 1.15) });
      solid = false;
    } else if (pre === 'H') {
      o.material = new THREE.MeshStandardMaterial({ color: 0x1a1816, emissive: new THREE.Color(0.32, 0.27, 0.22),
        transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false });
      solid = false;
    } else if (pre === 'F') {
      o.material = new THREE.MeshBasicMaterial({ color: new THREE.Color(4.0, 1.5, 0.35), transparent: true, opacity: 0.85,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
      flames.push(o);
      solid = false;
    } else if (pre === 'R') {
      o.material = roomsMaterial(m.userData.web_rooms);
      emitScaled.push(o.material);
      solid = false;
    } else if (pre === 'S') {
      o.material = shadeMaterial(m.userData.web_shade);
      emitScaled.push(o.material);
      solid = false;
    } else if (pre === 'V') {
      o.material = new THREE.MeshLambertMaterial({ color: new THREE.Color(0.05, 0.075, 0.03),
        emissive: new THREE.Color(0.012, 0.014, 0.006), side: THREE.DoubleSide });
      solid = false;
    } else if (pre === 'K') {
      const key = name.slice(2).split('.')[0];
      const c = FLAT[key] || [0.015, 0.015, 0.017];
      if (key === 'River' || key === 'ParkWater') {
        o.material = new THREE.MeshStandardMaterial({ color: 0x000000, roughness: 0.08, metalness: 0, envMap: envExt });
      } else {
        o.material = new THREE.MeshBasicMaterial({ color: new THREE.Color(...c) });
      }
      solid = false;
    }
    if (kind === 'foliage') solid = false;
    if (area === 'ext' && !o.material.isMeshBasicMaterial) clipInterior(o.material);
    if (solid) {
      o.userData.ext = area === 'ext';
      o.geometry.computeBoundsTree();
      colliders.push(o);
    }
  });
}

function setupCity(root) {
  root.traverse((o) => { if (o.isMesh) o.userData.srcMat = o.material.name || ''; });
  root.traverse((o) => {
    if (!o.isMesh) return;
    const name = o.material.name || '';
    if (name.startsWith('C_')) {
      const at = o.geometry.attributes;
      const find = (k) => Object.keys(at).find((n) => n.toLowerCase() === '_' + k) || '_' + k;
      const names = { rnd: find('rnd'), kind: find('kind'), fh: find('fh'), bw: find('bw') };
      o.material = cityMaterial((o.material.userData.web_city || [0.3])[0], names);
      emitScaled.push(o.material);
    }
  });
  setupMaterials(root, 'ext');
  // the whole city is walkable: ground, sidewalks, park lawn; building walls block. Water, lamps and the
  // low Central Park South wall are skipped so you can stroll into the park.
  root.traverse((o) => {
    if (!o.isMesh) return;
    const n = o.userData.srcMat + '|' + o.name;
    const skip = /Water|River|Hudson|EastRiver|Pond|Reservoir|Lake|LimestoneDark|ParkWall|Lamp|Light|Spire/i.test(n) || o.material.isMeshBasicMaterial && /Sodium|Head|Tail/.test(n);
    const i = colliders.indexOf(o);
    if (skip) { if (i >= 0) colliders.splice(i, 1); return; }
    if (i < 0) { o.geometry.computeBoundsTree(); colliders.push(o); }
    o.userData.ext = false;
  });
}

async function setupInstances() {
  const protos = await loadGLB('protos.glb');
  let canopy, leaf;
  protos.traverse((o) => {
    if (!o.isMesh) return;
    if (o.name.startsWith('TreeCanopy') || (!canopy && o.geometry.attributes.position.count > 200)) canopy = o;
    else leaf = o;
  });
  // park trees
  const t = await loadBin('park_trees.bin');
  const n = t.length / 5;
  const cMat = new THREE.MeshLambertMaterial({ emissive: new THREE.Color(0.006, 0.006, 0.004) });
  const trees = new THREE.InstancedMesh(canopy.geometry, cMat, n);
  const tg = new THREE.CylinderGeometry(0.2, 0.3, 5.6, 7); tg.translate(0, 2.8, 0);
  const trunks = new THREE.InstancedMesh(tg, new THREE.MeshLambertMaterial({ color: 0x1a1612 }), n);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), col = new THREE.Color();
  const tones = [[0.16, 0.19, 0.08], [0.22, 0.2, 0.08], [0.27, 0.19, 0.07], [0.3, 0.14, 0.05], [0.13, 0.17, 0.08]];
  for (let i = 0; i < n; i++) {
    const [x, y, z, rz, sc] = t.subarray(i * 5, i * 5 + 5);
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rz);
    s.setScalar(sc);
    m4.compose(B(x, y, z), q, s);
    trees.setMatrixAt(i, m4);
    const tn = tones[(i * 7919) % tones.length];
    trees.setColorAt(i, col.setRGB(tn[0], tn[1], tn[2]));
    trunks.setMatrixAt(i, m4);
  }
  scene.add(trees, trunks);
  // park path lamps
  const l = await loadBin('park_lamps.bin');
  const nl = l.length / 3;
  const lamps = new THREE.InstancedMesh(new THREE.SphereGeometry(0.5, 6, 4), new THREE.MeshBasicMaterial({ color: new THREE.Color(5, 3.6, 2.1) }), nl);
  for (let i = 0; i < nl; i++) { m4.makeTranslation(B(l[i * 3], l[i * 3 + 1], l[i * 3 + 2])); lamps.setMatrixAt(i, m4); }
  scene.add(lamps);
  // street-tree leaf cards (3x3 Blender basis + translation per instance)
  if (leaf) {
    const L = await loadBin('street_leaves.bin');
    const nn = L.length / 12;
    const lMat = new THREE.MeshLambertMaterial({ color: new THREE.Color(0.22, 0.17, 0.05), side: THREE.DoubleSide });
    const leaves = new THREE.InstancedMesh(leaf.geometry, lMat, nn);
    const C = new THREE.Matrix4().set(1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1);   // blender -> three
    const Ci = C.clone().invert();
    const Mb = new THREE.Matrix4(), S = new THREE.Matrix4().makeScale(1.4, 1.4, 1.4);
    for (let i = 0; i < nn; i++) {
      const r = L.subarray(i * 12, i * 12 + 12);
      Mb.set(r[0], r[3], r[6], r[9], r[1], r[4], r[7], r[10], r[2], r[5], r[8], r[11], 0, 0, 0, 1);
      m4.copy(C).multiply(Mb).multiply(Ci).multiply(S);
      leaves.setMatrixAt(i, m4);
    }
    scene.add(leaves);
  }
}

async function loadAll() {
  const man = await fetch(A + 'manifest.json').then((r) => r.json());
  const [sky, ei, ee] = await Promise.all([loadHDR('env_sky.hdr'), loadHDR('env_int.hdr'), loadHDR('env_ext.hdr')]);
  sky.mapping = THREE.EquirectangularReflectionMapping;
  scene.background = sky;
  scene.backgroundIntensity = 1.0;
  envInt = pmrem.fromEquirectangular(ei).texture;
  envExt = pmrem.fromEquirectangular(ee).texture;
  const groups = Object.keys(man);
  const jobs = groups.map((g) => loadGLB(g + '.glb').then((root) => { setupMaterials(root, man[g].area); scene.add(root); }));
  jobs.push(loadGLB('city.glb').then((r) => { setupCity(r); scene.add(r); }));
  jobs.push(setupInstances().catch((e) => console.warn('instances skipped', e)));
  await Promise.all(jobs);
}

// ------------------------------------------------------------------ player
const SPOTS = {
  street: { p: B(24, -12.6, 0.15), t: B(1, 15, 12), label: '57 街 · 黃昏藍調', exp: 1.5 },
  lobby: { p: B(0, 18.2, 0.6), t: B(0, 26, 3.0), label: '大廳', exp: 0.9 },
  living: { p: B(10.4, 29.4, 171), t: B(-2, 40, 172.3), label: '頂樓 · 客廳（171 m）', exp: 1.2 },
  view: { p: B(5.2, 29.4, 171), t: B(3.5, 60, 172.2), label: '頂樓 · 中央公園窗景', exp: 1.2 },
  fire: { p: B(5.9, 39.3, 171), t: B(12, 29.4, 172.3), label: '頂樓 · 壁爐區', exp: 1.2 },
  kitchen: { p: B(-3.4, 34.6, 171), t: B(-11.8, 29.2, 172.2), label: '頂樓 · 廚房', exp: 1.2 },
  park: { p: B(210, 214, 0.1), t: B(300, 262, 1.6), label: '中央公園 · The Pond', exp: 1.7 },
  aerial: { p: B(-189, -240, 290), t: B(10, 80, 175), label: '空拍 · 飛行模式', fly: true, exp: 1.6 },
};
const EYE = 1.65, RADIUS = 0.28, STEP = 0.48;
const player = { feet: new THREE.Vector3(), yaw: 0, pitch: 0, fly: false };
const keys = new Set();
let joy = { x: 0, y: 0 };

function lookAt(from, to) {
  const d = to.clone().sub(from);
  player.yaw = Math.atan2(-d.x, -d.z);
  player.pitch = Math.atan2(d.y, Math.hypot(d.x, d.z));
}

const fade = document.getElementById('fade');
const whereEl = document.getElementById('where');
function goto(name, instant = false) {
  const s = SPOTS[name];
  const apply = () => {
    player.fly = !!s.fly;
    player.feet.copy(s.p);
    const eye = s.p.clone(); if (!s.fly) eye.y += EYE;
    lookAt(eye, s.t);
    whereEl.textContent = s.label;
    document.querySelectorAll('#spots button').forEach((b) => b.classList.toggle('on', b.dataset.spot === name));
    renderer.toneMappingExposure = s.exp;
  };
  if (instant) return apply();
  fade.style.opacity = 1;
  setTimeout(() => { apply(); fade.style.opacity = 0; }, 450);
}

// --- collision helpers
const ray = new THREE.Raycaster(); ray.firstHitOnly = true;
const DOWN = new THREE.Vector3(0, -1, 0);
// hits on exterior shells inside the penthouse volume are clipped visually, so ignore them for collision too
const inClip = (h) => h.object.userData.ext && h.point.x > -11.95 && h.point.x < 11.95 && -h.point.z > 26.05 &&
  -h.point.z < 41.95 && h.point.y > 170.98 && h.point.y < 175.45;
const firstHit = () => ray.intersectObjects(colliders, false).find((h) => !inClip(h));
function groundAt(pos) {
  ray.set(new THREE.Vector3(pos.x, pos.y + STEP + 0.05, pos.z), DOWN);
  ray.far = STEP + 2.5;
  const h = firstHit();
  return h ? h.point.y : null;
}
function blocked(pos, dir, dist) {
  for (const hgt of [STEP + 0.04, 1.1]) {
    ray.set(new THREE.Vector3(pos.x, pos.y + hgt, pos.z), dir);
    ray.far = dist + RADIUS;
    const h = firstHit();
    if (h) return h;
  }
  return null;
}
const tmpN = new THREE.Vector3();
function moveWalk(dx, dz) {
  let mv = new THREE.Vector3(dx, 0, dz);
  for (let iter = 0; iter < 2 && mv.lengthSq() > 1e-8; iter++) {
    const len = mv.length();
    const dir = mv.clone().divideScalar(len);
    const hit = blocked(player.feet, dir, len);
    if (!hit) break;
    tmpN.copy(hit.face.normal).transformDirection(hit.object.matrixWorld); tmpN.y = 0;
    if (tmpN.lengthSq() < 1e-6) { mv.set(0, 0, 0); break; }
    tmpN.normalize();
    const into = mv.dot(tmpN);
    if (into < 0) mv.addScaledVector(tmpN, -into);
    const keep = Math.max(0, hit.distance - RADIUS);
    if (iter === 1) mv.setLength(Math.min(mv.length(), keep));
  }
  const next = player.feet.clone().add(mv);
  const g = groundAt(next);
  if (g === null) return;                         // no floor: don't walk off the world
  if (g - player.feet.y > STEP) return;           // too high to step up
  next.y = g;
  player.feet.copy(next);
}

// ------------------------------------------------------------------ input
function lockPointer() {
  try { const p = canvas.requestPointerLock(); if (p && p.catch) p.catch(() => {}); } catch (e) { /* embedded preview */ }
}
addEventListener('keydown', (e) => {
  keys.add(e.code);
  if (e.code === 'KeyE') useElevator();
  if (e.code === 'KeyF') { player.fly = !player.fly; if (!player.fly) { const g = groundAt(player.feet); if (g === null) goto('street'); } }
});
addEventListener('keyup', (e) => keys.delete(e.code));
canvas.addEventListener('click', () => { if (!isTouch && document.pointerLockElement !== canvas) lockPointer(); });
addEventListener('mousemove', (e) => {
  if (document.pointerLockElement !== canvas) return;
  player.yaw -= e.movementX * 0.0022;
  player.pitch = THREE.MathUtils.clamp(player.pitch - e.movementY * 0.0022, -1.45, 1.45);
});
// touch: joystick (left) + drag-look (right)
const joyEl = document.getElementById('joy'), knob = joyEl.querySelector('i');
let joyId = null, lookId = null, lx = 0, ly = 0;
joyEl.addEventListener('pointerdown', (e) => { joyId = e.pointerId; joyEl.setPointerCapture(e.pointerId); joyMove(e); });
joyEl.addEventListener('pointermove', (e) => { if (e.pointerId === joyId) joyMove(e); });
const joyEnd = (e) => { if (e.pointerId === joyId) { joyId = null; joy = { x: 0, y: 0 }; knob.style.transform = ''; } };
joyEl.addEventListener('pointerup', joyEnd); joyEl.addEventListener('pointercancel', joyEnd);
function joyMove(e) {
  const r = joyEl.getBoundingClientRect();
  let x = (e.clientX - r.left - r.width / 2) / (r.width / 2), y = (e.clientY - r.top - r.height / 2) / (r.height / 2);
  const l = Math.hypot(x, y); if (l > 1) { x /= l; y /= l; }
  joy = { x, y };
  knob.style.transform = `translate(${x * 37}px, ${y * 37}px)`;
}
canvas.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'mouse') { lookId = e.pointerId; lx = e.clientX; ly = e.clientY; } });
canvas.addEventListener('pointermove', (e) => {
  if (e.pointerId !== lookId) return;
  player.yaw -= (e.clientX - lx) * 0.005;
  player.pitch = THREE.MathUtils.clamp(player.pitch - (e.clientY - ly) * 0.005, -1.4, 1.4);
  lx = e.clientX; ly = e.clientY;
});
const lookEnd = (e) => { if (e.pointerId === lookId) lookId = null; };
canvas.addEventListener('pointerup', lookEnd); canvas.addEventListener('pointercancel', lookEnd);

document.querySelectorAll('#spots button').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); goto(b.dataset.spot); }));
document.getElementById('help-x').addEventListener('click', () => (document.getElementById('help').hidden = true));

// ------------------------------------------------------------------ elevator
const promptEl = document.getElementById('prompt');
const elevBtn = document.getElementById('elev-btn');
function zone() {
  const b = { x: player.feet.x, y: -player.feet.z, z: player.feet.y };
  if (player.fly) return null;
  if (b.z < 3 && Math.abs(b.x) < 5 && b.y > 23.5 && b.y < 30) return 'up';
  if (b.z > 170 && b.x > -4.5 && b.x < 1 && b.y < 28.2) return 'down';
  return null;
}
function useElevator() {
  const z = zone();
  if (z === 'up') goto('living');
  else if (z === 'down') goto('lobby');
}
elevBtn.addEventListener('click', useElevator);

// ------------------------------------------------------------------ loop
const clock = new THREE.Clock();
const fwd = new THREE.Vector3(), right = new THREE.Vector3();
function frame() {
  const dt = Math.min(clock.getDelta(), 0.05);
  const run = keys.has('ShiftLeft') || keys.has('ShiftRight');
  let f = 0, s = 0;
  if (keys.has('KeyW') || keys.has('ArrowUp')) f += 1;
  if (keys.has('KeyS') || keys.has('ArrowDown')) f -= 1;
  if (keys.has('KeyD') || keys.has('ArrowRight')) s += 1;
  if (keys.has('KeyA') || keys.has('ArrowLeft')) s -= 1;
  f -= joy.y; s += joy.x;
  fwd.set(-Math.sin(player.yaw), 0, -Math.cos(player.yaw));
  right.set(-fwd.z, 0, fwd.x);
  if (player.fly) {
    const sp = (run ? 120 : 35) * dt;
    const look = new THREE.Vector3(0, 0, -1).applyEuler(new THREE.Euler(player.pitch, player.yaw, 0, 'YXZ'));
    player.feet.addScaledVector(look, f * sp).addScaledVector(right, s * sp);
    if (keys.has('Space')) player.feet.y += sp;
    if (keys.has('KeyC')) player.feet.y -= sp;
    camera.position.copy(player.feet);
  } else {
    const sp = (run ? 9 : 2.0) * dt;
    if (f || s) {
      const mv = fwd.clone().multiplyScalar(f).addScaledVector(right, s);
      if (mv.lengthSq() > 1) mv.normalize();
      mv.multiplyScalar(sp);
      moveWalk(mv.x, mv.z);
    }
    camera.position.set(player.feet.x, player.feet.y + EYE, player.feet.z);
  }
  camera.rotation.set(player.pitch, player.yaw, 0);
  const bz = player.feet.y, by = -player.feet.z;
  const bx = player.feet.x;
  const inLobby = bz > 0.45 && bz < 8 && by > 15.3 && by < 30 && Math.abs(bx) < 15;
  const targetExp = player.fly ? 1.6 : bz > 150 ? 1.2 : inLobby ? 0.9 : by > 170 ? 1.7 : 1.5;
  renderer.toneMappingExposure += (targetExp - renderer.toneMappingExposure) * Math.min(1, dt * 2.5);
  // fire flicker
  const t = clock.elapsedTime;
  for (const fl of flames) fl.material.opacity = 0.7 + 0.25 * Math.sin(t * 11 + fl.id) * Math.sin(t * 7.3);
  // elevator prompt
  const z = zone();
  promptEl.hidden = !z;
  elevBtn.hidden = !(z && isTouch);
  if (z) promptEl.textContent = z === 'up' ? '按 E 搭電梯上頂樓（171 m）' : '按 E 搭電梯回大廳';
  composer.render();
  requestAnimationFrame(frame);
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight); composer.setSize(innerWidth, innerHeight);
});

// ------------------------------------------------------------------ boot
loadAll().then(() => {
  goto('street', true);
  ltext.textContent = '載入完成';
  const btn = document.getElementById('enter');
  btn.hidden = false;
  btn.onclick = () => {
    const L = document.getElementById('loader');
    L.style.opacity = 0; setTimeout(() => L.remove(), 800);
    if (!isTouch) lockPointer();
  };
  window.__dbg = { scene, camera, player, goto, colliders, renderer, moveWalk, groundAt, zone };
  requestAnimationFrame(frame);
}).catch((e) => { ltext.textContent = '載入失敗：' + e.message; console.error(e); });
