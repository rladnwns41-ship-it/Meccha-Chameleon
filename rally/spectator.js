// ============================================================
// spectator.js — 대회 중계 관전자 뷰
//   - Firebase 익명 로그인 (게임과 같은 프로젝트)
//   - 방 선택 → 플레이어 팔로우 (3인칭)
//   - 절대 게임에 영향 X (players 노드에 자신 추가 안 함)
// ============================================================
'use strict';

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getAuth, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import {
  getDatabase, ref, onValue, off, get
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";

// ============================================================
// ★ 접속 코드 (대회 진행자만 아는 코드)
//   운영자가 바꾸고 싶으면 이 값만 수정
// ============================================================
const SPECTATOR_PASSWORD = 'aoao2026';

// ============================================================
// Firebase 초기화 (game.js 와 같은 프로젝트)
// ============================================================
const firebaseConfig = {
  apiKey: "AIzaSyBNft9WQTqrRde1avLdj0WD1SV7dZOOhSs",
  authDomain: "world-4a855.firebaseapp.com",
  databaseURL: "https://world-4a855-default-rtdb.firebaseio.com",
  projectId: "world-4a855",
  storageBucket: "world-4a855.firebasestorage.app",
  messagingSenderId: "1010314295713",
  appId: "1:1010314295713:web:78595c249ed0d7af0ef3e0"
};
const fbApp = initializeApp(firebaseConfig);
const fbAuth = getAuth(fbApp);
const fbDb = getDatabase(fbApp);
let myUid = null;

// ============================================================
// 게이트 (비밀번호)
// ============================================================
const gate = document.getElementById('gate');
const gatePwd = document.getElementById('gatePwd');
const gateBtn = document.getElementById('gateBtn');
const gateErr = document.getElementById('gateErr');
function tryUnlock() {
  const v = gatePwd.value.trim();
  if (v === SPECTATOR_PASSWORD) {
    gate.classList.add('hidden');
    sessionStorage.setItem('spec_ok', '1');
    startAuth();
  } else {
    gateErr.textContent = '❌ 접속 코드가 틀렸어';
    gatePwd.value = '';
    gatePwd.focus();
  }
}
gateBtn.addEventListener('click', tryUnlock);
gatePwd.addEventListener('keydown', e => { if (e.key === 'Enter') tryUnlock(); });
// 세션에 이미 통과했으면 스킵
if (sessionStorage.getItem('spec_ok') === '1') {
  gate.classList.add('hidden');
  startAuth();
} else {
  setTimeout(() => gatePwd.focus(), 100);
}

// ============================================================
// Firebase 익명 로그인
// ============================================================
function startAuth() {
  signInAnonymously(fbAuth)
    .then(cred => { myUid = cred.user.uid; console.log('✅ 관전자 로그인:', myUid); showRoomPicker(); })
    .catch(e => {
      myUid = 'spec_' + Math.random().toString(36).slice(2, 10);
      console.warn('⚠️ Firebase auth 실패, 게스트 모드:', e.code);
      showRoomPicker();
    });
}

// ============================================================
// 방 선택 화면
// ============================================================
const roomPicker = document.getElementById('roomPicker');
const roomList = document.getElementById('roomList');
let _roomListUnsub = null;
function showRoomPicker() {
  roomPicker.classList.remove('hidden');
  // 다른 방 관전 중이면 정리
  cleanupWatching();
  hideHud();
  if (_roomListUnsub) _roomListUnsub();
  _roomListUnsub = onValue(ref(fbDb, 'rooms'), snap => {
    const rooms = snap.val() || {};
    renderRoomList(rooms);
  });
}
function renderRoomList(rooms) {
  const entries = Object.entries(rooms).sort((a, b) => {
    // playing > voting > drawing > lobby 순
    const rank = { playing: 0, voting: 1, drawing: 2, lobby: 3, ended: 4 };
    return (rank[a[1].state] || 9) - (rank[b[1].state] || 9);
  });
  if (entries.length === 0) {
    roomList.innerHTML = '<div style="text-align:center;color:#8b92a8;padding:32px;">활성 방 없음</div>';
    return;
  }
  roomList.innerHTML = '';
  entries.forEach(([id, r]) => {
    const count = Object.keys(r.players || {}).length;
    const state = r.state || 'lobby';
    const stateLbl = ({ lobby:'대기실', voting:'투표중', drawing:'술래뽑기', playing:'플레이중', ended:'종료' })[state] || state;
    const el = document.createElement('div');
    el.className = 'room-item';
    el.innerHTML = `
      <div>
        <div class="r-name">${escapeHtml(r.name || '방')}</div>
        <div class="r-meta">👥 ${count}명 · ${r.gameMode || 'classic'}</div>
      </div>
      <div class="r-badge ${state}">${stateLbl}</div>
    `;
    el.addEventListener('click', () => enterSpectate(id, r));
    roomList.appendChild(el);
  });
}

// ============================================================
// Three.js 씬 초기화
// ============================================================
const scene = new THREE.Scene();
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.95;
renderer.shadowMap.enabled = false;
document.body.appendChild(renderer.domElement);

const camera = new THREE.PerspectiveCamera(60, innerWidth/innerHeight, 0.05, 400);
camera.position.set(0, 20, 20);
camera.lookAt(0, 0, 0);

// 하늘
function makeSkyTexture() {
  const c = document.createElement('canvas');
  c.width = 4; c.height = 512;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 512);
  grad.addColorStop(0.00, '#5b9dd6');
  grad.addColorStop(0.55, '#a9cee6');
  grad.addColorStop(0.85, '#e2d6b8');
  grad.addColorStop(1.00, '#c8bfa8');
  g.fillStyle = grad; g.fillRect(0, 0, 4, 512);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
scene.background = makeSkyTexture();
scene.fog = new THREE.Fog(0xb8c8d8, 80, 280);

scene.add(new THREE.AmbientLight(0xffffff, 1.0));
scene.add(new THREE.HemisphereLight(0xbcdcff, 0xf0d8a8, 0.85));
const dir = new THREE.DirectionalLight(0xfff2d0, 1.4);
dir.position.set(60, 120, 40);
scene.add(dir);

// 기본 지면 (맵 없을 때)
const groundMat = new THREE.MeshLambertMaterial({ color: 0xa8a89c });
const ground = new THREE.Mesh(new THREE.PlaneGeometry(300, 300), groundMat);
ground.rotation.x = -Math.PI/2;
scene.add(ground);

// ============================================================
// 리사이즈
// ============================================================
window.addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ============================================================
// 맵 데이터 (game.js 와 동일)
// ============================================================
const MAPS = [
  { name: '토쿄 카페', url: 'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Models/main/2.0/Sponza/glTF/Sponza.gltf', scale: 0.18, spawnOffsetY: 0, procedural: false },
  { name: 'Sponza (궁전)', url: 'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Models/main/2.0/Sponza/glTF/Sponza.gltf', scale: 3.0, spawnOffsetY: 0, procedural: false },
  { name: '마켓 (라마단)', url: 'https://cdn.jsdelivr.net/gh/mrdoob/three.js@master/examples/models/gltf/LittlestTokyo.glb', scale: 0.015, spawnOffsetY: 0, procedural: false },
  { name: '쇼핑몰', url: 'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Models/main/2.0/Sponza/glTF/Sponza.gltf', scale: 2.4, spawnOffsetY: 0, procedural: false }
];

// ============================================================
// 맵 로드
// ============================================================
const gltfLoader = new GLTFLoader();
const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath('https://unpkg.com/three@0.160.0/examples/jsm/libs/draco/');
gltfLoader.setDRACOLoader(dracoLoader);

let currentMapGroup = null;
function unloadMap() {
  if (currentMapGroup) {
    scene.remove(currentMapGroup);
    currentMapGroup.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        if (Array.isArray(o.material)) o.material.forEach(m => m.dispose());
        else o.material.dispose();
      }
    });
    currentMapGroup = null;
  }
}
function loadMap(mapIdx) {
  return new Promise(resolve => {
    unloadMap();
    const m = MAPS[mapIdx] || MAPS[0];
    document.getElementById('loadMap').textContent = m.name;
    gltfLoader.load(m.url, gltf => {
      const model = gltf.scene;
      model.scale.setScalar(m.scale);
      // 중앙 정렬
      const box = new THREE.Box3().setFromObject(model);
      const center = box.getCenter(new THREE.Vector3());
      model.position.sub(new THREE.Vector3(center.x, box.min.y, center.z));
      model.traverse(o => {
        if (o.isMesh) {
          o.castShadow = false; o.receiveShadow = false;
          if (o.material) {
            o.material.side = THREE.FrontSide;
          }
        }
      });
      scene.add(model);
      currentMapGroup = model;
      console.log('🗺 맵 로드 완료:', m.name);
      resolve();
    }, undefined, err => {
      console.warn('맵 로드 실패, 기본 지면만 사용:', err);
      resolve();
    });
  });
}

// ============================================================
// 플레이어 캐릭터 (심플 캡슐 + 이름표)
// ============================================================
const CHAR_HEIGHT = 1.8;
const CHAR_RADIUS = 0.35;

function makeCharacter(nick, isSeeker) {
  const group = new THREE.Group();
  const color = isSeeker ? 0xff5566 : 0x66d9ff;
  // 몸통
  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(CHAR_RADIUS, CHAR_HEIGHT - CHAR_RADIUS*2, 4, 8),
    new THREE.MeshLambertMaterial({ color })
  );
  body.position.y = CHAR_HEIGHT / 2;
  group.add(body);
  // 얼굴 방향 표시 (앞쪽 작은 원뿔)
  const nose = new THREE.Mesh(
    new THREE.ConeGeometry(0.12, 0.3, 6),
    new THREE.MeshLambertMaterial({ color: 0xffffff })
  );
  nose.rotation.x = Math.PI / 2;
  nose.position.set(0, CHAR_HEIGHT * 0.75, -CHAR_RADIUS - 0.05);
  group.add(nose);
  // 이름표 (canvas texture sprite)
  const nickSprite = makeNickSprite(nick, isSeeker);
  nickSprite.position.set(0, CHAR_HEIGHT + 0.5, 0);
  group.add(nickSprite);
  group.userData.nickSprite = nickSprite;
  group.userData.body = body;
  return group;
}
function makeNickSprite(text, isSeeker) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = isSeeker ? 'rgba(255,85,102,0.9)' : 'rgba(30,40,70,0.9)';
  const w = g.measureText(text).width;
  const pad = 20;
  const boxW = Math.min(240, Math.max(80, w + pad*2));
  g.fillRect((256-boxW)/2, 12, boxW, 40);
  g.strokeStyle = '#ffffff';
  g.lineWidth = 2;
  g.strokeRect((256-boxW)/2, 12, boxW, 40);
  g.fillStyle = '#ffffff';
  g.font = 'bold 22px "Nunito", sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 128, 33);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
  const sp = new THREE.Sprite(mat);
  sp.scale.set(3, 0.75, 1);
  sp.renderOrder = 100;
  return sp;
}
function updateNickSprite(group, text, isSeeker) {
  if (!group.userData.nickSprite) return;
  group.remove(group.userData.nickSprite);
  group.userData.nickSprite.material.map.dispose();
  group.userData.nickSprite.material.dispose();
  const newSp = makeNickSprite(text, isSeeker);
  newSp.position.set(0, CHAR_HEIGHT + 0.5, 0);
  group.add(newSp);
  group.userData.nickSprite = newSp;
  // 색도 갱신
  if (group.userData.body) {
    group.userData.body.material.color.set(isSeeker ? 0xff5566 : 0x66d9ff);
  }
}

// ============================================================
// 관전 상태
// ============================================================
let watchingRoomId = null;
let watchingRoomData = null;
let watchingTargetUid = null;
const characters = {}; // uid → { group, snapshots, lastRole }
let _roomUnsub = null;
let _gameUnsub = null;

function cleanupWatching() {
  if (_roomUnsub) { _roomUnsub(); _roomUnsub = null; }
  if (_gameUnsub) { _gameUnsub(); _gameUnsub = null; }
  for (const uid in characters) {
    scene.remove(characters[uid].group);
    delete characters[uid];
  }
  unloadMap();
  watchingRoomId = null;
  watchingRoomData = null;
  watchingTargetUid = null;
  freeCam = false;
  autoRotate = false;
}
function hideHud() {
  document.getElementById('hudTarget').classList.add('hidden');
  document.getElementById('hudRoom').classList.add('hidden');
  document.getElementById('ctrlBar').classList.add('hidden');
  document.getElementById('playerBar').classList.add('hidden');
  document.getElementById('minimap').classList.add('hidden');
  document.getElementById('brand').classList.add('hidden');
}
function showHud() {
  document.getElementById('hudTarget').classList.remove('hidden');
  document.getElementById('hudRoom').classList.remove('hidden');
  document.getElementById('ctrlBar').classList.remove('hidden');
  document.getElementById('playerBar').classList.remove('hidden');
  document.getElementById('minimap').classList.remove('hidden');
  document.getElementById('brand').classList.remove('hidden');
}

// ============================================================
// 방 관전 진입
// ============================================================
async function enterSpectate(roomId, roomData) {
  roomPicker.classList.add('hidden');
  document.getElementById('loading').classList.remove('hidden');
  if (_roomListUnsub) { _roomListUnsub(); _roomListUnsub = null; }

  // 맵 로드
  const mapIdx = parseInt(roomData.selectedMap || 0);
  await loadMap(mapIdx);

  watchingRoomId = roomId;

  // 방 데이터 구독 (플레이어 리스트/상태)
  _roomUnsub = onValue(ref(fbDb, `rooms/${roomId}`), snap => {
    const r = snap.val();
    if (!r) {
      // 방이 삭제됨 → 방 선택으로
      showRoomPicker();
      return;
    }
    watchingRoomData = r;
    updatePlayerList();
    updateRoomHud();
    updateTargetHud();
  });

  // 게임 (실시간 위치) 구독
  _gameUnsub = onValue(ref(fbDb, `rooms/${roomId}/game`), snap => {
    const g = snap.val() || {};
    for (const uid in g) {
      const p = g[uid];
      if (!characters[uid]) {
        const nick = (watchingRoomData?.players?.[uid]?.nick) || 'Player';
        const seek = isSeekerUid(uid);
        characters[uid] = { group: makeCharacter(nick, seek), snapshots: [], lastRole: seek };
        scene.add(characters[uid].group);
      }
      const c = characters[uid];
      const now = performance.now();
      // 스냅샷 버퍼 (150ms 렌더 딜레이 보간)
      c.snapshots.push({
        t: now,
        x: p.x, y: p.y, z: p.z,
        r: p.r || 0
      });
      if (c.snapshots.length > 20) c.snapshots.shift();
      // 첫 스냅샷 = 즉시 세팅
      if (c.snapshots.length === 1) {
        c.group.position.set(p.x, p.y, p.z);
        c.group.rotation.y = p.r || 0;
      }
    }
    // 사라진 uid 정리
    for (const uid in characters) {
      if (!g[uid]) {
        scene.remove(characters[uid].group);
        delete characters[uid];
      }
    }
    updatePlayerList();
  });

  document.getElementById('loading').classList.add('hidden');
  showHud();

  // 자동으로 첫 플레이어 팔로우
  setTimeout(() => {
    const first = Object.keys(characters)[0] || Object.keys(watchingRoomData?.players || {})[0];
    if (first) switchTarget(first);
  }, 800);
}
function isSeekerUid(uid) {
  if (!watchingRoomData) return false;
  return watchingRoomData.seekers?.[uid] === true || watchingRoomData.seekerUid === uid;
}

// ============================================================
// 관전 대상 전환
// ============================================================
function switchTarget(uid) {
  if (!watchingRoomData?.players?.[uid]) return;
  watchingTargetUid = uid;
  freeCam = false;
  document.getElementById('btnFree').classList.remove('on');
  updateTargetHud();
  updatePlayerList();
}
function switchNext(dir) {
  if (!watchingRoomData) return;
  const alive = Object.keys(watchingRoomData.players || {});
  if (alive.length === 0) return;
  const idx = alive.indexOf(watchingTargetUid);
  const nextIdx = ((idx + dir) % alive.length + alive.length) % alive.length;
  switchTarget(alive[nextIdx]);
}

// ============================================================
// HUD 업데이트
// ============================================================
function updateTargetHud() {
  if (!watchingTargetUid || !watchingRoomData) return;
  const p = watchingRoomData.players?.[watchingTargetUid];
  if (!p) return;
  document.getElementById('tgtNick').textContent = p.nick || 'Player';
  const isSeeker = isSeekerUid(watchingTargetUid);
  const alive = watchingRoomData.round?.alive?.[watchingTargetUid] !== false;
  const roleEl = document.getElementById('tgtRole');
  if (!alive) {
    roleEl.textContent = '💀 사망';
    roleEl.className = 'hud-badge dead';
  } else if (isSeeker) {
    roleEl.textContent = '술래';
    roleEl.className = 'hud-badge seeker';
  } else {
    roleEl.textContent = '숨는 자';
    roleEl.className = 'hud-badge';
  }
  document.getElementById('tgtScore').textContent = watchingRoomData.round?.scores?.[watchingTargetUid] || 0;
  document.getElementById('tgtCatch').textContent = watchingRoomData.catches?.[watchingTargetUid] || 0;
  document.getElementById('tgtLike').textContent = watchingRoomData.likes?.[watchingTargetUid] || 0;
  document.getElementById('tgtAlive').textContent = alive ? '🟢 생존' : '💀 사망';
  // 캐릭터 이름표/색 갱신
  const c = characters[watchingTargetUid];
  if (c) updateNickSprite(c.group, p.nick || 'P', isSeeker);
}
function updateRoomHud() {
  if (!watchingRoomData) return;
  document.getElementById('roomName').textContent = watchingRoomData.name || '방';
  const modeLbl = ({ classic: '클래식', infection: '감염', team: '팀' })[watchingRoomData.gameMode] || '-';
  document.getElementById('roomMode').textContent = '🎮 ' + modeLbl;
  const stateLbl = ({ lobby:'대기실', voting:'투표', drawing:'술래뽑기', playing:'플레이', ended:'종료' })[watchingRoomData.state] || '-';
  document.getElementById('roomState').textContent = '📶 ' + stateLbl;
  const t = watchingRoomData.roundCountdown;
  document.getElementById('roomTimer').textContent = t != null ? `⏱ ${Math.floor(t/60)}:${String(t%60).padStart(2,'0')}` : '⏱ --:--';
  // 캐릭터 색/이름 재갱신 (술래 상태 변화)
  for (const uid in characters) {
    const p = watchingRoomData.players?.[uid];
    if (p) {
      const seek = isSeekerUid(uid);
      if (characters[uid].lastRole !== seek) {
        updateNickSprite(characters[uid].group, p.nick || 'P', seek);
        characters[uid].lastRole = seek;
      }
    }
  }
}
function updatePlayerList() {
  if (!watchingRoomData) return;
  const list = document.getElementById('playerList');
  const players = watchingRoomData.players || {};
  const uids = Object.keys(players);
  // 기존 dom 재사용
  const existing = new Set();
  Array.from(list.children).forEach(el => existing.add(el.dataset.uid));
  // 사라진 것 제거
  Array.from(list.children).forEach(el => {
    if (!players[el.dataset.uid]) list.removeChild(el);
  });
  uids.forEach(uid => {
    let el = list.querySelector(`[data-uid="${uid}"]`);
    const p = players[uid];
    const isSeeker = isSeekerUid(uid);
    const alive = watchingRoomData.round?.alive?.[uid] !== false;
    const score = watchingRoomData.round?.scores?.[uid] || 0;
    if (!el) {
      el = document.createElement('div');
      el.className = 'pl-item';
      el.dataset.uid = uid;
      el.innerHTML = `<span class="pl-dot"></span><div><div class="pl-nick"></div><div class="pl-score"></div></div>`;
      el.addEventListener('click', () => switchTarget(uid));
      list.appendChild(el);
    }
    el.classList.toggle('active', uid === watchingTargetUid);
    el.classList.toggle('seeker', isSeeker);
    el.classList.toggle('dead', !alive);
    el.querySelector('.pl-nick').textContent = p.nick || 'P';
    el.querySelector('.pl-score').textContent = alive ? `💯 ${score}` : '💀 사망';
  });
}

// ============================================================
// 3인칭 카메라 시스템
// ============================================================
let camOrbit = { yaw: 0, pitch: 0.35, dist: 8 };
let freeCam = false;
let freeCamPos = new THREE.Vector3(0, 20, 20);
let freeCamYaw = 0;
let freeCamPitch = -0.4;
const _tmpV = new THREE.Vector3();
const _camTarget = new THREE.Vector3();

// 마우스 드래그로 시점 조절
let _dragging = false, _lastMouseX = 0, _lastMouseY = 0;
renderer.domElement.addEventListener('mousedown', e => {
  _dragging = true; _lastMouseX = e.clientX; _lastMouseY = e.clientY;
});
window.addEventListener('mouseup', () => { _dragging = false; });
window.addEventListener('mousemove', e => {
  if (!_dragging) return;
  const dx = e.clientX - _lastMouseX;
  const dy = e.clientY - _lastMouseY;
  _lastMouseX = e.clientX; _lastMouseY = e.clientY;
  if (freeCam) {
    freeCamYaw -= dx * 0.005;
    freeCamPitch -= dy * 0.005;
    freeCamPitch = Math.max(-Math.PI/2 + 0.1, Math.min(Math.PI/2 - 0.1, freeCamPitch));
  } else {
    camOrbit.yaw -= dx * 0.005;
    camOrbit.pitch += dy * 0.005;
    camOrbit.pitch = Math.max(-Math.PI/3, Math.min(Math.PI/2 - 0.1, camOrbit.pitch));
  }
});
// 휠로 거리
renderer.domElement.addEventListener('wheel', e => {
  e.preventDefault();
  if (freeCam) return; // free cam은 WASD 이동
  camOrbit.dist += e.deltaY * 0.01;
  camOrbit.dist = Math.max(3, Math.min(30, camOrbit.dist));
}, { passive: false });

// Free cam WASD
const freeKeys = { w:false, a:false, s:false, d:false, q:false, e:false, shift:false };
window.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') return;
  const k = e.key.toLowerCase();
  if (freeKeys.hasOwnProperty(k)) freeKeys[k] = true;
  if (k === 'shift') freeKeys.shift = true;
  // hotkey
  if (k === 'arrowright') switchNext(1);
  else if (k === 'arrowleft') switchNext(-1);
  else if (k === 'a' && !freeCam && watchingTargetUid) { toggleAuto(); e.preventDefault(); }
  else if (k === 'f') toggleFree();
  else if (k === 'r') showRoomPicker();
  else if (k === 'escape' && freeCam) toggleFree();
});
window.addEventListener('keyup', e => {
  const k = e.key.toLowerCase();
  if (freeKeys.hasOwnProperty(k)) freeKeys[k] = false;
  if (k === 'shift') freeKeys.shift = false;
});

function updateFreeCam(dt) {
  const speed = (freeKeys.shift ? 30 : 12) * dt;
  const fwd = new THREE.Vector3(-Math.sin(freeCamYaw)*Math.cos(freeCamPitch), Math.sin(freeCamPitch), -Math.cos(freeCamYaw)*Math.cos(freeCamPitch));
  const right = new THREE.Vector3(Math.cos(freeCamYaw), 0, -Math.sin(freeCamYaw));
  if (freeKeys.w) freeCamPos.addScaledVector(fwd, speed);
  if (freeKeys.s) freeCamPos.addScaledVector(fwd, -speed);
  if (freeKeys.d) freeCamPos.addScaledVector(right, speed);
  if (freeKeys.a) freeCamPos.addScaledVector(right, -speed);
  if (freeKeys.q) freeCamPos.y -= speed;
  if (freeKeys.e) freeCamPos.y += speed;
  camera.position.copy(freeCamPos);
  const lookAt = new THREE.Vector3().copy(freeCamPos).add(fwd);
  camera.lookAt(lookAt);
}

function updateFollowCam() {
  if (!watchingTargetUid || !characters[watchingTargetUid]) return;
  const target = characters[watchingTargetUid].group;
  _camTarget.copy(target.position).add(new THREE.Vector3(0, CHAR_HEIGHT * 0.7, 0));
  // 카메라 위치 계산 (orbit)
  const d = camOrbit.dist;
  const cy = Math.cos(camOrbit.yaw), sy = Math.sin(camOrbit.yaw);
  const cp = Math.cos(camOrbit.pitch), sp = Math.sin(camOrbit.pitch);
  const offX = -sy * cp * d;
  const offY = sp * d;
  const offZ = -cy * cp * d;
  const desired = _tmpV.set(_camTarget.x + offX, _camTarget.y + offY, _camTarget.z + offZ);
  // 부드러운 lerp
  camera.position.lerp(desired, 0.15);
  camera.lookAt(_camTarget);
}

// 자동 순환
let autoRotate = false;
let autoRotateNext = 0;
const AUTO_INTERVAL = 8000; // 8초마다
function toggleAuto() {
  autoRotate = !autoRotate;
  document.getElementById('btnAuto').classList.toggle('on', autoRotate);
  document.getElementById('autoLbl').textContent = autoRotate ? 'ON' : 'OFF';
  autoRotateNext = performance.now() + AUTO_INTERVAL;
}
function toggleFree() {
  freeCam = !freeCam;
  document.getElementById('btnFree').classList.toggle('on', freeCam);
  if (freeCam) {
    // 현재 카메라 위치/방향 이어받기
    freeCamPos.copy(camera.position);
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    freeCamYaw = Math.atan2(-dir.x, -dir.z);
    freeCamPitch = Math.asin(dir.y);
  }
}

document.getElementById('btnPrev').addEventListener('click', () => switchNext(-1));
document.getElementById('btnNext').addEventListener('click', () => switchNext(1));
document.getElementById('btnAuto').addEventListener('click', toggleAuto);
document.getElementById('btnFree').addEventListener('click', toggleFree);
document.getElementById('btnRoom').addEventListener('click', showRoomPicker);

// ============================================================
// 미니맵
// ============================================================
const mmCanvas = document.getElementById('minimapCanvas');
const mmCtx = mmCanvas.getContext('2d');
const MM_SIZE = 180;
const MM_WORLD = 60; // world units shown across minimap
function drawMinimap() {
  if (!watchingRoomData) return;
  mmCtx.clearRect(0, 0, MM_SIZE, MM_SIZE);
  // 배경 그리드
  mmCtx.strokeStyle = 'rgba(60,80,120,0.4)';
  mmCtx.lineWidth = 1;
  for (let i = 0; i <= 6; i++) {
    const p = (i / 6) * MM_SIZE;
    mmCtx.beginPath(); mmCtx.moveTo(p, 0); mmCtx.lineTo(p, MM_SIZE); mmCtx.stroke();
    mmCtx.beginPath(); mmCtx.moveTo(0, p); mmCtx.lineTo(MM_SIZE, p); mmCtx.stroke();
  }
  // 중심 좌표: 관전 대상 or 원점
  let cx = 0, cz = 0;
  if (watchingTargetUid && characters[watchingTargetUid]) {
    cx = characters[watchingTargetUid].group.position.x;
    cz = characters[watchingTargetUid].group.position.z;
  }
  const worldToMM = (wx, wz) => {
    const dx = wx - cx, dz = wz - cz;
    const mx = MM_SIZE/2 + (dx / MM_WORLD) * MM_SIZE;
    const my = MM_SIZE/2 + (dz / MM_WORLD) * MM_SIZE;
    return [mx, my];
  };
  // 각 플레이어 점
  for (const uid in characters) {
    const c = characters[uid];
    const [mx, my] = worldToMM(c.group.position.x, c.group.position.z);
    if (mx < -4 || mx > MM_SIZE+4 || my < -4 || my > MM_SIZE+4) continue;
    const isSeeker = isSeekerUid(uid);
    const isTarget = uid === watchingTargetUid;
    mmCtx.fillStyle = isSeeker ? '#ff5566' : '#66d9ff';
    mmCtx.beginPath();
    mmCtx.arc(mx, my, isTarget ? 6 : 4, 0, Math.PI*2);
    mmCtx.fill();
    if (isTarget) {
      mmCtx.strokeStyle = '#ffd93d';
      mmCtx.lineWidth = 2;
      mmCtx.stroke();
    }
  }
}

// ============================================================
// 스냅샷 보간 렌더 (150ms 딜레이 = 부드러움)
// ============================================================
const RENDER_DELAY_MS = 150;
function updateCharacters() {
  const now = performance.now();
  const t = now - RENDER_DELAY_MS;
  for (const uid in characters) {
    const c = characters[uid];
    const buf = c.snapshots;
    if (!buf || buf.length === 0) continue;
    let a = null, b = null;
    for (let i = buf.length - 1; i >= 0; i--) {
      if (buf[i].t <= t) { a = buf[i]; b = buf[i+1] || null; break; }
    }
    let px, py, pz, pr;
    if (!a) { a = buf[0]; px = a.x; py = a.y; pz = a.z; pr = a.r; }
    else if (!b) {
      px = a.x; py = a.y; pz = a.z; pr = a.r;
    } else {
      const dt = b.t - a.t;
      const tt = dt > 0 ? Math.max(0, Math.min(1, (t - a.t) / dt)) : 0;
      px = a.x + (b.x - a.x) * tt;
      py = a.y + (b.y - a.y) * tt;
      pz = a.z + (b.z - a.z) * tt;
      let dr = b.r - a.r;
      dr = ((dr + Math.PI) % (Math.PI*2)) - Math.PI;
      pr = a.r + dr * tt;
    }
    c.group.position.set(px, py, pz);
    c.group.rotation.y = pr;
    while (buf.length > 2 && buf[1].t < t - 500) buf.shift();
  }
}

// ============================================================
// 렌더 루프
// ============================================================
let _lastFrame = performance.now();
let _mmFrame = 0;
function animate() {
  requestAnimationFrame(animate);
  const now = performance.now();
  const dt = Math.min(0.05, (now - _lastFrame) / 1000);
  _lastFrame = now;

  updateCharacters();

  if (freeCam) {
    updateFreeCam(dt);
  } else if (watchingTargetUid) {
    updateFollowCam();
  }

  // 자동 순환
  if (autoRotate && !freeCam && watchingRoomData && now > autoRotateNext) {
    switchNext(1);
    autoRotateNext = now + AUTO_INTERVAL;
  }

  // 미니맵 (15fps로 충분)
  _mmFrame++;
  if (_mmFrame % 4 === 0) drawMinimap();

  renderer.render(scene, camera);
}
animate();

// ============================================================
// 헬퍼
// ============================================================
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

console.log('🎥 관전자 뷰 준비 완료 · WEBCHA CHAMELEON LIVE');
