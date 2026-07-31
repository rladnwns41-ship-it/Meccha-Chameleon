// ============================================================
// scene.js — Three.js 씬, 렌더러, 카메라, 조명, 지면, 경계벽
// export: scene, renderer, camera, ambientLight, hemiLight, dir, fillLight,
//         ground, wallGroup, wallMat, capMat, cornerMat, buildWalls
// ============================================================

import * as THREE from 'three';

export const scene = new THREE.Scene();

export const renderer = new THREE.WebGLRenderer({
  antialias: false,
  powerPreference: 'high-performance',
  stencil: false,
  precision: 'mediump'
});
// ★ 렉 감소를 위해 픽셀비율 낮춤 (선명도 유지하면서 GPU 부하 30% 감소)
const _dpr = window.devicePixelRatio || 1;
renderer.setPixelRatio(Math.min(_dpr * 0.55, 0.85));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.85;
renderer.shadowMap.enabled = false;      // 그림자 완전 끄기 (성능)
renderer.info.autoReset = false;          // info 트래킹 오버헤드 제거
document.body.appendChild(renderer.domElement);

export const camera = new THREE.PerspectiveCamera(65, innerWidth/innerHeight, 0.05, 320);

// 하늘 그라디언트 (셰이더 안 쓰고 canvas 텍스처 하나 — 렉 X)
function makeSkyTexture() {
  const c = document.createElement('canvas');
  c.width = 4; c.height = 512;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 512);
  grad.addColorStop(0.00, '#5b9dd6');
  grad.addColorStop(0.55, '#a9cee6');
  grad.addColorStop(0.85, '#e2d6b8');
  grad.addColorStop(1.00, '#c8bfa8');
  g.fillStyle = grad;
  g.fillRect(0, 0, 4, 512);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  return tex;
}
scene.background = makeSkyTexture();
scene.fog = new THREE.Fog(0xb8c8d8, 55, 220);

// ========== 조명 ==========
export const ambientLight = new THREE.AmbientLight(0xffffff, 1.0);
scene.add(ambientLight);
export const hemiLight = new THREE.HemisphereLight(0xbcdcff, 0xf0d8a8, 0.85);
scene.add(hemiLight);
export const dir = new THREE.DirectionalLight(0xfff2d0, 1.55);
dir.position.set(60, 120, 40);
dir.castShadow = false;
scene.add(dir);
export const fillLight = new THREE.DirectionalLight(0x9fb8d8, 0.35);
fillLight.position.set(-40, 60, -50);
scene.add(fillLight);
renderer.toneMappingExposure = 0.95;

// ========== 지면 ==========
function makeGroundTexture() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#5a5f52';
  g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 1400; i++) {
    const x = Math.random()*256, y = Math.random()*256;
    const shade = Math.floor(80 + Math.random()*60);
    g.fillStyle = `rgba(${shade},${shade-4},${shade-10},0.35)`;
    g.fillRect(x, y, 1 + Math.random()*2, 1 + Math.random()*2);
  }
  for (let i = 0; i < 40; i++) {
    g.fillStyle = `rgba(30,32,28,${0.08 + Math.random()*0.08})`;
    const r = 6 + Math.random()*18;
    g.beginPath();
    g.arc(Math.random()*256, Math.random()*256, r, 0, Math.PI*2);
    g.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(24, 24);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 2;
  return tex;
}
const groundMat = new THREE.MeshLambertMaterial({ map: makeGroundTexture(), color: 0xa8a89c });
export const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), groundMat);
ground.rotation.x = -Math.PI/2;
ground.position.y = -0.02;
ground.receiveShadow = false;
scene.add(ground);

// ========== 경계 벽 (동적 생성) ==========
export const wallGroup = new THREE.Group();
scene.add(wallGroup);
export const wallMat   = new THREE.MeshLambertMaterial({ color:0xa8a29a });
export const capMat    = new THREE.MeshLambertMaterial({ color:0x6d6a63 });
export const cornerMat = new THREE.MeshLambertMaterial({ color:0x8a857c });

export function buildWalls(center, halfX, halfZ) {
  wallGroup.clear();
  const wh = 14, wt = 2;
  const makeSide = (x, z, len, rotY) => {
    const w = new THREE.Mesh(new THREE.BoxGeometry(len+12, wh, wt), wallMat);
    w.position.set(x, wh/2, z); w.rotation.y = rotY;
    w.castShadow = false; w.receiveShadow = false;
    wallGroup.add(w);
    const cap = new THREE.Mesh(new THREE.BoxGeometry(len+12.4, 0.5, wt+0.6), capMat);
    cap.position.set(x, wh+0.1, z); cap.rotation.y = rotY;
    cap.castShadow = false;
    wallGroup.add(cap);
  };
  makeSide(center.x, center.z-halfZ, halfX*2, 0);
  makeSide(center.x, center.z+halfZ, halfX*2, 0);
  makeSide(center.x-halfX, center.z, halfZ*2, Math.PI/2);
  makeSide(center.x+halfX, center.z, halfZ*2, Math.PI/2);
  [[-1,-1],[1,-1],[-1,1],[1,1]].forEach(([sx,sz]) => {
    const pillar = new THREE.Mesh(new THREE.BoxGeometry(3, wh, 3), wallMat);
    pillar.position.set(center.x+sx*halfX, wh/2, center.z+sz*halfZ);
    pillar.castShadow = false; pillar.receiveShadow = false;
    wallGroup.add(pillar);
    const cornerCap = new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.5, 3.4), capMat);
    cornerCap.position.set(center.x+sx*halfX, wh+0.1, center.z+sz*halfZ);
    wallGroup.add(cornerCap);
    // 코너 사각지대 안전벽 (안 보임)
    const invisMat = new THREE.MeshBasicMaterial({ visible: false });
    const safety = new THREE.Mesh(new THREE.BoxGeometry(10, wh, 10), invisMat);
    safety.position.set(center.x+sx*(halfX+2), wh/2, center.z+sz*(halfZ+2));
    wallGroup.add(safety);
  });
}
