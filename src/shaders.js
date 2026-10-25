// GLSL ports of the Blender procedural "lit windows" shaders (city blocks, fake tower interiors, roller shades).
// World space here is three.js (y-up); Blender coords are recovered as b = (x, -z, y).
import * as THREE from 'three';

const HASH = /* glsl */`
float h1(vec3 p){ p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
  float a = h1(vec3(i,0.)), b = h1(vec3(i+vec2(1,0),0.)), c = h1(vec3(i+vec2(0,1),0.)), d = h1(vec3(i+vec2(1,1),0.));
  return mix(mix(a,b,f.x), mix(c,d,f.x), f.y); }
vec3 warmRamp(float t){
  vec3 c = mix(vec3(1.0,0.60,0.30), vec3(1.0,0.75,0.50), smoothstep(0.0,0.5,t));
  c = mix(c, vec3(1.0,0.86,0.70), smoothstep(0.5,0.9,t));
  return mix(c, vec3(0.9,0.93,1.0), smoothstep(0.9,1.0,t)); }
`;

const VERT_WORLD = /* glsl */`
varying vec3 vW; varying vec3 vN;
#include <fog_pars_vertex>
void main(){
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vW = wp.xyz; vN = normalize(mat3(modelMatrix) * normal);
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const TAIL = /* glsl */`
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
`;

function mk(opts) {
  return new THREE.ShaderMaterial({
    fog: true,
    ...opts,
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, opts.uniforms || {}]),
  });
}

// --- fake interior behind tower / neighbour glass (Blender hero.room_mat) ---------------------------
export function roomsMaterial([baseZ, fh, bay, lit, strength]) {
  return mk({
    uniforms: { baseZ: { value: baseZ }, fh: { value: fh }, bay: { value: bay }, lit: { value: lit },
      strength: { value: strength }, emitScale: { value: 1 } },
    vertexShader: VERT_WORLD,
    fragmentShader: /* glsl */`
uniform float baseZ, fh, bay, lit, strength, emitScale;
varying vec3 vW; varying vec3 vN;
#include <fog_pars_fragment>
${HASH}
void main(){
  vec3 b = vec3(vW.x, -vW.z, vW.y); vec3 n = vec3(vN.x, -vN.z, vN.y);
  float u = b.x * abs(n.y) + b.y * abs(n.x);
  float side = n.x * 3.0 + n.y;
  float Z = (b.z - baseZ) / fh; float fl = floor(Z), fv = fract(Z);
  float bi = floor(u / (bay * 2.0));
  float r = h1(vec3(bi, fl, side));
  float litm = step(r, lit);
  vec3 col = warmRamp(h1(vec3(bi, fl, side + 9.0)));
  float furn = vnoise(vec2(u * 1.3 * 1.6, b.z * 0.2 * 1.6 + side));
  float furnM = step(fv, mix(0.12, 0.32, smoothstep(0.3, 0.7, furn))) * step(0.45, furn);
  float grad = mix(0.35, 1.3, fv);
  float es = litm * grad * (1.0 - furnM * 0.85) * mix(strength * 1.4, strength * 0.6, clamp(r / max(lit, 1e-3), 0.0, 1.0));
  vec3 base = mix(vec3(0.024, 0.019, 0.016), vec3(0.067, 0.055, 0.045), vnoise(vec2(u * 0.7, b.z * 0.7)));
  gl_FragColor = vec4(base * 0.05 + col * es * emitScale, 1.0);
  ${TAIL}
}`,
  });
}

// --- roller shades just behind the glass (Blender hero.shade_mat) -------------------------------------
export function shadeMaterial([baseZ, fh, bay, lit]) {
  return mk({
    uniforms: { baseZ: { value: baseZ }, fh: { value: fh }, bay: { value: bay }, lit: { value: lit }, emitScale: { value: 1 } },
    side: THREE.DoubleSide,
    vertexShader: VERT_WORLD,
    fragmentShader: /* glsl */`
uniform float baseZ, fh, bay, lit, emitScale;
varying vec3 vW; varying vec3 vN;
#include <fog_pars_fragment>
${HASH}
void main(){
  vec3 b = vec3(vW.x, -vW.z, vW.y); vec3 n = vec3(vN.x, -vN.z, vN.y);
  float u = b.x * abs(n.y) + b.y * abs(n.x);
  float side = abs(n.x) * 3.0 * sign(n.x + 1e-4) + n.y;
  side = n.x * 3.0 + n.y;
  float Z = (b.z - baseZ) / fh; float fl = floor(Z), fv = fract(Z);
  float r = h1(vec3(floor(u / (bay * 2.0)), fl, side));
  float litm = step(r, lit);
  float dr = h1(vec3(floor(u / bay), fl, side + 5.0));
  float drop = pow(dr, 1.6) * 0.95;
  if (fv < 1.0 - drop) discard;
  vec3 c = vec3(0.75, 0.70, 0.62) * 0.03 + vec3(1.0, 0.72, 0.45) * litm * 0.55 * emitScale;
  gl_FragColor = vec4(c, 1.0);
  ${TAIL}
}`,
  });
}

// --- Manhattan blocks (Blender mats.city_facade). UV in metres; per-building attributes ---------------
export function cityMaterial(litFrac = 0.3, attrNames) {
  const a = attrNames;
  return mk({
    uniforms: { litFrac: { value: litFrac }, emitScale: { value: 1 }, amb: { value: new THREE.Color(0.030, 0.036, 0.055) } },
    vertexShader: /* glsl */`
attribute float ${a.rnd}; attribute float ${a.kind}; attribute float ${a.fh}; attribute float ${a.bw};
varying vec2 vUv; varying float vRnd, vKind, vFh, vBw; varying vec3 vN;
#include <fog_pars_vertex>
void main(){
  vUv = vec2(uv.x, 1.0 - uv.y);
  vRnd = ${a.rnd}; vKind = ${a.kind}; vFh = max(${a.fh}, 0.5); vBw = max(${a.bw}, 0.5);
  vN = normalize(mat3(modelMatrix) * normal);
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`,
    fragmentShader: /* glsl */`
uniform float litFrac, emitScale; uniform vec3 amb;
varying vec2 vUv; varying float vRnd, vKind, vFh, vBw; varying vec3 vN;
#include <fog_pars_fragment>
${HASH}
void main(){
  float u = vUv.x, v = vUv.y;
  float U = u / vBw, V = v / vFh; float fu = fract(U), fv = fract(V), cu = floor(U), cv = floor(V);
  bool glassT = vKind < 0.5;
  float punched = step(0.16, fu) * step(fu, 0.84) * step(0.28, fv) * step(fv, 0.88);
  float curtain = step(0.22, fv) * step(0.03, fu);
  float win = glassT ? curtain : punched;
  float wr = h1(vec3(cu, cv, vRnd * 113.0));
  float fl = h1(vec3(cv, vRnd * 71.0, 3.7));
  float lit = step(wr * 0.55 + fl * 0.45, litFrac) * step(0.5, v);
  float shop = step(v, vFh);
  lit = max(lit, shop * step(wr, 0.8));
  float grad = mix(0.55, 1.25, clamp((fv - 0.28) / 0.6, 0.0, 1.0));
  float es = lit * win * grad * mix(0.5, 2.2, wr) * emitScale;
  vec3 wallc = vKind < 0.5 ? vec3(0.04, 0.05, 0.058) : vKind < 1.5 ? vec3(0.46, 0.40, 0.29) : vKind < 2.5 ? vec3(0.19, 0.068, 0.04) : vec3(0.068, 0.062, 0.057);
  wallc *= mix(0.75, 1.25, vRnd);
  float up = clamp(vN.y, 0.0, 1.0);
  vec3 wall = wallc * amb * 3.0 * (0.7 + 0.5 * up);
  vec3 pane = mix(vec3(0.002, 0.003, 0.004), vec3(0.008, 0.009, 0.013), wr);
  if (glassT) pane += amb * 0.6;
  vec3 col = mix(wall, pane, win) + warmRamp(wr) * es;
  gl_FragColor = vec4(col, 1.0);
  ${TAIL}
}`,
  });
}
