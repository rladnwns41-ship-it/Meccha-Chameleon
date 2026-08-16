// ============================================================
// game.js — 메인 게임 로직 (플레이어, 물리, 페인트, 멀티, UI 등)
// firebase.js: Firebase 초기화 + myUid
// scene.js:    Three.js 씬/렌더러/카메라/조명/지면/벽
// ============================================================

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
// BVH는 도쿄 mesh 인스턴스에만 개별 적용 (캐릭터 raycast 안 건드림)
import { MeshBVH, acceleratedRaycast } from 'https://unpkg.com/three-mesh-bvh@0.7.8/build/index.module.js';

// Firebase Realtime Database — 게임 상태 동기화용
import { ref, set, onValue, onDisconnect, serverTimestamp,
         push, update, get, remove, off, onChildAdded, query, limitToLast } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";

// 분리된 파일에서 import
import { fbApp, fbAuth, fbDb, myUid } from './firebase.js';
import { scene, renderer, camera,
         ambientLight, hemiLight, dir, fillLight,
         ground, wallGroup, wallMat, capMat, cornerMat, buildWalls } from './scene.js';

// game.js 로컬 상태 (firebase.js 의 myUid 와 별도)
let myRef = null, myNick = '익명';
// 포즈휠 미리보기 렌더 타겟 (renderPoseWheel 안에서 lazy-init 됨)
let _poseWheelRT = null;

// ================ Player ================
const player = new THREE.Group();
player.position.set(0, 20, 0);
scene.add(player);

// 페인트 캔버스 (텍스처)
const PAINT_SIZE = 512;
const paintCanvas = document.createElement('canvas');
paintCanvas.width = PAINT_SIZE; paintCanvas.height = PAINT_SIZE;
const paintCtx = paintCanvas.getContext('2d');
paintCtx.fillStyle = '#ffffff';
paintCtx.fillRect(0, 0, PAINT_SIZE, PAINT_SIZE);
const paintTexture = new THREE.CanvasTexture(paintCanvas);
paintTexture.colorSpace = THREE.SRGBColorSpace;
paintTexture.flipY = false;

let characterMeshes = []; // paintable meshes

// GLB 로드 (base64 → ArrayBuffer)
const draco = new DRACOLoader();
draco.setDecoderPath('https://unpkg.com/three@0.160.0/examples/jsm/libs/draco/gltf/');
// ★ crossOrigin 설정: 외부 GLB 텍스처를 blob URL로 처리할 때 CORS 오류 방지
//   (threejs.org, jsdelivr 등 CDN 모델의 텍스처가 Couldn't load texture blob: 에러를 냄)
// LoadingManager: 텍스처 로드 실패 시 빈 1×1 흰색 텍스처로 대체
//   → "THREE.WebGLProgram: Shader Error 1282 - VALIDATE_STATUS false" 방지
//     (텍스처 슬롯이 null 이면 셰이더 컴파일은 되지만 검증 단계에서 1282 뱉음)
const _gltfManager = new THREE.LoadingManager();
_gltfManager.onError = url => {
  console.warn('⚠️ 에셋 로드 실패 (무시 처리):', url);
};
// 텍스처 핸들러: blob/external URL 실패 시 1px 흰 텍스처로 폴백
const _fallbackTexture = (() => {
  const cv = document.createElement('canvas'); cv.width = 1; cv.height = 1;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 1, 1);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
})();
const gltfLoader = new GLTFLoader(_gltfManager);
gltfLoader.crossOrigin = 'anonymous';
gltfLoader.setDRACOLoader(draco);

// 두 포즈 저장 (모델 + 머리 y 위치)
const poseModels = { stand: null, crouch: null };
const poseHeadY = { stand: 1.6, crouch: 1.0 }; // 기본값 (로드 후 실측)
let currentPose = 'stand';
let currentPoseGlb = null;

// 술래(seeker) 모델 + 총
let seekerModel = null;   // 술래 원본 (복제용)
let seekerGunModel = null; // 총 원본

// 내 역할: 'hider' (숨는 자) or 'seeker' (술래)
let myRole = 'hider';

// 술래는 hider 모델 그대로 사용 (tager.glb 안 씀)

// 총 로드 
const GUN_URL = './gun.glb';
console.log('🔫 총 모델 로드 시도:', GUN_URL, '(현재 URL:', location.href, ')');
gltfLoader.load(GUN_URL, gltf => {
  const glb = gltf.scene;
  const tempBox = new THREE.Box3().setFromObject(glb);
  const size = new THREE.Vector3(); tempBox.getSize(size);
  const maxDim = Math.max(size.x, size.y, size.z);
  const gunScale = maxDim > 0 ? (0.8 / maxDim) : 1;
  glb.traverse(o => {
    o.visible = true;
    if (o.isMesh) {
      o.castShadow = false;
      o.frustumCulled = false;
      o.material = new THREE.MeshLambertMaterial({ color: 0x888888 });
    }
  });
  seekerGunModel = glb;
  seekerGunModel.userData.gunScale = gunScale;
  seekerGunModel.userData.isFallback = false;
  console.log('✅ 총 모델 로드 완료 / 원본 크기:', size.x.toFixed(2), size.y.toFixed(2), size.z.toFixed(2), '→ scale:', gunScale.toFixed(3));
  if (myRole === 'seeker') { detachGunFromPlayer(); attachGunToPlayer(); }
  refreshOtherSeekerGuns();
}, evt => {
  // 진행 상황 (있으면)
  if (evt && evt.lengthComputable) {
    console.log(`🔫 총 로딩... ${(evt.loaded/1024).toFixed(1)} / ${(evt.total/1024).toFixed(1)} KB`);
  }
}, err => {
  console.error('❌ 총 모델 로드 실패:', GUN_URL);
  console.error('   에러:', err?.message || err);
  console.error('   → 절차적 폴백 총으로 대체 (박스+실린더 조립)');
  seekerGunModel = makeFallbackGun();
  seekerGunModel.userData.gunScale = 1.0;
  seekerGunModel.userData.isFallback = true;
  console.log('✅ 폴백 총 준비 완료 (회색 박스)');
  if (myRole === 'seeker') { detachGunFromPlayer(); attachGunToPlayer(); }
  refreshOtherSeekerGuns();
});

// 폴백 총: gun.glb 안 뜰 때 대체로 만드는 간단한 3D 총 모양
function makeFallbackGun() {
  const g = new THREE.Group();
  const mat = new THREE.MeshLambertMaterial({ color: 0x333338 });
  const matDark = new THREE.MeshLambertMaterial({ color: 0x1a1a20 });
  // 몸체
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.22, 0.22), mat);
  body.position.set(0.1, 0, 0);
  g.add(body);
  // 총열
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.7, 8), matDark);
  barrel.rotation.z = Math.PI/2;
  barrel.position.set(0.55, 0.03, 0);
  g.add(barrel);
  // 손잡이
  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.32, 0.18), matDark);
  grip.position.set(-0.05, -0.22, 0);
  grip.rotation.z = 0.15;
  g.add(grip);
  // 조준경
  const scope = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.08, 0.08), matDark);
  scope.position.set(0.15, 0.17, 0);
  g.add(scope);
  g.traverse(o => { if (o.isMesh) { o.frustumCulled = false; o.renderOrder = 10; } });
  return g;
}

// 총 = player 그룹에 직접 붙임
let attachedGun = null;
function attachGunToPlayer() {
  if (!seekerGunModel) { console.warn('🔫 attachGunToPlayer: seekerGunModel 없음'); return; }
  if (attachedGun) { return; }
  const cloned = seekerGunModel.clone(true);
  const s = seekerGunModel.userData.gunScale || 1;
  cloned.scale.setScalar(s);
  cloned.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(cloned);
  const center = new THREE.Vector3(); box.getCenter(center);
  const size = new THREE.Vector3(); box.getSize(size);
  // ★ 근본 원인 대응:
  //   기존 로직은 gun을 bbox 중심으로 정렬 → 모델마다 원점 위치가 달라서 부착 후
  //   총이 캐릭터 몸 안에 파묻히거나 이상한 곳에 뜸.
  //   여기선 gun 의 "왼쪽면(x=box.min.x)" + "아래(y=box.min.y)" + "뒤(z=box.max.z)" 를
  //   attachedGun 원점에 맞춤. 즉 총의 손잡이 뒤끝을 anchor 로 삼음 → 항상 예측 가능.
  cloned.position.set(
    -(box.min.x + box.max.x)/2,
    -(box.min.y + box.max.y)/2,
    -(box.min.z + box.max.z)/2
  );
  cloned.traverse(o => {
    o.visible = true;
    if (o.isMesh) {
      o.frustumCulled = false;
      o.renderOrder = 10;
    }
  });
  attachedGun = new THREE.Group();
  attachedGun.add(cloned);

  // 튜닝 상수 (안 예쁘면 여기 조절)
  // ★ 총을 캐릭터 오른손/가슴 높이에 두고 총구(+X)가 정면(-Z)을 향하게
  const GUN_POS_X = 0.32, GUN_POS_Y = 1.1, GUN_POS_Z = -0.35;
  const GUN_ROT_X = 0, GUN_ROT_Y = -Math.PI, GUN_ROT_Z = 0; // 총구 앞으로 (왼쪽 90도 추가 회전)
  attachedGun.position.set(GUN_POS_X, GUN_POS_Y, GUN_POS_Z);
  attachedGun.rotation.set(GUN_ROT_X, GUN_ROT_Y, GUN_ROT_Z);
  player.add(attachedGun);

  // 부착 후 실제 렌더링 mesh 의 world 위치 확인
  attachedGun.updateMatrixWorld(true);
  const worldPos = new THREE.Vector3();
  attachedGun.getWorldPosition(worldPos);
  // 진짜 mesh 하나의 world 좌표도 뽑아보기 (bbox 중심)
  const finalBox = new THREE.Box3().setFromObject(attachedGun);
  const finalCenter = new THREE.Vector3(); finalBox.getCenter(finalCenter);
  const finalSize = new THREE.Vector3(); finalBox.getSize(finalSize);
  console.log('🔫 총 부착 완료',
    '\n  scale:', s.toFixed(3),
    '\n  원본 bbox size:', size.x.toFixed(2), size.y.toFixed(2), size.z.toFixed(2),
    '\n  원본 bbox min:', box.min.x.toFixed(2), box.min.y.toFixed(2), box.min.z.toFixed(2),
    '\n  원본 bbox max:', box.max.x.toFixed(2), box.max.y.toFixed(2), box.max.z.toFixed(2),
    '\n  attachedGun local:', attachedGun.position.toArray().map(v=>v.toFixed(2)).join(','),
    '\n  attachedGun world:', worldPos.toArray().map(v=>v.toFixed(2)).join(','),
    '\n  최종 렌더 bbox 중심:', finalCenter.toArray().map(v=>v.toFixed(2)).join(','),
    '\n  최종 렌더 bbox 크기:', finalSize.toArray().map(v=>v.toFixed(2)).join(','),
    '\n  visible:', attachedGun.visible,
    '\n  isFallback:', seekerGunModel.userData.isFallback,
    '\n  💡 빨간 구가 보이는데 총이 안 보이면 gun.glb 모델 자체 문제 (재질/투명/좌표계)');
}
function detachGunFromPlayer() {
  if (attachedGun) { player.remove(attachedGun); attachedGun = null; }
}

// 다른 플레이어(술래)에게 총 부착/제거
function attachGunToOther(uid) {
  const ot = otherPlayers[uid];
  if (!ot || !seekerGunModel || ot.gun) return;
  const cloned = seekerGunModel.clone(true);
  const s = seekerGunModel.userData.gunScale || 1;
  cloned.scale.setScalar(s);
  cloned.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(cloned);
  cloned.position.set(
    -(box.min.x + box.max.x)/2,
    -(box.min.y + box.max.y)/2,
    -(box.min.z + box.max.z)/2
  );
  cloned.traverse(o => {
    o.visible = true;
    if (o.isMesh) {
      o.frustumCulled = false;
      o.renderOrder = 10;
    }
  });
  const wrap = new THREE.Group();
  wrap.add(cloned);
  // ★ 자기 캐릭터와 동일하게: 오른손/가슴 높이 + 총구 앞으로
  wrap.position.set(0.32, 1.1, -0.35);
  wrap.rotation.set(0, 0, 0); // 왼쪽 90도 추가 회전
  ot.group.add(wrap);
  ot.gun = wrap;
}
function detachGunFromOther(uid) {
  const ot = otherPlayers[uid];
  if (ot && ot.gun) { ot.group.remove(ot.gun); ot.gun = null; }
}
function refreshOtherSeekerGuns() {
  const room = _cachedRoom;
  if (!room) return;
  Object.keys(otherPlayers).forEach(uid => {
    if (isSeekerUid(uid, room)) attachGunToOther(uid);
    else detachGunFromOther(uid);
  });
}

// 게임 진행 중(찾기 페이즈)에는 닉/따봉 숨김 — 하이더 위치 노출 방지
function updateNickLikeLabels(room) {
  // ★ 숨기 시간 + 찾기 시간 내내 숨김 → 라운드가 끝난('ended') 뒤에만 표시
  const hide = room?.state === 'playing';
  Object.values(otherPlayers).forEach(ot => {
    if (ot.nickSprite) ot.nickSprite.visible = !hide;
    if (ot.likeSprite) ot.likeSprite.visible = !hide;
  });
  if (window._decoys) {
    Object.values(window._decoys).forEach(dec => {
      dec.group?.traverse(o => {
        if (o.isSprite) o.visible = !hide;
      });
    });
  }
}

// 매 프레임 안전망: 술래인데 총 안 붙었으면 붙임
let _gunWatchdogSpam = 0;
let _gunDiagLastLog = 0;
function ensureGunAttached() {
  const room = _cachedRoom;
  // 5초마다 상태 리포트 (술래인데 문제 있을 때만)
  const now = Date.now();
  if (now - _gunDiagLastLog > 5000) {
    _gunDiagLastLog = now;
    const iAmSeeker = room ? isSeekerUid(myUid, room) : (myRole === 'seeker');
    if (iAmSeeker && !attachedGun) {
      console.warn('🔫[진단] 술래인데 총 미부착:',
        'seekerGunModel=', !!seekerGunModel,
        '(fallback=' + (seekerGunModel?.userData?.isFallback ?? 'n/a') + ')',
        '/ myRole=', myRole,
        '/ Firebase 술래 uid=', room?.seekerUid,
        '/ 감염됐음=', !!(room?.seekers?.[myUid]),
        '/ myUid=', myUid);
    }
  }
  if (!seekerGunModel) return;
  // myRole 기반으로도 체크
  if (myRole === 'seeker' && !attachedGun) {
    console.log('🔫 watchdog → 내 총 재부착 시도 (myRole 기반)');
    attachGunToPlayer();
  }
  if (!room) return;
  // seekerUid or 감염 기반 이중 체크
  if (isSeekerUid(myUid, room) && !attachedGun) {
    console.log('🔫 watchdog → 내 총 재부착 시도 (Firebase 기반)');
    attachGunToPlayer();
  }
  // 다른 술래들 (감염 포함)
  Object.keys(otherPlayers).forEach(uid => {
    const ot = otherPlayers[uid];
    const seeker = isSeekerUid(uid, room);
    if (seeker && !ot.gun) attachGunToOther(uid);
    if (!seeker && ot.gun) detachGunFromOther(uid);
  });
}

// 플레이어 생존 목록 HUD 갱신
function updatePlayerListHUD() {
  const el = document.getElementById('playerListHUD');
  if (!el) return;
  const room = _cachedRoom;
  if (!room || currentScreen !== 'game') { el.classList.remove('on'); return; }
  const players = room.players || {};
  const alive = roundState?.alive || {};
  const seekerUid = room.seekerUid;
  const uids = Object.keys(players);
  if (!uids.length) { el.classList.remove('on'); return; }
  // 타이틀 + row 컨테이너 구조 한번만 생성
  let rowsBox = el.querySelector('.plh-rows');
  if (!rowsBox) {
    el.innerHTML = '<div class="plh-title">플레이어</div><div class="plh-rows"></div>';
    rowsBox = el.querySelector('.plh-rows');
  }
  const items = uids.map(uid => ({
    uid, p: players[uid],
    isDead: alive[uid] === false,
    isSeeker: isSeekerUid(uid, room),
    catches: (room.catches?.[uid]) || 0
  }));
  diffRender(
    rowsBox,
    items,
    it => it.uid,
    it => {
      const row = document.createElement('div');
      row.className = 'plh-row';
      row.innerHTML = `
        <div class="plh-dot"></div>
        <div class="plh-nick"></div>
        <div class="plh-role"></div>
      `;
      return row;
    },
    (row, it) => {
      const wantDead = it.isDead;
      if (row.classList.contains('dead') !== wantDead) row.classList.toggle('dead', wantDead);
      const nick = row.querySelector('.plh-nick');
      const role = row.querySelector('.plh-role');
      const nickTxt = (it.p.nick || '?') + (it.uid === myUid ? ' (나)' : '');
      // 잡은 수가 있으면 옆에 🔍N 붙임
      const roleTxt = (it.isSeeker ? '🎯' : '🦎') + (it.catches > 0 ? ` 🔍${it.catches}` : '');
      if (nick.textContent !== nickTxt) nick.textContent = nickTxt;
      if (role.textContent !== roleTxt) role.textContent = roleTxt;
    }
  );
  el.classList.add('on');
}

// ============ diff 렌더 헬퍼 (깜빡임 방지) ============
// 컨테이너 안의 자식들을 key 기준으로 재사용/갱신/제거
function diffRender(container, items, getKey, buildNode, updateNode) {
  if (!container) return;
  const existing = new Map();
  Array.from(container.children).forEach(el => {
    const k = el.dataset._k;
    if (k != null) existing.set(k, el);
  });
  const seen = new Set();
  items.forEach((item, i) => {
    const key = String(getKey(item, i));
    seen.add(key);
    let el = existing.get(key);
    if (!el) {
      el = buildNode(item, i);
      el.dataset._k = key;
      container.appendChild(el);
      if (updateNode) updateNode(el, item, i);
    } else {
      if (updateNode) updateNode(el, item, i);
    }
    // 순서 보정
    const target = container.children[i];
    if (target !== el) container.insertBefore(el, target || null);
  });
  // 없어진 것 제거
  existing.forEach((el, k) => { if (!seen.has(k)) el.remove(); });
}

// ============ 채팅 ============
// 채팅 시스템은 startFirebaseSync → subscribeChat 에서 일괄 처리
// initChat/closeChat 은 하위 호환 스텁으로만 유지 (enterRoom 등에서 호출되므로)
function initChat() { /* 채팅 구독은 startFirebaseSync 내 subscribeChat이 담당 */ }
function closeChat() { unsubscribeChat(); }

// 역할 전환 - 총만 붙였다 뗐다 (모델은 동일)
function setRole(role) {
  myRole = role;
  console.log('🎭 내 역할:', role);
  // 크로스헤어/조준점 표시
  const ch = document.getElementById('gameCrosshair');
  if (ch) ch.style.display = role === 'seeker' ? 'block' : 'none';
  // 항상 먼저 뗀 뒤 다시 붙임 (이전 라운드 잔재 방지)
  detachGunFromPlayer();
  if (role === 'seeker') attachGunToPlayer();
  switchPose(currentPose);
}

// ============================================================
// 라운드 시스템 (타이머, 슈팅, 점수, 사망)
// ============================================================
const ROUND_DURATION_MS = 180000; // 3분
const SHOOT_RANGE = 40;
const VISION_FOV_COS = Math.cos(THREE.MathUtils.degToRad(35)); // 시야 각도 35도

let roundState = { phase: 'idle', startedAt: 0, endsAt: 0 };
let myAlive = true;
let myScore = 0;
let scoreTimer = null;
let roundTimerHandle = null;

// 방장 상태 관리 - onValue 캐시로 get() 제거
let _cachedRoom = null;
let _lastPlayerCount = 0;

// 방 데이터는 subscribeRoom의 onValue에서 _cachedRoom으로 캐시됨

// ★ 전체 방 자동 정리 (방에 들어가지 않아도 오래된/빈 방 삭제)
// 방 목록 화면에서도 주기적으로 실행
setInterval(async () => {
  if (!myUid) return;
  if (currentScreen !== 'rooms') return; // 방 목록 화면에서만
  try {
    // ★ 최적화: 상단에서 이미 import 된 get 사용 (매번 dynamic import 안 함)
    const snap = await get(ref(fbDb, 'rooms'));
    const data = snap.val() || {};
    for (const [rid, room] of Object.entries(data)) {
      if (!room) continue;
      const count = Object.keys(room.players || {}).length;
      const age = room.createdAt ? Date.now() - room.createdAt : 0;
      if (count === 0 || age > 10 * 60 * 1000) {
        // 방장이면 무조건, 아니면 빈 방일 때만 (룰이 빈 방은 아무나 삭제 허용)
        if (room.hostUid === myUid || count === 0) {
          await remove(ref(fbDb, `rooms/${rid}`));
          console.log('🧹 자동 방 삭제:', rid, count === 0 ? '빈방' : '10분초과');
        }
      }
    }
  } catch(e) {}
}, 30000); // 30초마다

let _hostTickRunning = false;
let _prevTickState = null;
setInterval(async () => {
  if (_hostTickRunning) return;
  if (!myRoomId || !myUid || !_cachedRoom) return;
  const room = _cachedRoom;
  if (room.hostUid !== myUid) return;
  _hostTickRunning = true;
  try {
    const count = Object.keys(room.players || {}).length;
    const state = room.state || 'lobby';
    const roomRef = ref(fbDb, `rooms/${myRoomId}`);
    
    if (count === 0) {
      await remove(roomRef);
      return;
    }

    if (room.createdAt && Date.now() - room.createdAt > 10 * 60 * 1000) {
      console.log('⏰ 10분 초과 자동 삭제');
      await remove(roomRef);
      return;
    }
    
    if (state === 'lobby') {
      if (count < 2) {
        // 인원 부족 → 카운트/시작요청 취소
        if (room.countdown != null || room.startRequested) {
          await update(roomRef, { countdown: null, startRequested: null });
        }
        _lastPlayerCount = count;
        return;
      }
      // ★ 방장이 시작 버튼 안 눌렀으면 대기
      if (!room.startRequested) {
        if (room.countdown != null) await update(roomRef, { countdown: null });
        _lastPlayerCount = count;
        return;
      }
      if (count > _lastPlayerCount && room.countdown != null && room.countdown < 3) {
        await update(roomRef, { countdown: 3 });
      } else if (room.countdown == null) {
        await update(roomRef, { countdown: 5 });
      } else if (room.countdown > 0) {
        await update(roomRef, { countdown: room.countdown - 1 });
      } else {
        // ★ 각자 자기 vote/modeVote 를 지움 (rules.md 는 본인만 자기 필드 쓰기 가능)
        //   방장이 남의 vote 를 지우려 하면 permission_denied → 이전 vote 남아 다음 라운드 오작동
        //   해결: state 전환만 하고, 각 클라이언트는 subscribeRoom 에서 감지 후 자기 것만 지움
        await update(roomRef, { state: 'voting', votePhase: 'map', voteCountdown: 15, countdown: null });
        console.log('▶ lobby → voting (map)');
      }
      _lastPlayerCount = count;
      
    } else if (state === 'voting') {
      const phase = room.votePhase || 'map';
      // ★ 모두 투표했는지 확인 → 남은 시간 무시하고 즉시 다음 단계로
      const players = room.players || {};
      const uids = Object.keys(players);
      const voteField = phase === 'map' ? 'vote' : 'modeVote';
      const allVoted = uids.length > 0 && uids.every(u => players[u] && players[u][voteField] != null);
      if (room.voteCountdown > 0 && !allVoted) {
        await update(roomRef, { voteCountdown: room.voteCountdown - 1 });
      } else if (phase === 'map') {
        // 맵 투표 집계 → 결과 저장 후 모드 투표로 전환
        if (allVoted) console.log('▶ 모두 맵 투표 완료 → 즉시 모드 투표로');
        const votes = {};
        Object.values(players).forEach(p => { if (p.vote) votes[p.vote] = (votes[p.vote] || 0) + 1; });
        let maxV = -1, winners = [];
        Object.entries(votes).forEach(([k, v]) => {
          if (v > maxV) { maxV = v; winners = [k]; }
          else if (v === maxV) winners.push(k);
        });
        const chosen = winners.length > 0
          ? winners[Math.floor(Math.random()*winners.length)]
          : String(Math.floor(Math.random() * MAPS.length));
        // ★ rules.md 는 selectedMap 이 Number 여야 통과. String 이면 검증 실패 → update 거부 → 상태 전환 안 됨
        await update(roomRef, {
          selectedMap: Number(chosen),
          votePhase: 'mode',
          voteCountdown: 15
        });
        console.log('▶ 맵 투표 종료, 선정=', chosen, '→ 모드 투표 시작');
      } else {
        // 모드 투표 집계
        if (allVoted) console.log('▶ 모두 모드 투표 완료 → 즉시 게임 시작');
        const modeVotes = {};
        Object.values(players).forEach(p => { if (p.modeVote) modeVotes[p.modeVote] = (modeVotes[p.modeVote] || 0) + 1; });
        let mMax = -1, mWinners = [];
        Object.entries(modeVotes).forEach(([k, v]) => {
          if (v > mMax) { mMax = v; mWinners = [k]; }
          else if (v === mMax) mWinners.push(k);
        });
        const chosenMode = mWinners.length > 0
          ? mWinners[Math.floor(Math.random()*mWinners.length)]
          : 'classic';
        // 술래 결정 — 팀 모드면 여러 명, 아니면 1명
        const shuffled = [...uids].sort(() => Math.random() - 0.5);
        let seekerUid = shuffled[0];
        let seekersMap = null;
        if (chosenMode === 'team') {
          const seekerCount = Math.max(1, Math.floor(uids.length / 2));
          seekersMap = {};
          shuffled.slice(0, seekerCount).forEach(u => { seekersMap[u] = true; });
          seekerUid = shuffled[0];
        }
        await update(roomRef, {
          state: 'drawing',
          gameMode: chosenMode,
          seekerUid: seekerUid,
          seekers: seekersMap,
          drawCountdown: 5,
          voteCountdown: null,
          votePhase: null
        });
        console.log('▶ voting → drawing, 술래=', seekerUid, '모드=', chosenMode, '팀시커=', seekersMap);
      }
      
    } else if (state === 'drawing') {
      if (room.drawCountdown > 0) {
        await update(roomRef, { drawCountdown: room.drawCountdown - 1 });
      } else {
        await update(roomRef, {
          state: 'playing',
          hidePhaseCountdown: 120,
          roundCountdown: 180,
          drawCountdown: null,
          round: {
            phase: 'hiding',
            startedAt: Date.now(),
            alive: Object.fromEntries(Object.keys(room.players || {}).map(u => [u, true])),
            scores: {}
          }
        });
        console.log('▶ drawing → playing (숨는 시간 시작)');
      }
      
    } else if (state === 'playing') {
      if (room.hidePhaseCountdown != null && room.hidePhaseCountdown > 0) {
        await update(roomRef, { hidePhaseCountdown: room.hidePhaseCountdown - 1 });
        return;
      }
      if (count < 2) {
        await update(roomRef, { state: 'ended', roundCountdown: null });
        console.log('▶ 인원 부족 → 라운드 종료');
        return;
      }
      // ★ hider 정리 판정
      // 클래식: alive[uid]!==false 인 hider가 0명이면 즉시 종료
      // 감염: hider가 아예 없으면(다 감염) 15초 카운트다운 후 종료 → 결과 화면 여유
      const aliveMap = room.round?.alive || {};
      const hiderUids = Object.keys(room.players || {}).filter(u => !isSeekerUid(u, room));
      if (hiderUids.length === 0 && room.gameMode === 'infection') {
        // 다 감염됨 → 15초 카운트다운
        if (room.postInfectionCountdown == null) {
          await update(roomRef, { postInfectionCountdown: 15 });
          console.log('☣️ 전원 감염! 15초 후 라운드 종료');
        } else if (room.postInfectionCountdown > 0) {
          await update(roomRef, { postInfectionCountdown: room.postInfectionCountdown - 1 });
        } else {
          await update(roomRef, { state: 'ended', roundCountdown: null, postInfectionCountdown: null });
          console.log('▶ 감염 카운트다운 종료 → 결과 화면');
        }
        return;
      }
      if (hiderUids.length > 0) {
        const hidersAlive = hiderUids.filter(u => aliveMap[u] !== false).length;
        if (hidersAlive === 0) {
          await update(roomRef, { state: 'ended', roundCountdown: null });
          console.log('▶ 모든 hider 정리됨 → 즉시 라운드 종료');
          return;
        }
      }
      if (room.roundCountdown > 0) {
        await update(roomRef, { roundCountdown: room.roundCountdown - 1 });
      } else {
        await update(roomRef, { state: 'ended', roundCountdown: null });
        console.log('▶ playing → ended');
      }
    }
  } catch(e) { console.error('❌ 방장 tick 에러:', e); }
  finally { _hostTickRunning = false; }
}, 1000);

// 라운드 상태 리스너 (방 안 game_state)
function subscribeRoundState() {
  if (!myRoomId) return;
  onValue(ref(fbDb, `rooms/${myRoomId}/round`), snap => {
    const rs = snap.val();
    if (!rs) return;
    roundState = rs;
    // roundTimer 는 subscribeRoom 이 처리
    if (rs.phase === 'ended' && currentScreen === 'game') showScoreboard();
    // 내 생존 상태
    const alive = rs.alive?.[myUid];
    if (alive === false && myAlive) onIDied();
    myAlive = alive !== false;
    // 모든 플레이어 생존 변화 감지 → 먼지 애니메이션
    checkAliveTransitions(rs);
    // 플레이어 목록 UI 갱신
    updatePlayerListHUD();
  });
}

// 라운드 시작 (방장이 startGame 이후 호출)
// initRound 제거 - host tick 이 관리
async function uid_is_host_by_id(roomId) {
  const s = await get(ref(fbDb, `rooms/${roomId}`));
  return s.val()?.hostUid === myUid;
}

// 숨는 시간 처리 - 술래는 얼음 + 화면 어둡게, 하이더는 자유
let inHidePhase = false;
function updateHidePhase(room) {
  const isHiding = room.state === 'playing' && room.hidePhaseCountdown != null && room.hidePhaseCountdown > 0;
  inHidePhase = isHiding;
  const overlay = document.getElementById('hidePhaseOverlay');
  if (!overlay) return;
  // 오버레이는 술래한테만 — 도망자(hider)에게는 절대 표시 안 함
  if (isHiding && myRole === 'seeker') {
    overlay.classList.remove('hidden');
    overlay.querySelector('.msg').textContent = '🙈 눈 감고 기다리는 중...';
    overlay.querySelector('.timer').textContent = room.hidePhaseCountdown + '초';
  } else {
    overlay.classList.add('hidden');
  }
  // 도망자면 무조건 강제 숨김 (타이밍 이슈 방어)
  if (myRole === 'hider') {
    overlay.classList.add('hidden');
  }
}

// 라운드 타이머 UI - Firebase roundCountdown 값 표시
function updateRoundTimer(room) {
  const el = document.getElementById('roundTimer');
  // 감염 카운트다운 (다 감염돼서 곧 종료)
  if (room.postInfectionCountdown != null && room.postInfectionCountdown >= 0) {
    el.textContent = '☣️ 종료까지의 시간을 하다 ' + room.postInfectionCountdown + '초';
    el.style.color = '#7ee06a';
    return;
  }
  // 숨는 시간 동안엔 그 카운트다운 표시 (도망자한테 유용)
  if (room.hidePhaseCountdown != null && room.hidePhaseCountdown > 0) {
    const h = room.hidePhaseCountdown;
    const mm = String(Math.floor(h/60)).padStart(2,'0');
    const ss = String(h%60).padStart(2,'0');
    el.textContent = '숨기 ' + mm + ':' + ss;
    el.style.color = '#4dd07a';
    return;
  }
  el.style.color = '';
  const s = room.roundCountdown != null ? room.roundCountdown : 180;
  const mm = String(Math.floor(s/60)).padStart(2,'0');
  const ss = String(s%60).padStart(2,'0');
  el.textContent = mm + ':' + ss;
}
function startRoundTimer() {
  
  // 점수 적립 (매 5초 배치 전송)
  if (scoreTimer) clearInterval(scoreTimer);
  let _scoreAccum = 0;
  let _scoreTick = 0;
  scoreTimer = setInterval(() => {
    if (!myRoomId || !myAlive || myRole !== 'hider') return;
    const bonus = isVisibleToSeeker() ? 5 : 1;
    _scoreAccum += bonus;
    myScore += bonus;
    document.getElementById('myScore').textContent = myScore;
    _scoreTick++;
    // 10틱(10초)마다 Firebase에 한 번만 씀 (대회용 write 절감)
    if (_scoreTick % 10 === 0) {
      update(ref(fbDb, `rooms/${myRoomId}/round/scores`), { [myUid]: myScore });
      _scoreAccum = 0;
    }
  }, 1000);
}

// 술래한테 보이는지 체크 (내 시야가 아닌 - 다른 사람의 술래 시야에 내가 있는지)
// 다른 플레이어(술래)의 위치와 회전을 이용
function isVisibleToSeeker() {
  const seekerUid = roundState.seekerUid;
  if (!seekerUid || seekerUid === myUid) return false;
  const seeker = otherPlayers[seekerUid];
  if (!seeker) return false;
  
  // 술래 → 내 벡터
  const toMe = _toMeVec.subVectors(player.position, seeker.group.position);
  const dist = toMe.length();
  if (dist > SHOOT_RANGE) return false;
  toMe.normalize();
  
  // 술래가 바라보는 방향 (Y 회전 기준)
  const seekerFwd = _seekerFwdVec.set(-Math.sin(seeker.group.rotation.y), 0, -Math.cos(seeker.group.rotation.y));
  const dot = toMe.dot(seekerFwd);
  return dot > VISION_FOV_COS;
}

// 술래가 발사 (좌클릭)
const shootRc = new THREE.Raycaster();
// isVisibleToSeeker 재사용 벡터 (매 호출 new 방지)
const _toMeVec = new THREE.Vector3();
const _seekerFwdVec = new THREE.Vector3();
let _lastShootTime = 0;
const SHOOT_COOLDOWN = 500; // 0.5초 발사 쿨다운
renderer.domElement.addEventListener('mousedown', e => {
  if (e.button !== 0) return;
  if (paintMode) return; // 페인트 모드에선 발사 X
  if (myRole !== 'seeker') return;
  if (!myAlive) return;
  if (!pointerLocked) return;
  const nowShoot = Date.now();
  if (nowShoot - _lastShootTime < SHOOT_COOLDOWN) return; // 쿨다운
  _lastShootTime = nowShoot;
  shootFromCamera();
});

// C 키로 분신 만들기 (숨는 자만)
addEventListener('keydown', e => {
  if (e.code !== 'KeyC') return;
  if (window._chatTyping) return;
  if (currentScreen !== 'game') return;
  if (paintMode) return;
  if (myRole === 'seeker') return;   // 술래는 못 만듦
  if (typeof window.createDecoy === 'function') window.createDecoy();
});

// L 키로 조준한 플레이어에게 좋아요
addEventListener('keydown', async e => {
  if (e.code !== 'KeyL') return;
  if (window._chatTyping) return;
  if (currentScreen !== 'game') return;
  if (!pointerLocked) return;
  if (!myRoomId || !myUid) return;
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  shootRc.camera = camera; // ★ 스프라이트 raycast에 camera 필수
  shootRc.set(camera.position, dir);
  shootRc.far = 80;
  const targets = [];
  const uidByObj = new Map();
  Object.entries(otherPlayers).forEach(([uid, op]) => {
    op.group.traverse(o => {
      // ★ Mesh만 포함 (Sprite 제외) - camera 없으면 Sprite.raycast가 크래시
      if (o.isMesh) {
        targets.push(o);
        uidByObj.set(o.id, uid);
      }
    });
  });
  const hits = shootRc.intersectObjects(targets, false);
  if (!hits.length) return;
  const hitUid = uidByObj.get(hits[0].object.id);
  if (!hitUid || hitUid === myUid) return;
  try {
    await set(ref(fbDb, `rooms/${myRoomId}/likes/${hitUid}/${myUid}`), true);
    console.log('👍 좋아요 →', hitUid);
    // 시각 피드백 - 카운트 살짝 튀게
    const ot = otherPlayers[hitUid];
    if (ot && ot.likeSprite) {
      ot.likeSprite.scale.set(0.9, 0.9, 1);
      setTimeout(() => { if (ot.likeSprite) ot.likeSprite.scale.set(0.6, 0.6, 1); }, 180);
    }
  } catch(err) { console.warn('좋아요 실패:', err); }
});

function shootFromCamera() {
  // ★ 보안: role + 게임상태 이중 검증
  if (myRole !== 'seeker') { console.log('🔫 발사 취소: myRole=', myRole); return; }
  if (!myAlive) { console.log('🔫 발사 취소: 사망 상태'); return; }
  if (currentScreen !== 'game') { console.log('🔫 발사 취소: 스크린=', currentScreen); return; }
  if (!myRoomId || !_cachedRoom) { console.log('🔫 발사 취소: 방 정보 없음'); return; }
  // ★ 원조 술래 OR 감염된 술래여야 함
  if (!isSeekerUid(myUid, _cachedRoom)) {
    console.log('🔫 발사 취소: Firebase 기준 나는 술래 아님');
    return;
  }
  if (_cachedRoom.state !== 'playing') { console.log('🔫 발사 취소: 게임 안 함'); return; }
  if (inHidePhase) { console.log('🙈 숨는 시간 - 발사 X'); return; }

  // 카메라 중심에서 앞으로
  const camDir = new THREE.Vector3();
  camera.getWorldDirection(camDir);
  const camPos = camera.position;

  // ★ 벽/바닥 물감 스플랫 (발사 방향으로 항상 발동)
  spawnBulletSplatAtWall(camPos, camDir);

  // ★ 조준 완화 (aim-assist)
  // - 정밀 mesh raycast 대신, 각 hider의 몸 중심까지의 "레이 수직 거리"를 재서
  //   HITBOX_RADIUS 안이면 명중 처리. 캐릭터가 얇거나 팔다리 사이 빈틈이 있어도 안정적.
  const HITBOX_RADIUS = 0.9; // 몸통 두께 + 여유
  const HEAD_OFFSET_Y = 0.9; // 캐릭터 중심 보정 (몸 중앙 근처)
  let best = null; // { uid?, decoyKey?, dist, side }

  const check = (obj, uid, decoyKey) => {
    const p = obj.position;
    // 캐릭터 중심 좌표 (그룹 origin 이 발밑이면 살짝 위로)
    const cx = p.x, cy = p.y + HEAD_OFFSET_Y, cz = p.z;
    const dx = cx - camPos.x, dy = cy - camPos.y, dz = cz - camPos.z;
    // 카메라 앞쪽 투영 거리 (레이 방향 위 사영)
    const along = dx*camDir.x + dy*camDir.y + dz*camDir.z;
    if (along <= 0) return; // 뒤에 있음
    if (along > SHOOT_RANGE) return; // 너무 멀리
    // 레이에서 수직으로 얼마나 벗어났는지
    const projX = camDir.x*along, projY = camDir.y*along, projZ = camDir.z*along;
    const sideX = dx - projX, sideY = dy - projY, sideZ = dz - projZ;
    const side = Math.sqrt(sideX*sideX + sideY*sideY + sideZ*sideZ);
    if (side > HITBOX_RADIUS) return; // 너무 옆으로 빗나감
    // 더 가까이 조준된 대상(수직 거리 작은 쪽) 우선, 같으면 앞쪽 거리 우선
    if (!best || side < best.side - 0.05 || (Math.abs(side - best.side) < 0.05 && along < best.along)) {
      best = { uid, decoyKey, along, side };
    }
  };

  // hider 후보
  let hiderCount = 0, seekerSkip = 0, deadSkip = 0;
  Object.entries(otherPlayers).forEach(([uid, op]) => {
    if (roundState.alive?.[uid] === false) { deadSkip++; return; }
    if (isSeekerUid(uid, _cachedRoom)) { seekerSkip++; return; }
    hiderCount++;
    check(op.group, uid, null);
  });
  // 분신
  let decoyCount = 0;
  if (window._decoys) {
    Object.entries(window._decoys).forEach(([key, dec]) => {
      decoyCount++;
      check(dec.group, null, key);
    });
  }

  if (!best) {
    console.log(`❌ 빗나감 (hider ${hiderCount}명, 분신 ${decoyCount}개, 술래제외 ${seekerSkip}, 사망제외 ${deadSkip})`);
    return;
  }
  if (best.decoyKey) {
    console.log('🎭 분신 명중! 글리치 (수직거리 ' + best.side.toFixed(2) + 'm)');
    triggerGlitch();
    return;
  }
  console.log(`🎯 명중: ${best.uid} (앞거리 ${best.along.toFixed(1)}m, 수직거리 ${best.side.toFixed(2)}m)`);
  killPlayer(best.uid);
}

// ================ 물감 스플랫 시스템 ================
const _splatRc = new THREE.Raycaster();
const _activeSplats = [];
const SPLAT_COLORS = [0xff2222, 0xff7700, 0xff1493, 0xaa00ff, 0x0077ff, 0x00ccff, 0x00dd44, 0xffee00];

function spawnBulletSplatAtWall(camPos, camDir) {
  if (!myRoomId) return;
  _splatRc.set(camPos, camDir);
  _splatRc.far = SHOOT_RANGE;
  const allSurfaces = [...collidableMeshes];
  if (ground) allSurfaces.push(ground);
  const hits = _splatRc.intersectObjects(allSurfaces, false);
  if (!hits.length) return;
  const hit = hits[0];
  const p = hit.point;
  const n = (hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld).normalize() : new THREE.Vector3(0,1,0));
  const colorIdx = Math.floor(Math.random() * SPLAT_COLORS.length);
  const splatData = {
    x: +p.x.toFixed(3), y: +p.y.toFixed(3), z: +p.z.toFixed(3),
    nx: +n.x.toFixed(3), ny: +n.y.toFixed(3), nz: +n.z.toFixed(3),
    c: colorIdx, at: Date.now()
  };
  try {
    push(ref(fbDb, `rooms/${myRoomId}/paintSplats`), splatData);
  } catch(e) {}
}

function createSplatMesh(x, y, z, nx, ny, nz, colorIdx) {
  const color = SPLAT_COLORS[colorIdx % SPLAT_COLORS.length];
  const N = 7 + Math.floor(Math.random() * 5);
  const group = new THREE.Group();
  // ★ 모든 맵에서 보이게: polygonOffset + renderOrder + offset 0.015→0.08
  //   (Sponza/마켓/쇼핑몰은 스케일 2.5~3배라 1.5cm offset은 z-fight로 벽 안에 파묻힘)
  const mainGeo = new THREE.CircleGeometry(0.18 + Math.random()*0.14, 10);
  const mainMat = new THREE.MeshBasicMaterial({
    color, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4
  });
  const mainMesh = new THREE.Mesh(mainGeo, mainMat);
  mainMesh.renderOrder = 5;
  group.add(mainMesh);
  for (let i = 0; i < N; i++) {
    const angle = (i / N) * Math.PI * 2 + Math.random() * 0.9;
    const dist = 0.08 + Math.random() * 0.34;
    const r = 0.04 + Math.random() * 0.11;
    const geo = new THREE.CircleGeometry(r, 7);
    const mat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4
    });
    const blob = new THREE.Mesh(geo, mat);
    blob.renderOrder = 5;
    blob.position.set(Math.cos(angle) * dist, Math.sin(angle) * dist, 0);
    group.add(blob);
  }
  const normal = new THREE.Vector3(nx, ny, nz).normalize();
  const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,0,1), normal);
  group.quaternion.copy(quat);
  group.position.set(x + normal.x*0.08, y + normal.y*0.08, z + normal.z*0.08);
  group.renderOrder = 5;
  scene.add(group);
  _activeSplats.push({ group, life: 0, maxLife: 9.0 });
}

let _splatUnsub = null;
function subscribeSplats(roomId) {
  if (_splatUnsub) { _splatUnsub(); _splatUnsub = null; }
  const splatRef = query(ref(fbDb, `rooms/${roomId}/paintSplats`), limitToLast(60));
  let firstLoad = true;
  _splatUnsub = onChildAdded(splatRef, snap => {
    if (firstLoad) { firstLoad = false; return; }
    const d = snap.val();
    if (!d) return;
    createSplatMesh(d.x, d.y, d.z, d.nx, d.ny, d.nz, d.c ?? 0);
  });
}

function unsubscribeSplats() {
  if (_splatUnsub) { _splatUnsub(); _splatUnsub = null; }
  for (const s of _activeSplats) scene.remove(s.group);
  _activeSplats.length = 0;
}

function updateSplats(dt) {
  for (let i = _activeSplats.length - 1; i >= 0; i--) {
    const s = _activeSplats[i];
    s.life += dt;
    const spreadT = Math.min(1, s.life / 0.4);
    const scale = spreadT < 1 ? Math.sqrt(spreadT) : 1.0;
    const fadeStart = s.maxLife - 3.0;
    const fadeT = s.life > fadeStart ? (s.life - fadeStart) / 3.0 : 0;
    const opacity = Math.max(0, (1 - fadeT) * 0.85) * scale;
    // ★ 최적화: forEach → for-loop (매 프레임 클로저 할당 방지)
    const kids = s.group.children;
    for (let k = 0; k < kids.length; k++) {
      const mesh = kids[k];
      mesh.scale.setScalar(scale);
      if (mesh.material) mesh.material.opacity = opacity;
    }
    if (s.life >= s.maxLife) {
      scene.remove(s.group);
      _activeSplats.splice(i, 1);
    }
  }
}

// 분신 맞았을 때 글리치 효과
function triggerGlitch() {
  const el = document.getElementById('glitchOverlay');
  if (!el) return;
  el.classList.remove('active');
  void el.offsetWidth; // reflow 강제해서 애니메이션 재시작
  el.classList.add('active');
  document.body.classList.add('glitchShake');
  setTimeout(() => {
    el.classList.remove('active');
    document.body.classList.remove('glitchShake');
  }, 700);
}

async function killPlayer(uid) {
  // ★ 보안: 술래(원조 or 감염), 게임 중, 대상 상태 검증
  if (!_cachedRoom || _cachedRoom.state !== 'playing') return;
  if (!isSeekerUid(myUid, _cachedRoom)) return; // 내가 진짜 술래(감염 포함)인지
  if (myRole !== 'seeker') return;
  if (!myAlive) return;
  if (!uid || uid === myUid) return; // 자해 방지
  if (isSeekerUid(uid, _cachedRoom)) return; // 술래끼리 못 잡음
  if (_cachedRoom.round?.alive?.[uid] === false) return; // 이미 죽은 플레이어
  if (!_cachedRoom.players?.[uid]) return;

  const isInfection = _cachedRoom.gameMode === 'infection';
  const scores = Object.assign({}, _cachedRoom?.round?.scores || {});
  scores[myUid] = (scores[myUid] || 0) + 50;

  if (isInfection) {
    // 감염: alive=false 안 하고 술래 목록에 추가
    // ★ rule: round/scores/$uid = 본인만, round/alive/$uid = 아무나, seekers/$uid = 아무나
    //   전체 오브젝트 통째로 update 하면 상위 노드 write 룰(=방장만) 이 적용 → 방장 아닌 술래 실패
    //   개별 경로로 write 해야 함
    await set(ref(fbDb, `rooms/${myRoomId}/round/scores/${myUid}`), scores[myUid])
      .catch(e => console.warn('scores:', e.code));
    await set(ref(fbDb, `rooms/${myRoomId}/seekers/${uid}`), true)
      .catch(e => console.warn('seekers:', e.code));
    console.log('☣️ 감염 성공:', uid);
  } else {
    // 클래식: 사망 처리 — round/alive/$uid = 아무나 write 가능
    await set(ref(fbDb, `rooms/${myRoomId}/round/alive/${uid}`), false)
      .catch(e => console.warn('alive:', e.code));
    await set(ref(fbDb, `rooms/${myRoomId}/round/scores/${myUid}`), scores[myUid])
      .catch(e => console.warn('scores:', e.code));
  }
  // catches — rule: catches/$uid = 아무나 write, 상위 catches 통째로는 방장만
  const catchCount = (_cachedRoom?.catches?.[myUid] || 0) + 1;
  await set(ref(fbDb, `rooms/${myRoomId}/catches/${myUid}`), catchCount)
    .catch(e => console.warn('catches:', e.code));
}

// ============ 사망 먼지 애니메이션 (모두가 봄) ============
const _dustBursts = []; // {points, life, maxLife}
function spawnDustBurst(x, y, z) {
  const N = 40;
  const positions = new Float32Array(N * 3);
  const velocities = [];
  for (let i = 0; i < N; i++) {
    positions[i*3] = x + (Math.random()-0.5)*0.3;
    positions[i*3+1] = y + Math.random()*1.5;
    positions[i*3+2] = z + (Math.random()-0.5)*0.3;
    const ang = Math.random() * Math.PI * 2;
    const spd = 2 + Math.random() * 3;
    velocities.push({
      x: Math.cos(ang) * spd,
      y: 1 + Math.random() * 2.5,
      z: Math.sin(ang) * spd
    });
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.PointsMaterial({
    color: 0xd8cbb0, size: 0.35, transparent: true, opacity: 1,
    depthWrite: false, sizeAttenuation: true
  });
  const pts = new THREE.Points(geom, mat);
  scene.add(pts);
  _dustBursts.push({ points: pts, velocities, life: 0, maxLife: 1.4, positions });
  console.log('💨 먼지 애니메이션 재생');
}
function updateDustBursts(dt) {
  for (let i = _dustBursts.length - 1; i >= 0; i--) {
    const b = _dustBursts[i];
    b.life += dt;
    const t = b.life / b.maxLife;
    const pos = b.positions;
    for (let j = 0; j < b.velocities.length; j++) {
      const v = b.velocities[j];
      pos[j*3]   += v.x * dt;
      pos[j*3+1] += v.y * dt;
      pos[j*3+2] += v.z * dt;
      v.y -= 4 * dt;  // 중력
      v.x *= 0.94; v.z *= 0.94; // 감속
    }
    b.points.geometry.attributes.position.needsUpdate = true;
    b.points.material.opacity = Math.max(0, 1 - t);
    b.points.material.size = 0.35 + t * 0.5;
    if (b.life >= b.maxLife) {
      scene.remove(b.points);
      b.points.geometry.dispose();
      b.points.material.dispose();
      _dustBursts.splice(i, 1);
    }
  }
}

// 이전 alive 상태 추적 - 변화 시 먼지 애니메이션
const _prevAlive = {};
function checkAliveTransitions(rs) {
  if (!rs || !rs.alive) return;
  Object.keys(rs.alive).forEach(uid => {
    const wasAlive = _prevAlive[uid] !== false; // 처음엔 살아있음
    const nowAlive = rs.alive[uid] !== false;
    if (wasAlive && !nowAlive) {
      // 죽음 감지 - 위치 계산
      let x = 0, y = 1, z = 0;
      if (uid === myUid) {
        x = player.position.x; y = player.position.y; z = player.position.z;
      } else if (otherPlayers[uid]) {
        x = otherPlayers[uid].group.position.x;
        y = otherPlayers[uid].group.position.y;
        z = otherPlayers[uid].group.position.z;
      }
      spawnDustBurst(x, y, z);
    }
    _prevAlive[uid] = nowAlive;
  });
  // 죽은 다른 플레이어 모델 숨김
  Object.keys(otherPlayers).forEach(uid => {
    const dead = rs.alive?.[uid] === false;
    otherPlayers[uid].group.visible = !dead;
  });
  // 내가 죽었으면 내 모델도 숨김, 살아났으면 다시 보이게
  const iAmDead = rs.alive?.[myUid] === false;
  Object.values(poseModels).forEach(m => { if (m) m.visible = !iAmDead && (m === currentPoseGlb); });
  if (attachedGun) attachedGun.visible = !iAmDead;
}

// ============ 관전 시스템 ============
let spectatorMode = false;
let spectatorTargetUid = null; // 관전 중인 uid
let _spectatorBtn = null;

function showInfectionPopup() {
  const el = document.getElementById('infectionPopup');
  if (!el) return;
  el.style.display = 'flex';
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.style.display = 'none'; }, 2500);
}

function onIDied() {
  console.log('💀 내가 죽음 → 관전 전환');
  // 3초 후 관전 모드로 전환
  const ds = document.getElementById('deathScreen');
  ds.classList.remove('hidden');
  setTimeout(() => {
    ds.classList.add('hidden');
    enterSpectatorMode();
  }, 3000);
}

function enterSpectatorMode() {
  spectatorMode = true;
  // 살아있는 hider 목록에서 첫 번째 타겟
  const aliveMap = roundState?.alive || {};
  const seekerUid = _cachedRoom?.seekerUid;
  const alivePlayers = Object.keys(otherPlayers).filter(uid => aliveMap[uid] !== false && uid !== seekerUid);
  spectatorTargetUid = alivePlayers.length > 0 ? alivePlayers[0] : (seekerUid || null);
  // 관전 HUD 표시
  showSpectatorHUD();
  console.log('👁 관전 시작:', spectatorTargetUid);
}

function showSpectatorHUD() {
  let hud = document.getElementById('spectatorHUD');
  if (!hud) {
    hud = document.createElement('div');
    hud.id = 'spectatorHUD';
    hud.style.cssText = 'position:fixed;top:88px;left:50%;transform:translateX(-50%);z-index:40;background:rgba(0,0,0,0.7);color:#fff;padding:8px 20px;border-radius:20px;font-family:Nunito,sans-serif;font-weight:800;font-size:13px;pointer-events:none;text-align:center;border:2px solid rgba(255,255,255,0.2);';
    document.body.appendChild(hud);
  }
  hud.style.display = 'block';
  const nick = spectatorTargetUid ? (otherPlayers[spectatorTargetUid]?.charMesh ? '?' : '?') : '없음';
  // 닉은 Firebase에서 가져오기
  const playerNick = _cachedRoom?.players?.[spectatorTargetUid]?.nick || spectatorTargetUid?.slice(0,6) || '없음';
  hud.textContent = `관전 중: ${playerNick} | 좌클릭/우클릭으로 전환`;
}

function exitSpectatorMode() {
  spectatorMode = false;
  spectatorTargetUid = null;
  const hud = document.getElementById('spectatorHUD');
  if (hud) hud.style.display = 'none';
}

function spectatorNext(dir) {
  if (!spectatorMode) return;
  const aliveMap = roundState?.alive || {};
  const allUids = Object.keys(otherPlayers).filter(uid => aliveMap[uid] !== false);
  if (!allUids.length) return;
  const idx = allUids.indexOf(spectatorTargetUid);
  let next = (idx + dir + allUids.length) % allUids.length;
  spectatorTargetUid = allUids[next];
  showSpectatorHUD();
  console.log('👁 관전 전환:', spectatorTargetUid);
}

// 마우스 클릭으로 관전 전환
document.addEventListener('mousedown', e => {
  if (!spectatorMode) return;
  if (e.button === 0) spectatorNext(1);  // 좌클릭: 다음
  else if (e.button === 2) spectatorNext(-1); // 우클릭: 이전
});
// 우클릭 메뉴 막기 (관전 중)
document.addEventListener('contextmenu', e => {
  if (spectatorMode) e.preventDefault();
});

// endRound 제거 - host tick 이 관리

async function showScoreboard() {
  currentScreen = 'scoreboard';
  document.exitPointerLock();
  const roomSnap = await get(ref(fbDb, `rooms/${myRoomId}`));
  const room = roomSnap.val();
  const roundSnap = await get(ref(fbDb, `rooms/${myRoomId}/round`));
  const round = roundSnap.val();
  const players = room.players || {};
  const scores = round.scores || {};
  const rows = Object.keys(players).map(uid => ({
    uid, nick: players[uid].nick, score: scores[uid] || 0, alive: round.alive?.[uid] !== false,
    isSeeker: uid === room.seekerUid
  }));
  rows.sort((a, b) => b.score - a.score);

  // ★ 코인(코인) 지급 — 내 점수 비례 (한 라운드당 1회만)
  const myRow = rows.find(r => r.uid === myUid);
  const roundKey = 'wc_paid_' + myRoomId + '_' + (round?.startTs || 0);
  if (false && myRow && !sessionStorage.getItem(roundKey)) {
    sessionStorage.setItem(roundKey, '1');
    // 점수 100당 코인 10 + 완주 보너스 (술래거나 살아남으면 +30)
    let earned = Math.floor((myRow.score || 0) / 10);
    if (myRow.alive || myRow.isSeeker) earned += 30;
    // 1등 보너스
    if (rows[0]?.uid === myUid) earned += 50;
    if (earned > 0) {
      addCoins(earned);
      console.log('💰 코인 획득:', earned, '(총:', getCoins(), ')');
      // 스코어보드 상단에 획득 알림 잠깐 (있으면)
      showCoinEarned(earned);
    }
  }
  
  const box = document.getElementById('scoreList');
  box.innerHTML = '';
  rows.forEach((r, i) => {
    const row = document.createElement('div');
    row.className = 'player-row' + (i === 0 ? ' first' : '');
    const rankEmojis = ['🥇','🥈','🥉'];
    const rankHtml = i < 3
      ? `<span class="rank">${rankEmojis[i]}</span>`
      : `<span class="rank">${i+1}</span>`;
    const roleTag = r.isSeeker
      ? `<span style="font-size:11px;background:var(--red);color:#fff;padding:1px 7px;border-radius:999px;margin-left:6px;font-weight:800;">술래</span>`
      : (!r.alive ? `<span style="font-size:11px;background:var(--panel2);color:var(--text-dim);padding:1px 7px;border-radius:999px;margin-left:6px;font-weight:800;">탈락</span>` : '');
    row.innerHTML = `
      <div style="display:flex;align-items:center;gap:6px;">${rankHtml}<span style="font-weight:800;">${escHtml(sanitizeNick(r.nick,16))}</span>${roleTag}</div>
      <div class="score-val">${r.score}</div>
    `;
    box.appendChild(row);
  });
  showScreen('scoreboard');
}

// 결과 화면에서 방으로 돌아가기
let _backToLobbyPending = false;
document.getElementById('backToLobbyBtn').addEventListener('click', async () => {
  if (_backToLobbyPending) return; // 중복 클릭 방지
  _backToLobbyPending = true;
  // ★ 먼저 currentScreen을 result로 표시해 onValue가 playing/ended 받아도 startGame 재호출 방지
  currentScreen = 'result';
  window._endSeqStarted = false; // 다음 라운드 종료 시퀀스 재사용 가능하게
  // ★ 모든 클라이언트가 자기 맵 리셋 (그래야 다음 라운드 새 맵 로드됨)
  resetMap();
  // ★ 관전 모드 리셋
  exitSpectatorMode();
  // ★ 생존/점수 리셋
  myAlive = true;
  myScore = 0;
  roundState = { phase: 'idle', startedAt: 0, endsAt: 0 };
  inHidePhase = false;
  syncStarted = false; // 다음 게임에서 재등록 허용
  if (scoreTimer) { clearInterval(scoreTimer); scoreTimer = null; }
  // prevAlive 리셋
  Object.keys(_prevAlive).forEach(k => delete _prevAlive[k]);
  // 방장이 상태 리셋
  if (await uid_is_host_by_id(myRoomId)) {
    await update(ref(fbDb, `rooms/${myRoomId}`), {
      state: 'lobby',
      round: null,
      countdown: null,
      voteCountdown: null,
      votePhase: null,
      drawCountdown: null,
      roundCountdown: null,
      hidePhaseCountdown: null,
      selectedMap: null,
      seekerUid: null,
      seekers: null,         // 감염 목록 리셋
      gameMode: null,        // 게임 모드 리셋
      postInfectionCountdown: null,  // 감염 카운트다운 리셋
      startRequested: null,
      catches: null,
      decoys: null,
      whistles: null,
      paint: null
    });
    // ★ 투표 리셋은 각 클라이언트가 자기 것만 (rule: players/$uid = 본인만 write)
    //   방장이 남 것 지우려 하면 permission_denied → 각자 handleVoteReset 에서 처리
  }
  currentScreen = 'lobby';
  _backToLobbyPending = false;
  showScreen('lobby');
});

// ★ 방장 시작 버튼
let _startBtnCooldown = false;
document.getElementById('startGameBtn').addEventListener('click', async () => {
  if (!myRoomId) return;
  if (_startBtnCooldown) return; // 중복 클릭 방지
  _startBtnCooldown = true;
  setTimeout(() => { _startBtnCooldown = false; }, 3000);
  const snap = await get(ref(fbDb, `rooms/${myRoomId}`));
  const room = snap.val();
  if (!room) { _startBtnCooldown = false; return; }
  if (room.hostUid !== myUid) { alert('방장만 시작할 수 있음'); _startBtnCooldown = false; return; }
  const count = Object.keys(room.players || {}).length;
  if (count < 2) { alert('최소 2명 필요'); _startBtnCooldown = false; return; }
  if (room.startRequested) { _startBtnCooldown = false; return; } // 이미 요청됨
  await update(ref(fbDb, `rooms/${myRoomId}`), { startRequested: true });
  console.log('▶ 방장이 게임 시작 요청');
});


// stand 실제 사이즈를 저장해두고 crouch도 그 기준 스케일로
let _standRefScale = null;
function processGlb(gltf, poseName) {
  const glb = gltf.scene;
  const box = new THREE.Box3().setFromObject(glb);
  const size = new THREE.Vector3(); box.getSize(size);
  // 두 포즈 모두 자기 크기 기준 1.7m 로 정규화 (동일 시각 크기)
  const scale = 1.7 / size.y;
  glb.scale.setScalar(scale);
  const box2 = new THREE.Box3().setFromObject(glb);
  // X/Z 중심 원점 정렬 (뒤틀림 방지)
  glb.position.y = -box2.min.y;
  const center = new THREE.Vector3(); box2.getCenter(center);
  glb.position.x = -center.x;
  glb.position.z = -center.z;
  // 머리 y = 포즈별 근사값 (bbox는 스켈레톤 본까지 잡혀서 부정확)
  const HEAD_Y_MAP = {
    stand: 1.55, crouch: 0.9,
    Meditation: 1.05, greeting: 1.55, 'Doing-the-splits': 0.85,
    driving: 1.1, 'Warm-up': 1.5, 'Leg-splits': 0.85,
  };
  poseHeadY[poseName] = HEAD_Y_MAP[poseName] ?? 1.55;
  console.log(`포즈 [${poseName}] 머리 Y:`, poseHeadY[poseName]);
  glb.traverse(o => {
    if (o.isMesh) {
      o.castShadow = false;   // ★ 최적화: 그림자 비활성
      o.receiveShadow = false;
      // geometry 클론 (다른 mesh와 공유 방지 - 색 독립 적용)
      o.geometry = o.geometry.clone();
      // indexed geometry → non-indexed 변환 (vertex color 면 단위 독립 적용)
      if (o.geometry.index) {
        o.geometry = o.geometry.toNonIndexed();
      }
      // 정점 컬러 속성 확실히 (흰색 초기화)
      const posCount = o.geometry.attributes.position.count;
      const colorArr = new Float32Array(posCount * 3).fill(1);
      const colorAttr = new THREE.BufferAttribute(colorArr, 3);
      colorAttr.setUsage(THREE.DynamicDrawUsage); // GPU에 dynamic 힌트
      o.geometry.setAttribute('color', colorAttr);
      // Lambert 재질 - 조명 있으면서 vertex color 확실히 반영
      // DoubleSide: toNonIndexed 후 법선 뒤집힌 face 및 원본 양면 mesh 안쪽 뚫림 방지
      o.material = new THREE.MeshLambertMaterial({
        color: 0xffffff, vertexColors: true, side: THREE.DoubleSide
      });
      o.material.needsUpdate = true;
      o.frustumCulled = true; // ★ 최적화: 화면 밖 컬링 활성
    }
  });
  // 로드 즉시 player 에 추가 (일단 숨김)
  glb.visible = false;
  glb.userData.animations = gltf.animations || []; // ★ 애니메이션 클립 저장
  player.add(glb);
  return glb;
}

// 포즈별 애니메이션 mixer (자기 캐릭터 + 다른 플레이어)
let selfMixer = null;
const otherMixers = new Map(); // uid → { mixer, action }
const _poseWheelMixers = new Map(); // pose → mixer (프리뷰용)

// ★ 앉기 계열 포즈 발동 시 미끄러짐 (무빙 테크)
let _slideVX = 0, _slideVZ = 0, _slideEndTime = 0;
const SLIDE_DURATION_MS = 1500;
const SLIDE_INITIAL_SPEED = 22; // m/s (뛰기 속도랑 같게 → 부드럽게 이어짐)

function playSelfPoseAnim(poseName) {
  const model = poseModels[poseName];
  if (!model) return;
  const anims = model.userData.animations;
  if (selfMixer) { selfMixer.stopAllAction(); selfMixer.uncacheRoot(selfMixer.getRoot()); selfMixer = null; }
  if (!anims || !anims.length) return;
  selfMixer = new THREE.AnimationMixer(model);
  const action = selfMixer.clipAction(anims[0]);
  action.setLoop(THREE.LoopRepeat, Infinity);
  action.reset().play();
}

// 앉기 계열 → 슬라이드 시작
function triggerSlideIfSittable(poseName) {
  const meta = POSE_DISPLAY[poseName];
  if (!meta || !meta.sittable) return;
  if (currentScreen !== 'game') return;
  // 캐릭터가 바라보는 방향으로 슬라이드
  // player.rotation.y = atan2(wx, wz) + PI (이동 방향 기준). 앞 방향 = (-sin(rot), -cos(rot))
  const rot = player.rotation.y;
  const fx = -Math.sin(rot);
  const fz = -Math.cos(rot);
  _slideVX = fx * SLIDE_INITIAL_SPEED;
  _slideVZ = fz * SLIDE_INITIAL_SPEED;
  _slideEndTime = performance.now() + SLIDE_DURATION_MS;
  console.log('🛷 슬라이드 발동:', poseName, '방향(', fx.toFixed(2), fz.toFixed(2), ')');
}

// 포즈 전환 치지직 효과
function triggerPoseTransitionEffect() {
  const ov = document.getElementById('poseTransitionOverlay');
  if (!ov) return;
  ov.classList.remove('active');
  void ov.offsetWidth;
  ov.classList.add('active');
  document.body.classList.add('poseFadeShake');
  setTimeout(() => {
    ov.classList.remove('active');
    document.body.classList.remove('poseFadeShake');
  }, 500);
}

// 포즈 전환
function switchPose(poseName) {
  if (!poseModels[poseName]) { console.warn('포즈 없음:', poseName); return; }
  currentPose = poseName;
  currentPoseGlb = poseModels[poseName];
  player._meshes = null;
  // ★ 죽었으면 모든 포즈 숨김 유지 (포즈 바꿔도 보이면 안 됨)
  const iAmDead = roundState?.alive?.[myUid] === false;
  Object.entries(poseModels).forEach(([name, model]) => {
    if (model) model.visible = !iAmDead && (name === poseName);
  });
  if (attachedGun) attachedGun.visible = !iAmDead;
  // characterMeshes 갱신
  characterMeshes = [];
  currentPoseGlb.traverse(o => {
    if (o.isMesh) characterMeshes.push(o);
  });
  console.log('👤 포즈 전환:', poseName, '/ 죽음=', iAmDead, '/ mesh 수:', characterMeshes.length);
  // 애니메이션 재생
  playSelfPoseAnim(poseName);
  // ★ 발 정렬: 애니메이션이 적용된 뒤 모델 최저점을 재서 발이 바닥에 딱 닿게 보정
  //   (포즈/애니에 따라 모델이 발 기준점보다 아래로 튀어나와 땅에 파묻히는 것 방지)
  _schedulePoseFeetAlign();
  // 앉기 계열이면 슬라이드 발동
  triggerSlideIfSittable(poseName);
  // 게임 중 R 키로 전환할 때만 효과 (로딩 초기화 때는 스킵)
  if (currentScreen === 'game') triggerPoseTransitionEffect();
}

// ★ 포즈 모델의 실제 최저점을 측정해 발이 바닥(player 원점)에 닿도록 y 오프셋 보정
const _poseAlignBox = new THREE.Box3();
function _alignCurrentPoseFeet() {
  const glb = currentPoseGlb;
  if (!glb) return;
  player.updateMatrixWorld(true);
  _poseAlignBox.setFromObject(glb);
  if (!isFinite(_poseAlignBox.min.y)) return;
  // 모델 최저점의 player-로컬 높이 (player.rotation.y는 Y범위에 영향 없음)
  const localMinY = _poseAlignBox.min.y - player.position.y;
  // 발보다 아래로 튀어나왔으면(음수) 그만큼 올려서 바닥에 닿게 (과보정/과다상승 방지 클램프)
  if (localMinY < -0.06 && localMinY > -2.5) {
    glb.position.y += (-localMinY);
    console.log('👣 포즈 발 정렬 보정: +' + (-localMinY).toFixed(2) + ' (' + currentPose + ')');
  }
}
let _poseAlignTimers = [];
function _schedulePoseFeetAlign() {
  _poseAlignTimers.forEach(t => clearTimeout(t));
  _poseAlignTimers = [];
  // 즉시 + 애니 적용 후(짧게 여러 번) 재측정 → 안정적으로 발 맞춤
  _alignCurrentPoseFeet();
  _poseAlignTimers.push(setTimeout(_alignCurrentPoseFeet, 150));
  _poseAlignTimers.push(setTimeout(_alignCurrentPoseFeet, 400));
}

// ================ 포즈 정의 (한 곳에서 관리) ================
// 추가하려면: 여기에 { id, name } 넣고 pose/<id>.glb 파일 넣으면 끝. 휠에도 자동 표시.
const POSE_LIST = ['stand', 'crouch', 'Meditation', 'greeting', 'Doing-the-splits'];
const POSE_DISPLAY = {
  stand:  { name: '기본' },
  crouch: { name: '앉기', sittable: true },
  Meditation: { name: '명상', sittable: true },
  greeting: { name: '인사' },
  'Doing-the-splits': { name: '다리찢기', sittable: true },
};

// 두 포즈 병렬 로드 (URL 기반, 훨씬 빠름)
const loadProgress = { tokyo: 0 };
POSE_LIST.forEach(id => { loadProgress[id] = 0; });
function updateLoadingText() {
  const t = document.getElementById('loadStat');
  if (!t) return;
  const poseTxt = Object.keys(loadProgress).filter(k => k !== 'tokyo').map(k => `${k} ${loadProgress[k]}%`).join(' / ');
  t.textContent = `캐릭터: ${poseTxt} · 맵: ${loadProgress.tokyo}%`;
}

// 각 포즈 자동 로드 (./pose/<id>.glb)
POSE_LIST.forEach(poseId => {
  const url = `./pose/${poseId}.glb`;
  console.log('🎭 포즈 로드 시도:', url);
  gltfLoader.load(url, gltf => {
    poseModels[poseId] = processGlb(gltf, poseId);
    console.log('✅ 포즈 로드 완료:', poseId);
    // 첫 번째 (stand) 로드되면 기본 포즈 세팅 + 캐릭터 템플릿 설정
    if (poseId === 'stand') {
      if (!currentPoseGlb) switchPose('stand');
      characterTemplate = poseModels.stand;
    }
    if (poseId in loadProgress) { loadProgress[poseId] = 100; updateLoadingText(); }
  }, xhr => {
    if (xhr.total && poseId in loadProgress) {
      loadProgress[poseId] = Math.round(xhr.loaded/xhr.total*100);
      updateLoadingText();
    }
  }, err => console.error('❌ 포즈 로드 실패:', url, err?.message || err));
});



// ================ 포즈 휠 (P 홀드) ================
// POSE_LIST / POSE_DISPLAY 는 상단 포즈 로더 근처에서 정의됨
let poseWheelOpen = false;
let poseWheelHover = null;
const _poseWheelPreviews = new Map(); // pose → { canvas, renderer, scene, camera, obj, wrap, angle }
const POSE_WHEEL_RADIUS = 180; // 중심에서 슬롯까지 px

// 파이 조각 색 팔레트 — 다크 네이비 톤 (튐 없이 깔끔)
const WHEEL_COLORS = ['#2a3348', '#333c54', '#2e3850', '#374260', '#2c3548', '#333d55'];

function initPoseWheelSlots() {
  const svg = document.getElementById('poseWheelSvg');
  const container = document.getElementById('poseWheelItems');
  if (!svg || !container) return;
  if (svg.childElementCount > 0) return; // 이미 초기화됨

  const n = POSE_LIST.length;
  const R_OUT = 210, R_IN = 92;   // 파이 외/내 반지름 (viewBox -220~220 기준)
  const R_MID = (R_OUT + R_IN) / 2; // 캔버스 배치 반지름
  const wedgeAngle = (Math.PI * 2) / n; // 조각 하나 각도
  const startOffset = -Math.PI / 2 - wedgeAngle / 2; // 첫 조각이 위(-π/2) 중앙에 오도록

  POSE_LIST.forEach((poseName, i) => {
    const a0 = startOffset + i * wedgeAngle;
    const a1 = a0 + wedgeAngle;
    // 파이 조각 path (도넛)
    const x0o = Math.cos(a0) * R_OUT, y0o = Math.sin(a0) * R_OUT;
    const x1o = Math.cos(a1) * R_OUT, y1o = Math.sin(a1) * R_OUT;
    const x1i = Math.cos(a1) * R_IN,  y1i = Math.sin(a1) * R_IN;
    const x0i = Math.cos(a0) * R_IN,  y0i = Math.sin(a0) * R_IN;
    const largeArc = wedgeAngle > Math.PI ? 1 : 0;
    const d = `M ${x0o} ${y0o} A ${R_OUT} ${R_OUT} 0 ${largeArc} 1 ${x1o} ${y1o} L ${x1i} ${y1i} A ${R_IN} ${R_IN} 0 ${largeArc} 0 ${x0i} ${y0i} Z`;
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', WHEEL_COLORS[i % WHEEL_COLORS.length]);
    path.classList.add('wedge');
    path.dataset.pose = poseName;
    svg.appendChild(path);

    // 조각 중앙에 3D 프리뷰 캔버스 배치
    const midAngle = (a0 + a1) / 2;
    const cx = Math.cos(midAngle) * R_MID;
    const cy = Math.sin(midAngle) * R_MID;
    // viewBox 좌표 → % 로 변환 (viewBox -220~220 = 440 스팬)
    const pctX = 50 + (cx / 440) * 100;
    const pctY = 50 + (cy / 440) * 100;
    const wrap = document.createElement('div');
    wrap.className = 'poseSlot';
    wrap.style.left = pctX + '%';
    wrap.style.top = pctY + '%';
    wrap.dataset.pose = poseName;
    const canvas = document.createElement('canvas');
    canvas.width = 110; canvas.height = 110;
    wrap.appendChild(canvas);
    container.appendChild(wrap);

    // three.js 프리뷰 씬 (공유 렌더러 사용 - WebGL 컨텍스트 초과 방지)
    try {
      const scene = new THREE.Scene();
      scene.background = null;
      scene.add(new THREE.AmbientLight(0xffffff, 1.4));
      const dl = new THREE.DirectionalLight(0xffffff, 1.0);
      dl.position.set(1, 2, 1); scene.add(dl);
      const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 20);
      camera.position.set(0, 1.0, 4.5);
      camera.lookAt(0, 0.9, 0);
      // canvas는 copyTexImage2D 대상으로만 사용 (렌더 타겟에서 읽어옴)
      _poseWheelPreviews.set(poseName, { canvas, scene, camera, wrap, angle: midAngle, path, obj: null });
    } catch (err) {
      console.warn('포즈 프리뷰 씬 생성 실패:', poseName, err);
    }
  });
}

function loadPoseWheelObjects() {
  _poseWheelPreviews.forEach((prev, name) => {
    const src = poseModels[name];
    if (!src || prev.obj) return;
    const cloned = SkeletonUtils.clone(src);
    cloned.traverse(o => {
      if (o.isMesh) o.frustumCulled = false;
    });
    cloned.visible = true;
    prev.scene.add(cloned);
    prev.obj = cloned;
    // ★ 애니메이션 중간 프레임에서 고정 (재생 X, 계속 그 포즈로 서있게)
    const anims = src.userData.animations;
    if (anims && anims.length) {
      const mixer = new THREE.AnimationMixer(cloned);
      const action = mixer.clipAction(anims[0]);
      action.play();
      // 중간 지점으로 이동 후 정지
      mixer.setTime(anims[0].duration * 0.5);
      action.paused = true;
      prev.mixer = null; // update 안 함
    }
  });
}

function openPoseWheel() {
  if (poseWheelOpen) return;
  if (currentScreen !== 'game') return;
  if (paintMode) return;
  poseWheelOpen = true;
  initPoseWheelSlots();
  loadPoseWheelObjects();
  const el = document.getElementById('poseWheel');
  el.classList.remove('hidden');
  _poseWheelPreviews.forEach((prev, name) => {
    prev.wrap.classList.toggle('current', name === currentPose);
    prev.wrap.classList.remove('hover');
    if (prev.path) {
      prev.path.classList.toggle('current', name === currentPose);
      prev.path.classList.remove('hover');
    }
  });
  // 라벨 초기값
  const lbl = document.getElementById('poseWheelLabel');
  if (lbl) lbl.textContent = POSE_DISPLAY[currentPose]?.name || currentPose;
  poseWheelHover = null;
  if (document.pointerLockElement) document.exitPointerLock();
}

function closePoseWheel(commitSelection) {
  if (!poseWheelOpen) return;
  poseWheelOpen = false;
  document.getElementById('poseWheel').classList.add('hidden');
  if (commitSelection && poseWheelHover && poseWheelHover !== currentPose) {
    switchPose(poseWheelHover);
  }
  poseWheelHover = null;
  if (currentScreen === 'game' && !paintMode) {
    setTimeout(() => lockPointer(), 30);
  }
}

// 마우스 위치 → 어느 슬롯이 hover 상태인지 계산
addEventListener('mousemove', e => {
  if (!poseWheelOpen) return;
  const cx = innerWidth / 2, cy = innerHeight / 2;
  const dx = e.clientX - cx, dy = e.clientY - cy;
  const distSq = dx*dx + dy*dy;
  if (distSq < 55*55) {
    if (poseWheelHover !== null) {
      _poseWheelPreviews.forEach(prev => {
        prev.wrap.classList.remove('hover');
        if (prev.path) prev.path.classList.remove('hover');
      });
      poseWheelHover = null;
      const lbl = document.getElementById('poseWheelLabel');
      if (lbl) lbl.textContent = POSE_DISPLAY[currentPose]?.name || currentPose;
    }
    return;
  }
  const mouseAngle = Math.atan2(dy, dx);
  let best = null, bestDiff = Infinity;
  _poseWheelPreviews.forEach((prev, name) => {
    let d = Math.abs(mouseAngle - prev.angle);
    if (d > Math.PI) d = Math.PI*2 - d;
    if (d < bestDiff) { bestDiff = d; best = name; }
  });
  if (best !== poseWheelHover) {
    poseWheelHover = best;
    _poseWheelPreviews.forEach((prev, name) => {
      const isHover = name === best;
      prev.wrap.classList.toggle('hover', isHover);
      if (prev.path) prev.path.classList.toggle('hover', isHover);
    });
    const lbl = document.getElementById('poseWheelLabel');
    if (lbl) lbl.textContent = POSE_DISPLAY[best]?.name || best;
  }
});

// R 홀드/릴리즈 → 포즈 휠
addEventListener('keydown', e => {
  if (e.code === 'KeyR' && !e.repeat && !paintMode && currentScreen === 'game') {
    e.preventDefault();
    openPoseWheel();
  }
});
addEventListener('keyup', e => {
  if (e.code === 'KeyR' && poseWheelOpen) {
    e.preventDefault();
    closePoseWheel(true);
  }
});
// 창 blur 되면 안전하게 닫음 (P 놓은거 놓침 방지)
addEventListener('blur', () => { if (poseWheelOpen) closePoseWheel(false); });

// 매 프레임 미니 씬 렌더 (열려있을 때만)
// ★ 메인 renderer 재활용: 추가 WebGL 컨텍스트 0개
// ★ 최적화: 프리뷰는 정적(mixer paused)이므로 프리뷰당 1회만 렌더 → 매프레임 GPU stall 제거
const _poseWheelPixBuf = new Uint8Array(110 * 110 * 4); // 재사용 버퍼 (GC 압박 X)
function renderPoseWheel() {
  if (!poseWheelOpen) return;
  // 모두 이미 렌더됐으면 아무것도 안 함 → 오픈 중 프레임 비용 0
  let anyPending = false;
  _poseWheelPreviews.forEach(prev => { if (prev.obj && !prev.rendered) anyPending = true; });
  if (!anyPending) return;

  // RenderTarget lazy 생성 (첫 호출 시 1회)
  if (!_poseWheelRT) {
    _poseWheelRT = new THREE.WebGLRenderTarget(110, 110, {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      samples: 0
    });
  }
  const prevTarget = renderer.getRenderTarget();
  const prevClearAlpha = renderer.getClearAlpha();
  renderer.setRenderTarget(_poseWheelRT);
  renderer.setClearColor(0x000000, 0);
  _poseWheelPreviews.forEach(prev => {
    if (!prev.obj || prev.rendered) return; // ★ 이미 렌더됐으면 스킵
    try {
      renderer.clear();
      renderer.render(prev.scene, prev.camera);
      renderer.readRenderTargetPixels(_poseWheelRT, 0, 0, 110, 110, _poseWheelPixBuf);
      const ctx = prev.canvas.getContext('2d');
      if (ctx) {
        const id = ctx.createImageData(110, 110);
        // WebGL UV는 Y 뒤집혀 있음 — 행 단위로 플립
        for (let row = 0; row < 110; row++) {
          const src = (109 - row) * 110 * 4;
          const dst = row * 110 * 4;
          id.data.set(_poseWheelPixBuf.subarray(src, src + 110 * 4), dst);
        }
        ctx.putImageData(id, 0, 0);
        prev.rendered = true; // ★ 캐시 완료 표시 → 다음 프레임부터 스킵
      }
    } catch(e) {}
  });
  renderer.setRenderTarget(prevTarget);
  renderer.setClearAlpha(prevClearAlpha);
}


// 다른 플레이어용 원본 (Template = 서있는 포즈 클론)
let characterTemplate = null;

// ================ 도쿄 ================
const collidableMeshes = [];
let mixer = null;
const clock = new THREE.Clock();

// ==== 맵 시스템 (투표로 선택) ====
// ★ 폴리곤 맵 생성 함수 (Three.js 프로시저럴)
function buildPolygonMap(type) {
  const group = new THREE.Group();
  const meshes = [];
  if (type === 'arena') {
    // 팔각형 아레나: 중앙 광장 + 기둥 8개 + 경사로 4개
    const floorGeo = new THREE.CylinderGeometry(40, 40, 0.5, 8);
    const floorMat = new THREE.MeshLambertMaterial({ color: 0x5a4a3a });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.position.y = -0.25;
    group.add(floor); meshes.push(floor);
    // 외벽 (팔각형)
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const wallGeo = new THREE.BoxGeometry(10, 8, 1.2);
      const wallMat = new THREE.MeshLambertMaterial({ color: 0x7a6a5a });
      const wall = new THREE.Mesh(wallGeo, wallMat);
      wall.position.set(Math.sin(a)*38, 4, Math.cos(a)*38);
      wall.rotation.y = -a;
      group.add(wall); meshes.push(wall);
    }
    // 중앙 기둥들
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const pillarGeo = new THREE.CylinderGeometry(1.2, 1.2, 10, 6);
      const pillarMat = new THREE.MeshLambertMaterial({ color: 0x9a8070 });
      const pillar = new THREE.Mesh(pillarGeo, pillarMat);
      pillar.position.set(Math.sin(a)*20, 5, Math.cos(a)*20);
      group.add(pillar); meshes.push(pillar);
    }
    // 계단 플랫폼 4개
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI/4;
      const platGeo = new THREE.BoxGeometry(8, 0.5, 8);
      const platMat = new THREE.MeshLambertMaterial({ color: 0x6a5a4a });
      const plat = new THREE.Mesh(platGeo, platMat);
      plat.position.set(Math.sin(a)*12, 3, Math.cos(a)*12);
      group.add(plat); meshes.push(plat);
      // 계단
      for (let s = 0; s < 3; s++) {
        const stepGeo = new THREE.BoxGeometry(8, 0.5, 2);
        const step = new THREE.Mesh(stepGeo, platMat.clone());
        step.position.set(Math.sin(a)*12, s*1, Math.cos(a)*12 + Math.cos(a)*((3-s)*1.5));
        group.add(step); meshes.push(step);
      }
    }
    // 중앙 오벨리스크
    const obGeo = new THREE.CylinderGeometry(0.5, 1.5, 12, 4);
    const obMat = new THREE.MeshLambertMaterial({ color: 0xc0a080 });
    const ob = new THREE.Mesh(obGeo, obMat);
    ob.position.set(0, 6, 0);
    group.add(ob); meshes.push(ob);
  } else if (type === 'maze') {
    // 미로: 격자형 벽 + 비어있는 경로
    const floorGeo = new THREE.BoxGeometry(80, 0.5, 80);
    const floorMat = new THREE.MeshLambertMaterial({ color: 0x3a4a3a });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.position.y = -0.25;
    group.add(floor); meshes.push(floor);
    const wallMat = new THREE.MeshLambertMaterial({ color: 0x2a5a2a });
    // 미로 레이아웃 (1=벽)
    const layout = [
      [1,1,1,1,1,1,1,1,1,1],
      [1,0,0,0,1,0,0,0,0,1],
      [1,0,1,0,1,0,1,1,0,1],
      [1,0,1,0,0,0,1,0,0,1],
      [1,0,1,1,1,0,1,0,1,1],
      [1,0,0,0,1,0,0,0,1,1],
      [1,1,1,0,1,1,1,0,1,1],
      [1,0,0,0,0,0,1,0,0,1],
      [1,0,1,1,1,0,0,1,0,1],
      [1,1,1,1,1,1,1,1,1,1],
    ];
    const cell = 8, wh = 6;
    const off = -(layout.length * cell) / 2;
    for (let r = 0; r < layout.length; r++) {
      for (let c = 0; c < layout[r].length; c++) {
        if (!layout[r][c]) continue;
        const wGeo = new THREE.BoxGeometry(cell, wh, cell);
        const wall = new THREE.Mesh(wGeo, wallMat.clone());
        wall.position.set(off + c*cell + cell/2, wh/2, off + r*cell + cell/2);
        group.add(wall); meshes.push(wall);
      }
    }
    // 미로 내 장애물/숨을 곳 블록들
    const boxes = [[2,2],[5,3],[7,5],[3,7],[6,7],[4,5]];
    const boxMat = new THREE.MeshLambertMaterial({ color: 0x4a7a4a });
    for (const [bc, br] of boxes) {
      const bGeo = new THREE.BoxGeometry(3, 3, 3);
      const box = new THREE.Mesh(bGeo, boxMat.clone());
      box.position.set(off + bc*cell + cell/2, 1.5, off + br*cell + cell/2);
      group.add(box); meshes.push(box);
    }
  }
  return { group, meshes };
}

const MAPS = [
  {
    // ★ threejs.org 직접 참조는 blob 텍스처 CORS 오류 발생 → jsdelivr CDN 미러 사용
    name: '도쿄 뒷골목',
    url: 'https://cdn.jsdelivr.net/gh/mrdoob/three.js@r160/examples/models/gltf/LittlestTokyo.glb',
    scale: 0.18,
    hasWalls: false,
    procedural: false
  },
  {
    name: 'Sponza 궁전',
    url: 'https://cdn.jsdelivr.net/gh/KhronosGroup/glTF-Sample-Assets@main/Models/Sponza/glTF/Sponza.gltf',
    scale: 3,
    hasWalls: true,
    procedural: false,
    spawnOffsetY: 5
  },
  {
    name: '마켓',
    url: './map/market.glb',
    scale: 2.5,
    hasWalls: true,
    procedural: false,
    spawnOffsetY: -3
  },
  {
    name: '쇼핑몰',
    url: './map/shopping-mall.glb',
    scale: 2.5,
    hasWalls: true,
    procedural: false,
    spawnOffsetY: 0,
    forceSpawnCenter: true
  },

];
let selectedMap = MAPS[0];
let mapLoaded = false;

// ============ 게임 모드 ============
const MODES = [
  { id: 'classic',   name: '클래식',  icon: '🎯', desc: '술래 1명이 다 잡음' },
  { id: 'infection', name: '감염',    icon: '☣️', desc: '잡히면 술래 됨' },
  { id: 'team',      name: '팀',      icon: '⚔️', desc: '술래팀 vs 도망팀' }
];
// 모든 술래 uid 구하기 (원래 술래 + 감염된 애들)
function getSeekerUids(room) {
  if (!room) return [];
  const set = new Set();
  if (room.seekerUid) set.add(room.seekerUid);
  if (room.seekers) {
    Object.keys(room.seekers).forEach(u => { if (room.seekers[u]) set.add(u); });
  }
  return Array.from(set);
}
function isSeekerUid(uid, room) {
  if (!uid || !room) return false;
  if (uid === room.seekerUid) return true;
  return !!(room.seekers && room.seekers[uid]);
}
let _currentMapModel = null;      // 현재 로드된 맵 모델 (리셋용)
let _currentMapLights = [];       // 실내 맵에서 추가한 조명들
let _currentMapMixer = null;      // 애니메이션 mixer

// ★ 맵 완전 초기화 (다음 라운드에서 새 맵 로드 가능하게)
function resetMap() {
  console.log('🧹 맵 리셋');
  if (_currentMapModel) {
    scene.remove(_currentMapModel);
    // geometry / material / BVH 정리 (메모리 누수 방지)
    _currentMapModel.traverse(o => { o.matrixAutoUpdate = true; }); // ★ 복원
    _currentMapModel.traverse(o => {
      if (o.isMesh) {
        if (o.geometry) {
          o.geometry.boundsTree = null;
          o.geometry.dispose();
        }
        if (o.material) {
          if (Array.isArray(o.material)) o.material.forEach(m => m.dispose());
          else o.material.dispose();
        }
      }
    });
    _currentMapModel = null;
  }
  // 조명 제거
  _currentMapLights.forEach(l => scene.remove(l));
  _currentMapLights = [];
  // 애니메이션 정지
  if (_currentMapMixer) {
    _currentMapMixer.stopAllAction();
    _currentMapMixer = null;
  }
  mixer = null;
  // ★ 보이지 않는 경계 케이지 제거 (다음 맵에서 새로 생성)
  if (typeof clearBoundaryCage === 'function') clearBoundaryCage();
  // 충돌체 배열 비우기
  collidableMeshes.length = 0;
  _groundAndCollidable.length = 0;
  _groundAndCollidable.push(ground);
  // 경계 리셋
  worldBounds = null;
  cachedGroundY = null; _lastSolidGroundY = null; _groundDropStreak = 0;
  _lastSafePos = null; // ★ 맵 언로드 → 안전 위치 초기화
  // 바닥 원위치
  if (ground) {
    ground.visible = true;
    ground.position.y = 0;
  }
  // 조명 세기 원위치
  if (typeof ambientLight !== 'undefined' && ambientLight) ambientLight.intensity = 0.75;
  if (typeof hemiLight !== 'undefined' && hemiLight) hemiLight.intensity = 0.6;
  // 다시 로드 가능
  mapLoaded = false;
  selectedMap = MAPS[0];
  const mn = document.getElementById('mapName');
  if (mn) mn.textContent = '-';
}

// ★ 보이지 않는 경계 케이지 (바닥 + 4면 벽)
//   - 바닥: 맵 밑으로 빠지거나 모델 아래에 숨는 것 방지 (추락 시 여기서 잡힘)
//   - 벽: 월드 보더를 실제 콜라이더로 막아서 꼼수로 뚫고 나갈 수 없게
let _cageMeshes = [];
function clearBoundaryCage() {
  for (const m of _cageMeshes) {
    if (m.parent) m.parent.remove(m);
    const ci = collidableMeshes.indexOf(m);
    if (ci >= 0) collidableMeshes.splice(ci, 1);
    const gi = _groundAndCollidable.indexOf(m);
    if (gi >= 0) _groundAndCollidable.splice(gi, 1);
    if (m.geometry) { m.geometry.boundsTree = null; m.geometry.dispose(); }
    if (m.material) m.material.dispose();
  }
  _cageMeshes = [];
}
function buildBoundaryCage(b, baseY, wallHeight) {
  clearBoundaryCage();
  if (!b) return;
  const invisMat = new THREE.MeshBasicMaterial({ visible: false });
  const T = 4;       // 벽 두께 (두껍게 → 어떤 속도로도 못 뚫음)
  const GAP = 1.0;   // 경계(클램프)에서 살짝 바깥에 세움 → 가장자리에서 안 끼임
  const w = b.maxX - b.minX;
  const d = b.maxZ - b.minZ;
  const cx = (b.minX + b.maxX) / 2;
  const cz = (b.minZ + b.maxZ) / 2;
  const wallCY = baseY + wallHeight / 2;
  const add = (geo, x, y, z) => {
    const m = new THREE.Mesh(geo, invisMat);
    m.position.set(x, y, z);
    m.castShadow = false; m.receiveShadow = false;
    m.updateMatrixWorld(true);
    try { geo.boundsTree = new MeshBVH(geo); m.raycast = acceleratedRaycast; } catch(e){}
    scene.add(m);
    collidableMeshes.push(m);
    _cageMeshes.push(m);
  };
  // 4면 벽만 (바닥은 만들지 않음 → 땅 감지에 영향 X, 갑작스런 추락 없음)
  // 벽은 클램프 경계보다 GAP 만큼 바깥에 → 정상 이동엔 안 걸리고, 꼼수로 뚫고 나갈 때만 막음
  add(new THREE.BoxGeometry(w + T * 2 + GAP * 2, wallHeight, T), cx, wallCY, b.minZ - GAP - T / 2);
  add(new THREE.BoxGeometry(w + T * 2 + GAP * 2, wallHeight, T), cx, wallCY, b.maxZ + GAP + T / 2);
  add(new THREE.BoxGeometry(T, wallHeight, d + T * 2 + GAP * 2), b.minX - GAP - T / 2, wallCY, cz);
  add(new THREE.BoxGeometry(T, wallHeight, d + T * 2 + GAP * 2), b.maxX + GAP + T / 2, wallCY, cz);
  console.log('🧱 경계 벽 생성 (벽높이=' + wallHeight + ', baseY=' + baseY.toFixed(2) + ')');
}

function loadSelectedMap(mapIdx) {
  if (mapLoaded) return;
  mapLoaded = true;
  selectedMap = MAPS[mapIdx] || MAPS[0];
  console.log('🗺️ 맵 로딩:', selectedMap.name);
  document.getElementById('mapName').textContent = selectedMap.name;

  // 프로시저럴 맵 처리
  if (selectedMap.procedural) {
    document.getElementById('loading').classList.remove('hidden');
    document.getElementById('loading').querySelector('.loading-title').textContent = selectedMap.name + ' 생성 중...';
    document.getElementById('barFill').style.width = '80%';
    const { group, meshes } = buildPolygonMap(selectedMap.type);
    scene.add(group);
    _currentMapModel = group;
    meshes.forEach(o => {
      if (o.geometry) {
        try { o.geometry.boundsTree = new MeshBVH(o.geometry); o.raycast = acceleratedRaycast; } catch(e){}
      }
      collidableMeshes.push(o);
    });
    _groundAndCollidable.length = 0;
    _groundAndCollidable.push(...collidableMeshes);
    // ★ 스포이드 캐시 무효화 (맵 로드 후 새 collider가 스포이드 대상이 되도록)
    if (typeof invalidatePickerCache === 'function') invalidatePickerCache();
    // 경계 설정
    const finalBox = new THREE.Box3().setFromObject(group);
    const size = new THREE.Vector3(); finalBox.getSize(size);
    const center = new THREE.Vector3(); finalBox.getCenter(center);
    const halfX = (size.x / 2) * 0.85;
    const halfZ = (size.z / 2) * 0.85;
    worldBounds = { minX: center.x - halfX, maxX: center.x + halfX, minZ: center.z - halfZ, maxZ: center.z + halfZ };
    // 스폰
    player.position.set(center.x, 5, center.z);
    velocityY = 0; isGrounded = false;
    ground.visible = false;
    ground.position.y = -1000;
    ambientLight.intensity = 0.9;
    hemiLight.intensity = 0.6;
    document.getElementById('barFill').style.width = '100%';
    document.getElementById('pct').textContent = '100%';
    setTimeout(() => document.getElementById('loading').classList.add('hidden'), 300);
    return;
  }

  document.getElementById('loading').classList.remove('hidden');
  document.getElementById('loading').querySelector('.loading-title').textContent = selectedMap.name + ' 불러오는 중...';

gltfLoader.load(
  selectedMap.url,
  gltf => {
    const model = gltf.scene;
    model.scale.setScalar(selectedMap.scale);
    const box = new THREE.Box3().setFromObject(model);
    model.position.y = -box.min.y;
    model.traverse(o => {
      if (o.isMesh) {
        o.castShadow = false;
        o.receiveShadow = false;
        o.frustumCulled = true;
        // ★ 텍스처 폴백: blob URL 실패로 null이 된 텍스처 슬롯을 1px 흰 텍스처로 채움
        //   → 셰이더 검증(VALIDATE_STATUS) 오류(1282) 방지
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const mat of mats) {
          if (!mat) continue;
          const slots = ['map','normalMap','roughnessMap','metalnessMap','emissiveMap',
                         'aoMap','alphaMap','envMap','lightMap','bumpMap','displacementMap'];
          for (const slot of slots) {
            if (mat[slot] === null && mat.defines && mat.defines['USE_' + slot.toUpperCase()]) {
              mat[slot] = _fallbackTexture;
              mat.needsUpdate = true;
            }
          }
        }
        // 도쿄 mesh에만 BVH 트리 + 이 인스턴스만 accelerated raycast
        if (o.geometry) {
          o.geometry.boundsTree = new MeshBVH(o.geometry);
          o.raycast = acceleratedRaycast; // 인스턴스 메서드
        }
        collidableMeshes.push(o);
      }
    });
    // ★ 최적화: 정적 맵만 행렬 자동 업데이트 끄기
    //   (애니메이션 있는 맵-도쿄 기차 등-을 얼리면 mixer 가 돌아도 화면에 반영 안 됨!)
    const _hasAnim = !!(gltf.animations && gltf.animations.length);
    if (!_hasAnim) {
      model.traverse(o => { o.matrixAutoUpdate = false; o.updateMatrix(); });
    }
    scene.add(model);
    _currentMapModel = model;  // ★ 리셋용 트래킹
    // _groundAndCollidable 동기화 (getGroundHeight 매 프레임 스프레드 방지)
    _groundAndCollidable.length = 0;
    _groundAndCollidable.push(ground, ...collidableMeshes);
    if (gltf.animations.length) {
      mixer = new THREE.AnimationMixer(model);
      mixer.clipAction(gltf.animations[0]).play();
      _currentMapMixer = mixer;
    }

    // 경계(맵 밖 방지)는 그대로 track 하되, 눈에 보이는 벽은 만들지 않음
    // → 밖으로 나가려 하면 tryMove 에서 튕겨내고 허공에 리플 이펙트
    const finalBox = new THREE.Box3().setFromObject(model);
    const size = new THREE.Vector3(); finalBox.getSize(size);
    const center = new THREE.Vector3(); finalBox.getCenter(center);
    // 모델 bbox 는 튀어나온 부분까지 포함하므로 실제 걷는 영역보다 큼
    // → 안쪽으로 20% 조여서 진짜 못 나가게
    const halfX = (size.x / 2) * 0.8;
    const halfZ = (size.z / 2) * 0.8;
    if (!selectedMap.hasWalls) {
      // 야외 맵 - 소프트 경계
      worldBounds = { minX: center.x - halfX, maxX: center.x + halfX,
                      minZ: center.z - halfZ, maxZ: center.z + halfZ };
      console.log('🔷 소프트 경계 설정', worldBounds);
    } else {
      // 실내 맵도 소프트 경계 적용 (맵 밖으로 나가지 않게)
      worldBounds = { minX: center.x - halfX, maxX: center.x + halfX,
                      minZ: center.z - halfZ, maxZ: center.z + halfZ };
      console.log('🔷 실내 경계 설정', worldBounds);
    }

    // 바닥 확장 (실내 맵은 자체 바닥 있으니 안 늘림)
    if (!selectedMap.hasWalls) {
      // 야외 맵은 회색 바닥 완전히 숨기고 raycast 에서도 뺌
      ground.visible = false;
      ground.position.y = -1000;
      _groundAndCollidable.length = 0;
      _groundAndCollidable.push(...collidableMeshes);
    } else {
      // 실내 맵은 우리 바닥 안 보이게 확 아래로
      ground.position.y = -50;
      // 실내라 라이팅 강화
      // ★ 실내 맵 조명: 과노출 방지 (ambient 낮추고 포인트라이트 부드럽게)
      ambientLight.intensity = 0.9;
      hemiLight.intensity = 0.5;
      // 실내엔 point light 추가 (부드러운 중간 밝기)
      const indoorLight = new THREE.PointLight(0xfff5e8, 1.2, 60);
      indoorLight.position.set(center.x, 15, center.z);
      scene.add(indoorLight);
      _currentMapLights.push(indoorLight);  // ★ 리셋용 트래킹
    }

    // ★ 보이지 않는 경계 벽 세우기 (모든 맵)
    //   월드 보더를 실제 벽으로 막아서 꼼수로 뚫고 나가거나 모델 밑으로 못 숨게.
    //   바닥은 만들지 않음 → 땅 감지/중력에 영향 없음(갑작스런 추락 방지).
    {
      const baseY = finalBox.min.y - 10; // 벽 아래쪽 시작(넉넉히 아래)
      buildBoundaryCage(worldBounds, baseY, 60);
    }

    // 스폰 찾기 (지붕 위 스폰 방지 - 머리 위 최소 3유닛 여유 필요)
    if (selectedMap.forceSpawnCenter) {
      // 중앙 위에서 아래로 레이캐스트 → 낮은 층 중 머리 공간 충분한 첫 번째 바닥
      const csray = new THREE.Raycaster();
      csray.set(new THREE.Vector3(center.x, 500, center.z), new THREE.Vector3(0,-1,0));
      csray.far = 1000;
      const chits = csray.intersectObjects(collidableMeshes, false);
      let spawnY = 5;
      const chitsAsc = [...chits].sort((a,b) => a.point.y - b.point.y);
      const upray2 = new THREE.Raycaster();
      for (const h of chitsAsc) {
        // 바닥 법선 위쪽인 면만 허용 (천장 제외)
        if (h.face && h.face.normal.y < 0.5) continue;
        const ty = h.point.y;
        upray2.set(new THREE.Vector3(center.x, ty + 0.3, center.z), new THREE.Vector3(0,1,0));
        upray2.far = 30;
        const uh = upray2.intersectObjects(collidableMeshes, false);
        const clearance = uh.length ? uh[0].distance : 999;
        if (clearance >= 2.2) { spawnY = ty + 0.02; break; }
      }
      player.position.set(center.x, spawnY + (selectedMap.spawnOffsetY || 0), center.z);
    } else {
    const spawnCandidates = [];
    const R = Math.min(halfX, halfZ) * 0.6;
    for (let dx=-R; dx<=R; dx+=2.5) for (let dz=-R; dz<=R; dz+=2.5) spawnCandidates.push([center.x+dx, center.z+dz]);
    const sray = new THREE.Raycaster();
    const upray = new THREE.Raycaster();
    let best = null, bestScore = -Infinity;
    for (const [sx, sz] of spawnCandidates) {
      sray.set(new THREE.Vector3(sx, 500, sz), new THREE.Vector3(0,-1,0));
      sray.far = 1000;
      const hits = sray.intersectObjects(collidableMeshes, false);
      if (!hits.length) continue;
      // ★ 핵심 수정: Y 오름차순(낮은 층 먼저) 정렬 후, 머리 위 공간 충분한 첫 번째 바닥 선택
      // 가장 위 hit(=지붕)를 바닥으로 착각하는 문제 해결
      const sorted = [...hits].sort((a, b) => a.point.y - b.point.y);
      for (const h of sorted) {
        const ty = h.point.y;
        // 바닥 법선이 위쪽(Y>0.5)인 면만 "바닥"으로 인정 → 천장/벽 제외
        if (h.face && h.face.normal.y < 0.5) continue;
        upray.set(new THREE.Vector3(sx, ty + 0.3, sz), new THREE.Vector3(0,1,0));
        upray.far = 30;
        const uphits = upray.intersectObjects(collidableMeshes, false);
        const clear = uphits.length ? uphits[0].distance : 999;
        if (clear < 2.2) continue; // 머리 공간 최소 2.2m
        // 낮은 층 우선(score 높을수록 좋음), 여유 공간 보너스
        const score = -ty + clear * 0.05;
        if (score > bestScore) { bestScore = score; best = {x:sx, y:ty+0.02, z:sz}; }
        break; // 이 후보 좌표에서 첫 번째 유효 바닥 찾으면 다음 후보로
      }
    }
    if (best) player.position.set(best.x, best.y + (selectedMap.spawnOffsetY || 0), best.z);
    else player.position.set(center.x, 20 + (selectedMap.spawnOffsetY || 0), center.z);
    }
    velocityY = 0; isGrounded = true;
    cachedGroundY = null; _lastSolidGroundY = null; _groundDropStreak = 0; // 새 맵 바닥 기억 초기화
    _lastSafePos = null; // ★ 새 맵 → 안전 위치 초기화 (다음 프레임에 스폰이 자동 저장됨)

    document.getElementById('barFill').style.width = '100%';
    document.getElementById('pct').textContent = '100%';
    const t = document.getElementById('loadStat');
    if (t) t.textContent = '로드 완료!';
    setTimeout(() => document.getElementById('loading').classList.add('hidden'), 300);
  },
  xhr => {
    if (xhr.total && xhr.total > 0) {
      const p = Math.min(99, Math.round(xhr.loaded / xhr.total * 100));
      loadProgress.tokyo = p; updateLoadingText();
      document.getElementById('barFill').style.width = p + '%';
      document.getElementById('pct').textContent = p + '%';
    } else {
      // Content-Length 없는 CDN → 바이트 기반 표시
      const mb = (xhr.loaded / 1024 / 1024).toFixed(1);
      const t = document.getElementById('loadStat');
      if (t) t.textContent = `맵 다운로드 중... ${mb} MB`;
      // 바가 무한히 차오르는 느낌 (실제 진행률 모름)
      const fakeP = Math.min(90, (xhr.loaded / (30 * 1024 * 1024)) * 90);
      document.getElementById('barFill').style.width = fakeP + '%';
      document.getElementById('pct').textContent = `${mb} MB`;
    }
  },
  err => console.error('Tokyo 로드 실패:', err)
);
} // loadSelectedMap 끝

// ================ Controls ================
const keys = {};
addEventListener('keydown', e => keys[e.code] = true);
addEventListener('keyup', e => keys[e.code] = false);

let cameraYaw = Math.PI, cameraPitch = 0.15;
let pointerLocked = false, paintMode = false;

// ★ 포인터락 헬퍼 — OS 마우스 가속으로 인한 movementX/Y 폭주 방지
//   unadjustedMovement:true = 브라우저가 OS 가속 무시하고 raw 델타만 전달
//   → 이게 "값이 미친듯이 튀는" 회전목마 버그의 진짜 해결책
//   지원 안 하는 브라우저/실패 시 일반 락으로 자동 폴백 (돌다 멈춤 방지)
function lockPointer() {
  const el = renderer.domElement;
  if (document.pointerLockElement === el) return;
  // unadjustedMovement 는 일부 마우스에서 특정 축 값이 0으로 죽는 버그가 있어 사용 안 함.
  // 값 폭주는 mousemove 핸들러에서 부드럽게 제한.
  try { el.requestPointerLock(); } catch(e) {}
}

// ============================================================
// 로비/방/투표/뽑기 시스템
// ============================================================

let myRoomId = null;
let currentScreen = 'nick';
let roomListUnsub = null;
let roomUnsub = null;
// voteTimerInterval 제거 - Firebase 로 대체

function showScreen(name) {
  currentScreen = name;
  // CSS specificity 우회: inline style 로 직접 강제
  document.querySelectorAll('.screen').forEach(s => {
    s.classList.add('hidden');
    s.style.display = 'none';
  });
  const el = document.getElementById('scr-' + name);
  if (el) {
    el.classList.remove('hidden');
    el.style.display = 'flex';
  }
}

// ============ 코인(코인) 시스템 + 세션 저장 ============
const STORAGE_NICK = 'wc_nick_v1';
const STORAGE_COIN = 'wc_coin_v1';
const STORAGE_POSES = 'wc_owned_poses_v1';
const STORAGE_TINT = 'wc_body_tint_v1';

function saveNick(n) { try { localStorage.setItem(STORAGE_NICK, n); } catch(e){} }
function loadNick() { try { return localStorage.getItem(STORAGE_NICK) || ''; } catch(e){ return ''; } }
function getCoins() { try { return parseInt(localStorage.getItem(STORAGE_COIN) || '0', 10) || 0; } catch(e){ return 0; } }
function addCoins(n) {
  const c = getCoins() + n;
  try { localStorage.setItem(STORAGE_COIN, String(c)); } catch(e){}
  updateHomeCoinDisplay();
  return c;
}
document.addEventListener('DOMContentLoaded', () => {
  const sh = document.getElementById('nickShuffle');
  if (sh) {
    const parts = ['시그마','로디','쿠키','치즈','메이플','솜사탕','피클','바닐라','네온','핑크','도토리','토마토'];
    const tails = ['보이','걸','맨','냥','호빵','도리','키드','대장'];
    sh.addEventListener('click', () => {
      const input = document.getElementById('nickInput');
      if (!input) return;
      const n = parts[Math.floor(Math.random()*parts.length)] + tails[Math.floor(Math.random()*tails.length)];
      input.value = n;
      input.focus();
    });
  }
});
function updateHomeCoinDisplay() {
  const el = document.getElementById('homeCoinCount');
  if (el) el.textContent = getCoins();
}
function getOwnedPoses() {
  try {
    const raw = localStorage.getItem(STORAGE_POSES);
    if (!raw) return ['stand', 'crouch'];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return ['stand', 'crouch'];
    if (!arr.includes('stand')) arr.push('stand');
    if (!arr.includes('crouch')) arr.push('crouch');
    return arr;
  } catch(e){ return ['stand', 'crouch']; }
}
function ownPose(id) {
  const owned = getOwnedPoses();
  if (!owned.includes(id)) owned.push(id);
  try { localStorage.setItem(STORAGE_POSES, JSON.stringify(owned)); } catch(e){}
}
function isPoseOwned(id) { return getOwnedPoses().includes(id); }

function saveBodyTint(hex) { try { localStorage.setItem(STORAGE_TINT, hex); } catch(e){} }
function loadBodyTint() { try { return localStorage.getItem(STORAGE_TINT) || null; } catch(e){ return null; } }

// 1단계: 닉네임 입력 완료 → 방 목록으로
document.getElementById('nickNext').addEventListener('click', () => {
  try {
    const rawNick = document.getElementById('nickInput').value.trim();
    const cleaned = (typeof sanitizeNick === 'function') ? sanitizeNick(rawNick, 16) : rawNick.replace(/[^\p{L}\p{N}_\-]/gu,'').slice(0,16);
    myNick = cleaned || '익명' + Math.floor(Math.random()*100);
    try { localStorage.setItem('wc_nick_v1', myNick); } catch(e){}
    if (typeof showScreen === 'function') {
      showScreen('rooms');
    } else {
      document.querySelectorAll('.screen').forEach(s => { s.classList.add('hidden'); s.style.setProperty('display','none','important'); });
      const r = document.getElementById('scr-rooms');
      if (r) { r.classList.remove('hidden'); r.style.setProperty('display','flex','important'); }
    }
    if (typeof subscribeRoomList === 'function') subscribeRoomList();
  } catch (err) {
    window.__nickErr = { m: err.message, s: err.stack };
    console.warn('nickNext handler error:', err);
    alert('오류: ' + err.message);
  }
});
document.getElementById('nickInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('nickNext').click();
});

// 홈 화면 버튼들
document.getElementById('homePlayBtn').addEventListener('click', () => {
  showScreen('rooms');
  subscribeRoomList();
});
document.getElementById('changeNickBtn').addEventListener('click', () => {
  try { localStorage.removeItem(STORAGE_NICK); } catch(e){}
  showScreen('nick');
  const inp = document.getElementById('nickInput');
  if (inp) { inp.value = myNick || ''; inp.focus(); }
});
function __goHome() {
  try { if (typeof roomListUnsub === 'function') roomListUnsub(); } catch(e){}
  try { roomListUnsub = null; } catch(e){}
  document.querySelectorAll('.screen').forEach(s => {
    s.classList.add('hidden');
    s.style.setProperty('display','none','important');
  });
  const el = document.getElementById('scr-nick');
  if (el) {
    el.classList.remove('hidden');
    el.style.setProperty('display','flex','important');
  }
  try { currentScreen = 'nick'; } catch(e){}
  const inp = document.getElementById('nickInput');
  if (inp) { try { inp.value = (typeof myNick === 'string' ? myNick : '') || ''; } catch(e){} inp.focus(); }
  console.log('[goHome] → nick');
}
window.__goHome = __goHome;
document.getElementById('roomsBackBtn').addEventListener('click', (ev) => {
  ev.preventDefault(); ev.stopPropagation();
  __goHome();
});
document.addEventListener('click', (ev) => {
  const t = ev.target.closest && ev.target.closest('#roomsBackBtn');
  if (t) { ev.preventDefault(); ev.stopPropagation(); __goHome(); }
}, true);
document.getElementById('homeClosetBtn').addEventListener('click', openCloset);
document.getElementById('homePoseBtn').addEventListener('click', openPoseShop);

// ============ 홈 3D 캐릭터 프리뷰 ============
// ★ 홈 캐릭터 미리보기 — 메인 renderer 재활용 (별도 WebGL 컨텍스트 생성 안 함)
//   렌더 타겟 → CPU 픽셀 읽기 → canvas 2D putImageData 방식
let _homeRT = null;       // WebGLRenderTarget (lazy)
let _homeRTW = 0, _homeRTH = 0;  // 현재 RT 크기 (리사이즈 감지용)
let _homePixBuf = null;   // ★ 재사용 픽셀 버퍼 (매 프레임 alloc 방지)
let _homeScene = null, _homeCamera = null, _homeObj = null;
let _homeDrag = { active:false, lastX:0, rotY:0 };
// homeCharCanvas 자체는 2D canvas 로만 사용 (WebGL context 부여 안 함)

function initHomeCharPreview() {
  const canvas = document.getElementById('homeCharCanvas');
  if (!canvas) return;
  const box = canvas.getBoundingClientRect();
  const w = Math.max(200, box.width|0), h = Math.max(200, box.height|0);
  if (!_homeScene) {
    _homeScene = new THREE.Scene();
    _homeScene.background = null;
    _homeScene.add(new THREE.AmbientLight(0xffffff, 1.0));
    const dl = new THREE.DirectionalLight(0xfff2d0, 1.4);
    dl.position.set(1, 2, 1.5); _homeScene.add(dl);
    const fl = new THREE.DirectionalLight(0x9fb8d8, 0.4);
    fl.position.set(-1, 1, -1); _homeScene.add(fl);
    _homeCamera = new THREE.PerspectiveCamera(30, 1, 0.1, 20);
    _homeCamera.position.set(0, 1.15, 4.5);
    _homeCamera.lookAt(0, 0.95, 0);
    // 드래그 회전
    canvas.addEventListener('pointerdown', e => {
      _homeDrag.active = true; _homeDrag.lastX = e.clientX;
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointerup', e => {
      _homeDrag.active = false;
      try { canvas.releasePointerCapture(e.pointerId); } catch(err){}
    });
    canvas.addEventListener('pointermove', e => {
      if (!_homeDrag.active) return;
      const dx = e.clientX - _homeDrag.lastX;
      _homeDrag.lastX = e.clientX;
      _homeDrag.rotY += dx * 0.01;
    });
    canvas.addEventListener('click', e => {
      if (!closetOpen || !_selectedColor || !_homeObj) return;
      const rect = canvas.getBoundingClientRect();
      const nx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      const ny = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      const rc2 = new THREE.Raycaster();
      rc2.setFromCamera({ x: nx, y: ny }, _homeCamera);
      const hits = rc2.intersectObject(_homeObj, true);
      if (hits.length && hits[0].object.material) {
        hits[0].object.material.color.set(_selectedColor);
        saveBodyTint(_selectedColor);
      }
    });
  }
  // 캔버스 크기 동기화
  canvas.width = w; canvas.height = h;
  _homeCamera.aspect = w / h;
  _homeCamera.updateProjectionMatrix();
  loadHomeCharObject();
}
function loadHomeCharObject() {
  if (!poseModels.stand) {
    // 아직 로딩 중이면 잠시 후 재시도
    setTimeout(loadHomeCharObject, 400);
    return;
  }
  if (_homeObj) { _homeScene.remove(_homeObj); _homeObj = null; }
  const cloned = poseModels.stand.clone(true);
  cloned.traverse(o => {
    if (o.isMesh) {
      o.frustumCulled = false;
      if (o.material) o.material = o.material.clone(); // 프리뷰 색 독립
    }
  });
  // 저장된 색 적용
  const tint = loadBodyTint();
  if (tint) {
    cloned.traverse(o => { if (o.isMesh && o.material?.color) o.material.color.set(tint); });
  }
  _homeScene.add(cloned);
  _homeObj = cloned;
}
let _homePreviewLast = 0;
function renderHomePreview() {
  if (currentScreen !== 'home' || !_homeScene || !_homeObj) return;
  // ★ 성능: 60ms(~16fps) 쓰로틀 — readRenderTargetPixels GPU stall 매 프레임 방지
  const now = performance.now();
  if (now - _homePreviewLast < 60) return;
  _homePreviewLast = now;
  const canvas = document.getElementById('homeCharCanvas');
  if (!canvas) return;
  const w = canvas.width || 200, h = canvas.height || 200;
  if (!_homeRT || _homeRTW !== w || _homeRTH !== h) {
    if (_homeRT) _homeRT.dispose();
    _homeRT = new THREE.WebGLRenderTarget(w, h, {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      samples: 0
    });
    _homeRTW = w; _homeRTH = h;
    _homePixBuf = new Uint8Array(w * h * 4);
  }
  _homeObj.rotation.y = _homeDrag.rotY + now * 0.0003;
  const prevTarget = renderer.getRenderTarget();
  renderer.setRenderTarget(_homeRT);
  renderer.setClearColor(0x000000, 0);
  renderer.clear();
  renderer.render(_homeScene, _homeCamera);
  renderer.readRenderTargetPixels(_homeRT, 0, 0, w, h, _homePixBuf);
  renderer.setRenderTarget(prevTarget);
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const id = ctx.createImageData(w, h);
    for (let row = 0; row < h; row++) {
      const src = (h - 1 - row) * w * 4;
      const dst = row * w * 4;
      id.data.set(_homePixBuf.subarray(src, src + w * 4), dst);
    }
    ctx.putImageData(id, 0, 0);
  }
}

// ============ 옷장 (색 칠하기) ============
let closetOpen = false;
let _selectedColor = null;
const PALETTE = [
  '#ff5757', '#ff8c42', '#ffcf3c', '#7ee06a', '#4bc0e0', '#7b8cff',
  '#b872ff', '#ff72c6', '#ffffff', '#8a8a8a', '#3a3a3a', '#5a3a1e'
];
function openCloset() {
  closetOpen = true;
  const overlay = document.getElementById('closetOverlay');
  overlay.classList.remove('hidden');
  const pal = document.getElementById('closetPalette');
  pal.innerHTML = '';
  PALETTE.forEach(hex => {
    const sw = document.createElement('div');
    sw.className = 'palette-swatch';
    sw.style.background = hex;
    sw.addEventListener('click', () => {
      _selectedColor = hex;
      pal.querySelectorAll('.palette-swatch').forEach(s => s.classList.toggle('active', s === sw));
    });
    pal.appendChild(sw);
  });
}
function closeCloset() {
  closetOpen = false;
  _selectedColor = null;
  document.getElementById('closetOverlay').classList.add('hidden');
}
document.getElementById('closetCloseBtn').addEventListener('click', closeCloset);
document.getElementById('closetResetBtn').addEventListener('click', () => {
  try { localStorage.removeItem(STORAGE_TINT); } catch(e){}
  loadHomeCharObject();
});

// ============ 포즈 상점 ============
// 각 포즈에 cost 정의. stand/crouch 는 기본 무료.
const POSE_COSTS = {
  stand: 0,
  crouch: 0,
  // 예: lie: 200, dance: 500 — 나중에 추가
};
function openPoseShop() {
  const overlay = document.getElementById('poseShopOverlay');
  overlay.classList.remove('hidden');
  const list = document.getElementById('poseShopList');
  list.innerHTML = '';
  const owned = getOwnedPoses();
  const coins = getCoins();
  POSE_LIST.forEach(id => {
    const cost = POSE_COSTS[id] ?? 100;
    const displayName = POSE_DISPLAY[id]?.name || id;
    const isOwned = owned.includes(id);
    const canBuy = !isOwned && coins >= cost;
    const card = document.createElement('div');
    card.className = 'pose-shop-card ' + (isOwned ? 'owned' : 'locked');
    card.innerHTML = `
      <div class="psc-icon">${isOwned ? '✅' : '🔒'}</div>
      <div class="psc-name">${displayName}</div>
      <div class="psc-price">${isOwned ? '보유중' : ('💰 ' + cost)}</div>
    `;
    const btn = document.createElement('button');
    if (isOwned) {
      btn.className = 'btn-owned'; btn.textContent = '이미 보유';
    } else if (canBuy) {
      btn.className = 'btn-buy'; btn.textContent = '구매';
      btn.addEventListener('click', () => {
        addCoins(-cost);
        ownPose(id);
        openPoseShop();
      });
    } else {
      btn.className = 'btn-poor'; btn.textContent = '코인 부족';
    }
    card.appendChild(btn);
    list.appendChild(card);
  });
}
document.getElementById('poseShopCloseBtn').addEventListener('click', () => {
  document.getElementById('poseShopOverlay').classList.add('hidden');
});

// 코인 획득 알림 (스코어보드에서 잠깐 뜸)
function showCoinEarned(amount) {
  const toast = document.createElement('div');
  toast.textContent = '💰 +' + amount + ' 코인 획득을 하다!';
  toast.style.cssText = `
    position:fixed; top:50%; left:50%; transform:translate(-50%, -50%);
    background:linear-gradient(135deg, #ffcf3c, #ff9838);
    color:#000; font-family:'Nunito',sans-serif;
    font-weight:900; font-size:22px; padding:16px 28px;
    border-radius:20px; z-index:1000;
    box-shadow:0 0 40px rgba(255,207,60,0.7), 0 8px 30px rgba(0,0,0,0.4);
    animation: coinToast 3s ease-out forwards;
    pointer-events:none;
  `;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}
// coinToast keyframes 동적 삽입
(() => {
  const st = document.createElement('style');
  st.textContent = `@keyframes coinToast {
    0% { transform:translate(-50%, -80%) scale(0.6); opacity:0; }
    15% { transform:translate(-50%, -50%) scale(1.1); opacity:1; }
    30% { transform:translate(-50%, -50%) scale(1); opacity:1; }
    100% { transform:translate(-50%, -30%) scale(0.9); opacity:0; }
  }`;
  document.head.appendChild(st);
})();



// ============ 방 목록 ============
function subscribeRoomList() {
  const roomsRef = ref(fbDb, 'rooms');
  if (roomListUnsub) roomListUnsub();
  let _rlThrottle = 0;
  roomListUnsub = onValue(roomsRef, snap => {
    const now2 = Date.now();
    if (now2 - _rlThrottle < 150) return;
    _rlThrottle = now2;
    const data = snap.val() || {};
    const list = document.getElementById('roomList');
    const roomEntries = Object.entries(data).filter(([id, r]) => r && r.name);
    if (roomEntries.length === 0) {
      if (list.dataset._empty !== '1') {
        list.innerHTML = '<div class="empty-rooms">방이 없음. 만들어봐 ↓</div>';
        list.dataset._empty = '1';
      }
      return;
    }
    list.dataset._empty = '0';
    // 이전에 empty 상태로 남은 안내 div 제거
    Array.from(list.children).forEach(c => {
      if (!c.dataset._k) c.remove();
    });
    diffRender(
      list,
      roomEntries,
      ([id]) => id,
      ([id, room]) => {
        const div = document.createElement('div');
        div.className = 'room-item';
        div.innerHTML = `
          <div>
            <div class="info"></div>
            <div class="count"></div>
          </div>
          <div class="state"></div>
        `;
        div.addEventListener('click', () => joinRoom(id));
        return div;
      },
      (el, [id, room]) => {
        const count = Object.keys(room.players || {}).length;
        const state = room.state || 'lobby';
        const info = el.querySelector('.info');
        const cnt = el.querySelector('.count');
        const st  = el.querySelector('.state');
        const infoTxt = room.name;
        const cntTxt  = `👥 ${count}/25`;
        const stTxt   = state === 'playing' ? '게임 중' : '대기';
        if (info.textContent !== infoTxt) info.textContent = infoTxt;
        if (cnt.textContent !== cntTxt) cnt.textContent = cntTxt;
        if (st.textContent !== stTxt) st.textContent = stTxt;
        const wantPlaying = state === 'playing';
        if (st.classList.contains('playing') !== wantPlaying) {
          st.classList.toggle('playing', wantPlaying);
        }
      }
    );
  });
}

// 방 만들기
let _lastRoomCreateTime = 0;
document.getElementById('createRoomBtn').addEventListener('click', async () => {
  if (!myUid) { alert('로그인 대기중...'); return; }
  // 방 도배 방지: 15초 쿨다운
  const now = Date.now();
  if (now - _lastRoomCreateTime < 15000) {
    alert('방은 15초에 1개만 만들 수 있어요'); return;
  }
  // 이미 내가 호스트인 방이 있으면 차단
  const existSnap = await get(ref(fbDb, 'rooms'));
  const existData = existSnap.val() || {};
  const myHostedRoom = Object.values(existData).find(r => r && r.hostUid === myUid);
  if (myHostedRoom) { alert('이미 내가 만든 방이 있어요!'); return; }
  const rawName = document.getElementById('newRoomName').value.trim() || (myNick + '의 방');
  const name = sanitizeNick(rawName, 20);
  _lastRoomCreateTime = now;
  const roomsRef = ref(fbDb, 'rooms');
  const newRoom = push(roomsRef);
  await set(newRoom, {
    name: name,
    hostUid: myUid,
    state: 'lobby',
    countdownEndAt: null,
    createdAt: Date.now()
  });
  console.log('✅ 방 생성:', newRoom.key, '방장=', myUid);
  await set(ref(fbDb, `rooms/${newRoom.key}/players/${myUid}`), {
    nick: myNick, joinedAt: Date.now()
  });
  myRoomId = newRoom.key;
  onDisconnect(ref(fbDb, `rooms/${newRoom.key}/players/${myUid}`)).remove();
  enterRoom(newRoom.key);
});

// 방 입장
let _joiningRoom = false;
async function joinRoom(roomId) {
  if (_joiningRoom) return; // 중복 입장 방지
  if (!roomId || typeof roomId !== 'string') return;
  _joiningRoom = true;
  try {
  const roomSnap = await get(ref(fbDb, `rooms/${roomId}`));
  const room = roomSnap.val();
  if (!room) { alert('방이 없음'); _joiningRoom = false; return; }
  const count = Object.keys(room.players || {}).length;
  if (count >= 25) { alert('방이 꽉 참'); _joiningRoom = false; return; }
  if (room.state === 'playing') { alert('이미 게임 중'); _joiningRoom = false; return; }
  if (room.state === 'ended') { alert('라운드 종료 중. 잠시 후 입장하세요'); _joiningRoom = false; return; }
  // 이미 방에 들어가 있으면 차단
  if (myRoomId) { alert('이미 방에 있어요'); _joiningRoom = false; return; }
  await set(ref(fbDb, `rooms/${roomId}/players/${myUid}`), {
    nick: myNick, joinedAt: Date.now()
  });
  myRoomId = roomId;
  onDisconnect(ref(fbDb, `rooms/${roomId}/players/${myUid}`)).remove();
  console.log('🚪 방 입장:', roomId, '내 UID=', myUid);
  enterRoom(roomId);
  } catch(e) { console.error('방 입장 오류:', e); }
  finally { _joiningRoom = false; }
}

function enterRoom(roomId) {
  if (roomListUnsub) { roomListUnsub(); roomListUnsub = null; }
  showScreen('lobby');
  subscribeRoom(roomId);
  initChat();
}

// ============ 로비 (방 안) ============
function subscribeRoom(roomId) {
  myRoomId = roomId;
  const roomRef = ref(fbDb, `rooms/${roomId}`);
  if (roomUnsub) roomUnsub();
  let _nullHits = 0;
  let _roomThrottle = 0;
  let _lastKnownState = null; // ★ state 전환 감지용
  roomUnsub = onValue(roomRef, snap => {
    const room = snap.val();
    _cachedRoom = room; // ★ 캐시는 항상 최신값으로 (스로틀 무관)
    if (!room) {
      // 순간적 null (Firebase 쓰기 사이 race) 방어 - 연속 2번이어야 진짜 방 없음
      _nullHits++;
      if (_nullHits < 2) return;
      if (roomUnsub) { roomUnsub(); roomUnsub = null; }
      leaveToRooms();
      return;
    }
    _nullHits = 0;
    // ★ state 전환 감지: lobby→voting 진입 시 내 vote/modeVote 리셋 (rules.md: 본인만 자기 것 쓰기 가능)
    if (_lastKnownState !== 'voting' && room.state === 'voting' && myUid) {
      update(ref(fbDb, `rooms/${myRoomId}/players/${myUid}`), { vote: null, modeVote: null })
        .catch(e => console.warn('vote reset:', e.code));
    }
    _lastKnownState = room.state;
    // ★ 최적화: 위치 업데이트마다도 이 콜백 발동 → 8명 방이면 초 80회.
    //   중요 상태(감염)는 즉시 처리, DOM/UI 재렌더는 100ms 스로틀.
    // 감염 모드: 내가 방금 감염됐다면 즉시 술래로 전환 (스로틀 밖에서 처리)
    if (room.state === 'playing' && room.gameMode === 'infection'
        && myRole === 'hider' && isSeekerUid(myUid, room)) {
      console.log('☣️ 내가 감염됨 → 술래로 전환');
      setRole('seeker');
      // 역할 태그 UI 갱신
      const rt = document.getElementById('roleTag');
      if (rt) { rt.textContent = '☣️ 감염됨!'; rt.classList.add('seeker'); }
      const sh = document.getElementById('hudShootHint');
      if (sh) sh.style.display = 'inline';
      // 화면 중앙에 감염 팝업
      showInfectionPopup();
    }
    // ★ 나머지 무거운 DOM 처리는 150ms 스로틀
    const _now = performance.now();
    if (_now - _roomThrottle < 150) return;
    _roomThrottle = _now;
    // 다른 사람 감염 상태 변화 → 총 부착 갱신
    refreshOtherSeekerGuns();
    // 게임 상태에 따라 닉/따봉 라벨 표시/숨김
    updateNickLikeLabels(room);
    // 내 잡은 수 HUD 갱신
    const myCatchEl = document.getElementById('myCatchCount');
    if (myCatchEl) myCatchEl.textContent = (room.catches?.[myUid]) || 0;
    const players = room.players || {};
    const uids = Object.keys(players);
    const count = uids.length;
    
    document.getElementById('lobbyName').textContent = room.name;
    document.getElementById('lobbyPlayerCount').textContent = count;
    
    // playing 아니면 hidePhase 오버레이 무조건 숨김
    if (room.state !== 'playing') {
      const ov = document.getElementById('hidePhaseOverlay');
      if (ov) ov.classList.add('hidden');
      inHidePhase = false;
    }
    
    // 플레이어 목록
    const box = document.getElementById('lobbyPlayers');
    diffRender(
      box,
      uids.map(uid => ({ uid, p: players[uid] })),
      it => it.uid,
      it => {
        const row = document.createElement('div');
        row.className = 'player-row';
        row.innerHTML = `
          <div class="p-name">
            <div class="p-avatar"><span style="font-size:14px;"></span></div>
            <span class="_nick"></span><span class="_me"></span>
          </div>
          <span class="host" style="display:none;">방장</span>
        `;
        return row;
      },
      (el, it) => {
        const p = it.p;
        const nick = p.nick || '?';
        const letter = nick[0].toUpperCase();
        const av = el.querySelector('.p-avatar span');
        const nk = el.querySelector('._nick');
        const me = el.querySelector('._me');
        const hs = el.querySelector('.host');
        if (av.textContent !== letter) av.textContent = letter;
        if (nk.textContent !== nick) nk.textContent = nick;
        const meTxt = it.uid === myUid ? ' (나)' : '';
        if (me.textContent !== meTxt) {
          me.textContent = meTxt;
          me.style.cssText = it.uid === myUid ? 'color:var(--text-dim);font-size:12px;' : '';
        }
        const isHost = it.uid === room.hostUid;
        hs.style.display = isHost ? '' : 'none';
      }
    );
    
    // 상태별 화면 전환
    if (room.state === 'voting') {
      if (currentScreen !== 'vote') startVotingUI(room);
      else updateVotePhaseUI(room);
      const timerEl = document.getElementById('voteTimer');
      if (timerEl) timerEl.textContent = '남은 시간: ' + (room.voteCountdown != null ? room.voteCountdown : 15) + '초';
    } else if (room.state === 'drawing' && currentScreen !== 'draw') {
      startDrawingUI(room);
    } else if (room.state === 'playing' && currentScreen !== 'game' && currentScreen !== 'result') {
      startGame(room);
    } else if (room.state === 'ended' && currentScreen === 'game' && !window._endSeqStarted) {
      // ★ 라운드 종료 시퀀스: 15초 빨간 깜빡임 유지 → 3초 페이드 → 스코어보드
      window._endSeqStarted = true;
      console.log('🏁 라운드 종료 → 15초 감상 후 페이드');
      // 15초 대기 (빨간 깜빡임은 이미 animate 루프에서 알아서 진행됨)
      setTimeout(() => {
        // 페이드 인 (3초 검은색)
        const fade = document.getElementById('endFadeOverlay');
        if (fade) {
          fade.style.opacity = '1';
        }
        // 페이드 완료 후 스코어보드 → 페이드 리셋
        setTimeout(() => {
          showScoreboard();
          if (fade) {
            fade.style.transition = 'none';
            fade.style.opacity = '0';
            // 다음 라운드용 flag 리셋
            setTimeout(() => {
              fade.style.transition = 'opacity 3s ease-in';
              window._endSeqStarted = false;
            }, 100);
          }
        }, 3000);
      }, 15000);
    }
    
    updateCountdownDisplay(room);
    // 게임 중일 때 roundCountdown 타이머 표시
    if (room.state === 'playing' || room.state === 'ended') {
      updateRoundTimer(room);
    }
    // 숨는 시간 오버레이 갱신 (원래 안 불려서 15초 대기가 UI에 안 나타남)
    updateHidePhase(room);
    // 게임 중 플레이어 목록 갱신
    updatePlayerListHUD();
    // 술래 바뀌었을 때 다른 플레이어들 총 상태 재정렬
    refreshOtherSeekerGuns();
  });
}

function uid_is_host(room) { return room.hostUid === myUid; }

let countdownTimer = null;
// manageCountdown - 방장 tick 이 대신 관리

// 새 플레이어 입장 감지 → 카운트다운 3초 추가 (방장만)
let lastPlayerCount = 0;
function updateCountdownDisplay(room) {
  const el = document.getElementById('lobbyCountdown');
  const count = Object.keys(room.players || {}).length;
  // 시작 버튼 표시 관리 (방장 + lobby 상태 + 미시작)
  const startBtn = document.getElementById('startGameBtn');
  if (startBtn) {
    const isHost = room.hostUid === myUid;
    const canShow = isHost && room.state === 'lobby' && !room.startRequested;
    startBtn.style.display = canShow ? '' : 'none';
    startBtn.disabled = count < 2;
    startBtn.textContent = count < 2 ? '👥 2명 이상 필요' : '🎮 게임 시작';
    startBtn.style.opacity = count < 2 ? '0.5' : '1';
  }
  // Firebase 값 그대로 표시 (방장이 매초 감소시킴)
  if (room.countdown == null) {
    if (count < 2) {
      el.textContent = '최소 2명 필요';
    } else if (!room.startRequested) {
      el.textContent = room.hostUid === myUid ? '시작 버튼을 눌러줘' : '방장이 시작하기를 기다리는 중...';
    } else {
      el.textContent = '';
    }
    el.style.fontSize = '20px';
    el.style.color = '#ffca28';
    return;
  }
  el.style.fontSize = '48px';
  if (room.countdown === 0) {
    el.textContent = '시작!';
    el.style.color = '#4dd07a';
  } else {
    el.textContent = String(room.countdown);
    el.style.color = '#ffca28';
  }
}

// 방 나가기
let _leavingRoom = false;
document.getElementById('leaveRoomBtn').addEventListener('click', leaveToRooms);
async function leaveToRooms() {
  unsubscribeChat();
  unsubscribeSplats();
  if (_leavingRoom) return;
  _leavingRoom = true;
  // 게임 중 이탈 시 로컬 상태 강제 리셋
  currentScreen = 'leaving';
  syncStarted = false;
  myAlive = true;
  myRole = 'hider';
  roundState = { phase: 'idle', startedAt: 0, endsAt: 0 };
  inHidePhase = false;
  window._endSeqStarted = false;
  if (scoreTimer) { clearInterval(scoreTimer); scoreTimer = null; }
  resetMap();  // ★ 방 나갈 때도 맵 리셋
  if (roomUnsub) { roomUnsub(); roomUnsub = null; }
  _cachedRoom = null;
  if (myRoomId && myUid) {
    await remove(ref(fbDb, `rooms/${myRoomId}/players/${myUid}`)).catch(()=>{});
    // 방장이었으면 방장 이양 (다른 사람 있으면)
    const roomSnap = await get(ref(fbDb, `rooms/${myRoomId}`));
    const room = roomSnap.val();
    if (room) {
      const others = Object.keys(room.players || {}).filter(u => u !== myUid);
      if (room.hostUid === myUid && others.length > 0) {
        // ★ 방장 이양 시도 → rules.md 에 hostUid write 룰 없으면 실패
        //   fallback: 이양 실패 시 방을 아예 삭제 (좀비 방 방지)
        try {
          await update(ref(fbDb, `rooms/${myRoomId}`), { hostUid: others[0] });
        } catch(e) {
          console.warn('방장 이양 실패 (rules.md 확인 필요) → 방 삭제:', e.code);
          await remove(ref(fbDb, `rooms/${myRoomId}`)).catch(()=>{});
        }
      } else if (others.length === 0 || room.hostUid === myUid) {
        await remove(ref(fbDb, `rooms/${myRoomId}`)).catch(()=>{});
      }
    }
  }
  myRoomId = null;
  if (roomUnsub) { roomUnsub(); roomUnsub = null; }
  if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
  closeChat();
  const catchEl = document.getElementById('myCatchCount');
  if (catchEl) catchEl.textContent = 0;
  _leavingRoom = false;
  showScreen('rooms');
  subscribeRoomList();
}

// ============ 투표 ============
let _lastVoteTime = 0;
const VOTE_COOLDOWN = 1500; // 1.5초 쿨다운 (연속 스팸 방지)
function startVotingUI(room) {
  showScreen('vote');
  updateVotePhaseUI(room);
}

function updateVotePhaseUI(room) {
  const phase = room?.votePhase || 'map';
  const title = document.getElementById('voteTitle');
  const mapsBox = document.getElementById('voteMaps');
  const modesBox = document.getElementById('voteModes');
  if (phase === 'map') {
    if (title) title.textContent = '맵 투표';
    if (mapsBox) mapsBox.style.display = '';
    if (modesBox) modesBox.style.display = 'none';
    renderVoteMaps(room);
  } else {
    if (title) title.textContent = '모드 투표';
    if (mapsBox) mapsBox.style.display = 'none';
    if (modesBox) modesBox.style.display = '';
    renderVoteModes(room);
  }
}

function renderVoteMaps(room) {
  const box = document.getElementById('voteMaps');
  const players = room.players || {};
  // ★ 투표 중복 방지: uid당 1표만 카운트 (각 uid의 마지막 투표만)
  const votes = {};
  const votedUids = new Set();
  Object.entries(players).forEach(([uid, p]) => {
    if (p.vote != null && !votedUids.has(uid)) {
      votedUids.add(uid);
      votes[p.vote] = (votes[p.vote] || 0) + 1;
    }
  });
  const myVote = players[myUid]?.vote;
  const MAP_ICONS = ['🏙️', '🏛️', '🛒', '🏬'];
  diffRender(
    box,
    MAPS.map((m, i) => ({ m, i })),
    it => String(it.i),
    it => {
      const d = document.createElement('div');
      d.className = 'voteMap';
      const icon = MAP_ICONS[it.i] || '🗺️';
      d.innerHTML = `
        <div class="map-icon"><span style="font-size:30px;">${icon}</span></div>
        <div class="mapName"></div>
        <div class="voteCount"></div>
      `;
      d.style.pointerEvents = 'auto';
      // ★ 이미 투표된 상태면 중복 클릭 무시
      d.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!myUid || !myRoomId) return;
        // 같은 맵 다시 클릭 → 취소 (null 로 unset)
        const cur = _cachedRoom?.players?.[myUid]?.vote;
        const isSame = String(cur) === String(it.i);
        console.log('🗳 투표 클릭:', it.i, '→', it.m.name, isSame ? '(취소)' : '');
        try {
          await update(ref(fbDb, `rooms/${myRoomId}/players/${myUid}`), {
            vote: isSame ? null : String(it.i)
          });
        } catch(err) { console.error('❌ 투표 실패:', err); }
      });
      return d;
    },
    (el, it) => {
      const name = el.querySelector('.mapName');
      const cnt = el.querySelector('.voteCount');
      if (name.textContent !== it.m.name) name.textContent = it.m.name;
      // ★ 실제 득표 수 표시 (1명=1표 보장됨)
      const voteNum = votes[String(it.i)] || 0;
      const cntTxt = voteNum + ' 표';
      if (cnt.textContent !== cntTxt) cnt.textContent = cntTxt;
      const voted = String(myVote) === String(it.i);
      if (el.classList.contains('voted') !== voted) {
        el.classList.toggle('voted', voted);
      }
    }
  );
  // 타이머
  const timerEl = document.getElementById('voteTimer');
  const t = '남은 시간: ' + (room.voteCountdown != null ? room.voteCountdown : 15) + '초';
  if (timerEl.textContent !== t) timerEl.textContent = t;
}

function renderVoteModes(room) {
  const box = document.getElementById('voteModes');
  if (!box) return;
  const players = room.players || {};
  const votes = {};
  const votedUids = new Set();
  Object.entries(players).forEach(([uid, p]) => {
    if (p.modeVote != null && !votedUids.has(uid)) {
      votedUids.add(uid);
      votes[p.modeVote] = (votes[p.modeVote] || 0) + 1;
    }
  });
  const myVote = players[myUid]?.modeVote;
  diffRender(
    box,
    MODES.map((m, i) => ({ m, i })),
    it => it.m.id,
    it => {
      const d = document.createElement('div');
      d.className = 'voteMap';
      d.innerHTML = `
        <div class="map-icon"><span>${it.m.icon}</span></div>
        <div class="mapName"></div>
        <div class="voteDesc"></div>
        <div class="voteCount"></div>
      `;
      d.style.pointerEvents = 'auto';
      d.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!myUid || !myRoomId) return;
        const cur = _cachedRoom?.players?.[myUid]?.modeVote;
        const isSame = cur === it.m.id;
        console.log('🗳 모드 투표:', it.m.id, isSame ? '(취소)' : '');
        try {
          await update(ref(fbDb, `rooms/${myRoomId}/players/${myUid}`), {
            modeVote: isSame ? null : it.m.id
          });
        } catch(err) { console.error('❌ 모드 투표 실패:', err); }
      });
      return d;
    },
    (el, it) => {
      const name = el.querySelector('.mapName');
      const desc = el.querySelector('.voteDesc');
      const cnt = el.querySelector('.voteCount');
      if (name.textContent !== it.m.name) name.textContent = it.m.name;
      if (desc.textContent !== it.m.desc) desc.textContent = it.m.desc;
      const voteNum = votes[it.m.id] || 0;
      const cntTxt = voteNum + ' 표';
      if (cnt.textContent !== cntTxt) cnt.textContent = cntTxt;
      const voted = myVote === it.m.id;
      if (el.classList.contains('voted') !== voted) el.classList.toggle('voted', voted);
    }
  );
}

// finishVoting 제거 - 방장 tick 이 함

// ============ 뽑기 애니메이션 ============
function startDrawingUI(room) {
  showScreen('draw');
  const spinner = document.getElementById('drawSpinner');
  spinner.innerHTML = '<div class="indicator"></div>';
  const strip = document.createElement('div');
  strip.className = 'drawStrip';
  const players = room.players || {};
  const uids = Object.keys(players);
  // 결정론적 순서 (seekerUid 를 시드로 - 모든 클라이언트 동일)
  const seed = room.seekerUid || '0';
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) & 0xffffffff;
  const rng = () => { hash = (hash * 1103515245 + 12345) & 0x7fffffff; return hash / 0x7fffffff; };
  const cycles = 6;
  const allNames = [];
  for (let c = 0; c < cycles; c++) {
    const shuffled = [...uids].sort(() => rng() - 0.5);
    shuffled.forEach(u => allNames.push({ uid: u, nick: players[u].nick }));
  }
  allNames.push({ uid: room.seekerUid, nick: players[room.seekerUid]?.nick || '?' });
  allNames.forEach(({ uid, nick }) => {
    const item = document.createElement('div');
    item.className = 'item';
    item.textContent = nick;
    if (uid === room.seekerUid) item.style.color = '#ff4757';
    strip.appendChild(item);
  });
  spinner.appendChild(strip);
  
  // 애니메이션: 마지막 아이템(술래)이 지시자 중앙에 오도록
  const itemW = 180;
  const containerW = spinner.clientWidth;
  const targetIdx = allNames.length - 1;
  const finalOffset = -(targetIdx * itemW - containerW/2 + itemW/2);
  strip.style.transform = 'translateX(0)';
  requestAnimationFrame(() => {
    strip.style.transform = `translateX(${finalOffset}px)`;
  });
  
  setTimeout(() => {
    const winner = players[room.seekerUid];
    document.getElementById('drawResult').innerHTML = 
      `<span style="color:#ff4757">🎯 ${escHtml(sanitizeNick(winner?.nick || '?', 16))}</span> 이(가) 술래!`;
  }, 3800);
  
  // 게임 시작은 방장 tick 이 자동으로 함
}

// x-ray(depthTest=false) 상태를 모두 원래대로 복원
function resetXray() {
  // 다른 플레이어
  for (const uid in otherPlayers) {
    const ot = otherPlayers[uid];
    if (!ot._meshes) continue;
    for (let i = 0; i < ot._meshes.length; i++) {
      const mat = ot._meshes[i].material;
      if (mat._xrayOn) {
        mat.depthTest = true;
        mat.depthWrite = true;
        ot._meshes[i].renderOrder = 0;
        mat._xrayOn = false;
        mat.needsUpdate = true;
      }
    }
  }
  // 내 캐릭터
  if (player._meshes) {
    for (let i = 0; i < player._meshes.length; i++) {
      const mat = player._meshes[i].material;
      if (mat._xrayOn) {
        mat.depthTest = true;
        mat.depthWrite = true;
        player._meshes[i].renderOrder = 0;
        mat._xrayOn = false;
        mat.needsUpdate = true;
      }
    }
  }
}

// ============ 게임 시작 ============
async function startGame(room) {
  currentScreen = 'game';
  // 모든 스크린 확실히 숨김 (특히 scr-nick 이 뜨는 버그 방지)
  document.querySelectorAll('.screen').forEach(s => {
    s.classList.add('hidden');
    s.style.display = 'none';
  });
  
  // 선택된 맵으로 세팅
  const mapIdx = parseInt(room.selectedMap || 0);
  loadSelectedMap(mapIdx);
  
  // 내 역할 세팅 (원조 술래 or 감염된 상태)
  if (isSeekerUid(myUid, room)) {
    setRole('seeker');
  } else {
    setRole('hider');
  }
  
  // 역할 태그 UI
  document.getElementById('roleTag').textContent = myRole === 'seeker' ? '🎯 술래' : '🦎 숨는 자';
  document.getElementById('roleTag').classList.toggle('seeker', myRole === 'seeker');
  document.getElementById('hudShootHint').style.display = myRole === 'seeker' ? 'inline' : 'none';
  // 라운드 시작 시 x-ray 복원 (이전 라운드 ended 상태 잔재 제거)
  resetXray();
  // ★ 관전 모드 리셋
  exitSpectatorMode();
  // 라운드 시작 시 stand 포즈 강제 (crouch 잔재 없애기)
  currentPose = 'stand';
  if (poseModels.stand) switchPose('stand');
  myScore = 0;
  document.getElementById('myScore').textContent = 0;
  
  // 사용자 클릭 유도 오버레이 (브라우저 정책)
  const clickOverlay = document.getElementById('gameStartClick');
  clickOverlay.classList.add('show');
  clickOverlay.style.display = 'flex';
  const clickHandler = () => {
    clickOverlay.style.display = 'none';
    clickOverlay.classList.remove('show');
    renderer.domElement.tabIndex = 0;
    renderer.domElement.focus();
    // ★ 반드시 클릭 이벤트 안에서 "즉시" 호출해야 브라우저가 락 허용
    lockPointer();
    clickOverlay.removeEventListener('click', clickHandler);
  };
  clickOverlay.addEventListener('click', clickHandler);
  // 위치 동기화 시작
  startFirebaseSync(room);
  // 라운드 리스너 + 스코어 타이머 시작
  subscribeRoundState();
  startRoundTimer();
}

document.addEventListener('pointerlockchange', () => {
  pointerLocked = document.pointerLockElement === renderer.domElement;
  window._lockChanges = (window._lockChanges || 0) + 1;
  // 게임 중 락이 풀렸으면 오버레이 다시 띄워서 재잠금 가능하게
  // (단, 채팅 인풋이 열려있거나 포즈휠이 열려있을 때는 오버레이 표시 안 함)
  if (!pointerLocked && currentScreen === 'game' && !paintMode && !chatInputOpen && !poseWheelOpen && !_paintRelockTimer) {
    const ov = document.getElementById('gameStartClick');
    if (ov) {
      ov.style.display = 'flex';
      ov.classList.add('show');
      // 라벨을 재잠금용으로 변경
      const label = ov.querySelector('.start-label');
      const sub   = ov.querySelector('.start-sub');
      if (label) label.textContent = '클릭 또는 ESC로 다시 잠금';
      if (sub) sub.textContent = '마우스 조준 재개';
      // 클릭 리스너 재설정 (중복 방지)
      if (!ov._relockBound) {
        ov._relockBound = true;
        const relock = () => {
          lockPointer();
        };
        ov.addEventListener('click', relock);
        ov._relockFn = relock;
      }
    }
  } else if (pointerLocked) {
    // 락 성공 → 오버레이 숨김
    const ov = document.getElementById('gameStartClick');
    if (ov) { ov.style.display = 'none'; ov.classList.remove('show'); }
  }
});

// ESC로 재잠금 (락이 풀린 상태에서만 발동, 채팅 중이면 스킵)
addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (window._chatTyping) return;
  if (currentScreen !== 'game') return;
  if (paintMode) return;
  if (pointerLocked) return; // 이미 잠겨있으면 브라우저가 풀 것
  // 이 ESC는 이미 락이 풀린 후의 두 번째 ESC → 재잠금 시도
  setTimeout(() => lockPointer(), 100);
});

document.addEventListener('mousemove', e => {
  // 락이 실제로 canvas 에 걸려있을 때만 카메라 회전 (플래그 대신 실시간 확인)
  const locked = (document.pointerLockElement === renderer.domElement);

  const mx = Number(e.movementX) || 0;
  const my = Number(e.movementY) || 0;



  if (!locked) return;
  if (paintMode) return;

  cameraYaw   -= mx * 0.0025;
  cameraPitch += my * 0.002;

  if (cameraPitch >  1.3) cameraPitch =  1.3;
  if (cameraPitch < -1.3) cameraPitch = -1.3;
  if (cameraYaw >  Math.PI) cameraYaw -= Math.PI * 2;
  if (cameraYaw < -Math.PI) cameraYaw += Math.PI * 2;
});

// 페인트 모드 토글 (Q) — P 는 포즈 휠에 사용
let _paintRelockTimer = null;
addEventListener('keydown', e => {
  if (e.code === 'KeyQ' && !poseWheelOpen && currentScreen === 'game') {
    paintMode = !paintMode;
    document.getElementById('paintIndicator').classList.toggle('on', paintMode);
    document.getElementById('crosshair').classList.toggle('on', paintMode);
    // 기존 재잠금 타이머 항상 취소 (빠른 Q 연타 시 중복 방지)
    if (_paintRelockTimer) { clearTimeout(_paintRelockTimer); _paintRelockTimer = null; }
    if (paintMode) {
      // 포인터락이 걸려있을 때만 해제 (이미 풀려있으면 호출 불필요)
      if (document.pointerLockElement) document.exitPointerLock();
    } else {
      // exitPointerLock이 일어난 경우 브라우저 쿨다운 대기, 아닌 경우 즉시 재잠금
      const delay = document.pointerLockElement ? 300 : 0;
      _paintRelockTimer = setTimeout(() => {
        _paintRelockTimer = null;
        if (!paintMode && currentScreen === 'game') {
          lockPointer();
        }
      }, delay);
    }
  }
  // 도구 단축키
  if (paintMode) {
    if (e.code === 'KeyB') setTool('brush');
    if (e.code === 'KeyF') bucketFill();
    if (e.code === 'KeyE') setTool('eraser');
    if (e.code === 'KeyI') setTool('picker');
  }
  // 점프
  if (e.code === 'Space' && isGrounded && !paintMode) {
    velocityY = JUMP_V; isGrounded = false;
  }
});

// ================ 물리 ================
let velocityY = 0, isGrounded = true;
const GRAVITY = -30, JUMP_V = 16;
let cachedGroundY = null, lastGroundX = 0, lastGroundZ = 0;
// ★ 갑작스런 추락 방지용: 마지막으로 밟은 확실한 바닥 + 하강 연속 감지 카운터
let _lastSolidGroundY = null;
let _groundDropStreak = 0;

// 벽 타기 (스페이스 길게)
let isClimbing = false;
const CLIMB_SPEED = 6;
const WALL_DETECT_DIST = 0.85;
const CLIMB_MIN_WALL_HEIGHT = 2.5; // ★ 등반 가능한 벽 최소 높이 (작은 상자·벤치·난간에 안 붙게)
const wallRc = new THREE.Raycaster();
const _wallOrigin = new THREE.Vector3();
const _wallOriginTop = new THREE.Vector3();
const _wallDirs = [
  new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1, 0, 0),
  new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1)
];
function checkNearWall() {
  if (!_nearbyColliders || !_nearbyColliders.length) return false;
  // ★ 진짜 등반 가능한 벽 판정:
  //   허리 높이(1.0m) 와 머리 위(1.0 + CLIMB_MIN_WALL_HEIGHT) 두 곳에서 광선을 쏴서
  //   같은 방향에 둘 다 벽이 있어야 = 최소 CLIMB_MIN_WALL_HEIGHT 만큼 높은 벽
  //   작은 상자(높이 1m) · 벤치 · 계단 난간에는 위쪽 광선이 안 걸림 → 등반 불가
  _wallOrigin.set(player.position.x, player.position.y + 1.0, player.position.z);
  _wallOriginTop.set(player.position.x, player.position.y + 1.0 + CLIMB_MIN_WALL_HEIGHT, player.position.z);
  for (const d of _wallDirs) {
    wallRc.set(_wallOrigin, d);
    wallRc.far = WALL_DETECT_DIST;
    if (wallRc.intersectObjects(_nearbyColliders, false).length === 0) continue;
    // 아래는 걸림 → 위쪽도 확인
    wallRc.set(_wallOriginTop, d);
    wallRc.far = WALL_DETECT_DIST;
    if (wallRc.intersectObjects(_nearbyColliders, false).length > 0) return true;
  }
  return false;
}

// 벽에 몸이 파묻힌 상태 판정 — 진짜 안쪽에 파묻힌 경우만
// (근처에 벽 있다고 그냥 stuck 처리하면 착지 시 튐 버그)
const _stuckDirs = [
  new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1, 0, 0),
  new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1),
];
const _stuckRc = new THREE.Raycaster();
const _stuckOrigin = new THREE.Vector3();
function isStuckInWall() {
  if (!_nearbyColliders || !_nearbyColliders.length) return false;
  _stuckOrigin.set(player.position.x, player.position.y + 0.9, player.position.z);
  let hitCount = 0;
  for (const d of _stuckDirs) {
    _stuckRc.set(_stuckOrigin, d);
    _stuckRc.far = 0.18; // ★ 0.35→0.18 (진짜 안쪽에 파묻힌 경우만, 벽 옆 서있는 건 X)
    if (_stuckRc.intersectObjects(_nearbyColliders, false).length > 0) hitCount++;
    if (hitCount >= 3) return true; // ★ 2→3 (3방향 이상 초근접해야 진짜 파묻힘)
  }
  return false;
}

const groundRay = new THREE.Raycaster();
const downV = new THREE.Vector3(0,-1,0);
const _groundOrigin = new THREE.Vector3();
// 천장 체크용 (상승 중 지붕 뚫림 방지)
const _ceilRc = new THREE.Raycaster();
const _ceilOrigin = new THREE.Vector3();
const _upV = new THREE.Vector3(0, 1, 0);
const _groundAndCollidable = [ground]; // ground + collidableMeshes 통합 배열 (매 프레임 스프레드 방지)
function getGroundHeight(x, z) {
  refreshNearbyColliders();
  const startY = player.position.y + 2.0;
  const maxAllowed = player.position.y + 0.6;
  // ★ 3점 샘플링: 중심 + 전후 (성능과 정확도 균형)
  const offsets = [[0,0],[0.2,0],[0,0.2]];
  let best = null;
  for (const [ox, oz] of offsets) {
    _groundOrigin.set(x + ox, startY, z + oz);
    groundRay.set(_groundOrigin, downV);
    groundRay.far = 50;
    const hits = groundRay.intersectObjects(_nearbyWithGround, false);
    for (const h of hits) {
      if (h.point.y <= maxAllowed) {
        if (best === null || h.point.y > best) best = h.point.y;
      }
    }
  }
  return best;
}

const rc = new THREE.Raycaster();
const ro = new THREE.Vector3(), rd = new THREE.Vector3();
const _sideOrigin = new THREE.Vector3(); // 어깨(캡슐 옆면) 광선 원점
const PR = 0.42; // 벽 통과 방지: 0.35→0.42 (좁은 문틈은 희생하되 벽 파고들기 방지)
// ★ 4단 높이: 무릎(0.5)/허리(1.0)/가슴(1.4)/머리(1.8)
//   발끝 광선(0.05) 제거 → 낮은 턱·계단·문턱은 자연스럽게 걸어 넘어감
//   벽은 위쪽 높이의 광선이 잡으니 뚫림 X
const _tryMoveHeights = [0.2, 1.0, 1.7]; // ★ 3단 높이 (발/허리/머리) — 성능 40% 감소, 벽 통과 방지 유지
// ★ 캡슐 어깨 오프셋 (몸 폭의 60%) — 대각선 벽 검출하되 너무 넓지 않게
const CAPSULE_SHOULDER = PR * 0.85; // 어깨 폭 확대 → 대각/모서리 벽 통과 방지
const _safeDirs = [
  new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1, 0, 0),
  new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1),
];
const _safeRc = new THREE.Raycaster();
const _safeOrigin = new THREE.Vector3();
const SAFE_MARGIN = 0.18; // 파묻힘 판정 강화: 0.12→0.18 더 일찍 감지해 롤백
// 안전망은 발/허리 2단계 (머리는 벽 뚫리기 힘든 위치)
const _safeHeights = [0.4, 1.0];

// ★ 성능 최적화: 플레이어 근처 collider 만 캐시 (500ms 또는 3m 이동마다 갱신)
//   맵에 collider 200개 있어도 근처 20개 정도만 검사 → 라이트하게
let _nearbyColliders = [];
let _nearbyWithGround = [ground]; // ground + nearby (지면/천장 체크용)
let _lastNearbyUpdate = 0;
let _lastNearbyPos = { x: Infinity, z: Infinity };
const NEARBY_RANGE = 14; // 반경 14m (편의점 같은 작은 실내 맵 전체 커버)
const _tmpNearbyCenter = new THREE.Vector3();
function refreshNearbyColliders() {
  const now = performance.now();
  const px = player.position.x, pz = player.position.z;
  const movedFar = Math.hypot(px - _lastNearbyPos.x, pz - _lastNearbyPos.z) > 3;
  if (now - _lastNearbyUpdate < 500 && !movedFar) return;
  _lastNearbyUpdate = now;
  _lastNearbyPos.x = px; _lastNearbyPos.z = pz;
  _nearbyColliders.length = 0;
  const rangeSq = NEARBY_RANGE * NEARBY_RANGE;
  for (const m of collidableMeshes) {
    if (!m.geometry) continue;
    if (!m.geometry.boundingSphere) {
      try { m.geometry.computeBoundingSphere(); } catch(e) { continue; }
    }
    const bs = m.geometry.boundingSphere;
    if (!bs) continue;
    _tmpNearbyCenter.copy(bs.center).applyMatrix4(m.matrixWorld);
    const sc = Math.max(m.scale.x, m.scale.y, m.scale.z);
    const worldR = bs.radius * sc;
    const dx = _tmpNearbyCenter.x - px, dz = _tmpNearbyCenter.z - pz;
    const r = NEARBY_RANGE + worldR;
    if (dx*dx + dz*dz < r*r) _nearbyColliders.push(m);
  }
  // ground + nearby 리스트 재구성
  _nearbyWithGround.length = 0;
  _nearbyWithGround.push(ground);
  for (const m of _nearbyColliders) _nearbyWithGround.push(m);
}

function isPositionSafe() {
  if (!_nearbyColliders.length) return true;
  // ★ 완전 파묻힘만 판정: 모든 방향(4방향 × 2높이 = 8) 이 SAFE_MARGIN 안에 다 막혔을 때만 false
  //   벽 근처에 서있거나 박스 안에 들어간 건 정상 이동으로 허용
  //   → 진짜 몸이 벽 안에 파고들어 사방이 즉시 벽인 경우만 롤백
  let blockedCount = 0;
  const totalChecks = _safeHeights.length * _safeDirs.length;
  for (const hY of _safeHeights) {
    _safeOrigin.set(player.position.x, player.position.y + hY, player.position.z);
    for (const dir of _safeDirs) {
      _safeRc.set(_safeOrigin, dir);
      _safeRc.far = SAFE_MARGIN;
      if (_safeRc.intersectObjects(_nearbyColliders, false).length) blockedCount++;
    }
  }
  // 8회 검사 중 7회 이상 초근접 = 진짜 벽 안에 파묻힘 → 롤백
  return blockedCount < totalChecks - 1;
}

function tryMove(dx, dz) {
  if (!collidableMeshes.length) {
    player.position.x += dx;
    player.position.z += dz;
    return;
  }
  refreshNearbyColliders();
  // ★ 캡슐 스윕 체크: 중심 + 좌/우 어깨 3광선 × 5높이 = 15 광선
  //   단일 광선은 대각선 벽/얇은 기둥/모서리를 놓칠 수 있음
  //   좌우 어깨 광선이 몸의 폭을 커버해서 어떤 각도의 벽도 검출
  const check = (mx, mz) => {
    const d = Math.hypot(mx, mz);
    if (d < 0.0001) return true;
    rd.set(mx, 0, mz).normalize();
    // 이동 방향에 수직인 벡터 = 캡슐 옆면 (어깨)
    const perpX = -rd.z, perpZ = rd.x;
    const sx = perpX * CAPSULE_SHOULDER, sz = perpZ * CAPSULE_SHOULDER;
    // ★ 앞 검사 거리: 이동거리 + 살짝만 (몸반경 절반). 너무 크면 벽 옆 지나갈 때도 멈춤
    const farDist = d + PR * 0.8; // 감지 거리 확대 → 고속 이동 시 벽 통과 방지
    for (const hY of _tryMoveHeights) {
      const py = player.position.y + hY;
      // 중심 광선
      ro.set(player.position.x, py, player.position.z);
      rc.set(ro, rd); rc.far = farDist;
      if (rc.intersectObjects(_nearbyColliders, false).length) return false;
      // 왼쪽 어깨 광선
      _sideOrigin.set(player.position.x + sx, py, player.position.z + sz);
      rc.set(_sideOrigin, rd); rc.far = farDist;
      if (rc.intersectObjects(_nearbyColliders, false).length) return false;
      // 오른쪽 어깨 광선
      _sideOrigin.set(player.position.x - sx, py, player.position.z - sz);
      rc.set(_sideOrigin, rd); rc.far = farDist;
      if (rc.intersectObjects(_nearbyColliders, false).length) return false;
    }
    return true;
  };
  const origX = player.position.x, origZ = player.position.z;
  // X 축
  if (check(dx, 0)) {
    const nx = player.position.x + dx;
    if (!worldBounds || (nx >= worldBounds.minX && nx <= worldBounds.maxX)) {
      player.position.x = nx;
    }
  }
  // Z 축
  if (check(0, dz)) {
    const nz = player.position.z + dz;
    if (!worldBounds || (nz >= worldBounds.minZ && nz <= worldBounds.maxZ)) {
      player.position.z = nz;
    }
  }
  // ★ 최종 위치에서 안전망 (8방향 × 3높이) — 이동 발생했을 때만
  //   조금이라도 파묻혔으면 완전 롤백. 절대 벽 안으로 안 들어감.
  if ((player.position.x !== origX || player.position.z !== origZ) && !isPositionSafe()) {
    player.position.x = origX;
    player.position.z = origZ;
  }
}

// 경계 관리
let worldBounds = null;
// 매 프레임 하드 클램프 (혹시 어떻게든 밖으로 나갔으면 강제로 안으로)
function clampPlayerToBounds() {
  if (!worldBounds) return;
  if (player.position.x < worldBounds.minX) player.position.x = worldBounds.minX;
  else if (player.position.x > worldBounds.maxX) player.position.x = worldBounds.maxX;
  if (player.position.z < worldBounds.minZ) player.position.z = worldBounds.minZ;
  else if (player.position.z > worldBounds.maxZ) player.position.z = worldBounds.maxZ;
}

// ★★ 벽 파묻힘 안전 위치 롤백 시스템 ★★
//     물리 엔진의 penetration test → last-safe rollback 방식
//     - 매 프레임 안전 위치면 저장 (_lastSafePos)
//     - 파묻힘 감지되면 마지막 안전 위치로 순간 복구
//     - 어떤 이동/등반 로직이 실수해도 다음 프레임에 즉시 회복 → 절대 낑기지 않음
let _lastSafePos = null;
let _lastSafePosT = 0;
const _stuckCheckDirs = [
  new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1, 0, 0),
  new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1),
  new THREE.Vector3(0.7071, 0, 0.7071), new THREE.Vector3(-0.7071, 0, 0.7071),
  new THREE.Vector3(0.7071, 0, -0.7071), new THREE.Vector3(-0.7071, 0, -0.7071),
];
const _stuckCheckRc = new THREE.Raycaster();
const _stuckCheckOrigin = new THREE.Vector3();
const STUCK_PENETRATION_DIST = 0.14; // 파묻힘 감지 거리 확대: 0.08→0.14
const STUCK_THRESHOLD = 5;            // 8방향 중 5개 이상 파묻힘 = 갇힘 판정 (더 민감하게)
function _isCurrentlyPenetrating() {
  if (!_nearbyColliders || !_nearbyColliders.length) return false;
  // ★ 두 높이(허리 0.9m, 무릎 0.4m)에서 검사 → 낮은 구조물도 정확히 잡음
  let hits = 0;
  for (const hY of [0.4, 0.9]) {
    _stuckCheckOrigin.set(player.position.x, player.position.y + hY, player.position.z);
    for (const d of _stuckCheckDirs) {
      _stuckCheckRc.set(_stuckCheckOrigin, d);
      _stuckCheckRc.far = STUCK_PENETRATION_DIST;
      if (_stuckCheckRc.intersectObjects(_nearbyColliders, false).length > 0) hits++;
      if (hits >= STUCK_THRESHOLD) return true;
    }
  }
  return false;
}
function enforceSafePosition() {
  if (!collidableMeshes.length) return;
  // ★ 등반 중이거나 최근 착지 직후엔 롤백 스킵 (벽 붙는 게 정상, 물리 안정화 필요)
  if (isClimbing) return;
  const _now = performance.now();
  if (window._justLandedAt && (_now - window._justLandedAt < 400)) return;
  refreshNearbyColliders();
  const penetrating = _isCurrentlyPenetrating();
  if (!penetrating) {
    // 안전한 상태 → 지금 위치를 마지막 안전 위치로 저장
    if (!_lastSafePos) _lastSafePos = new THREE.Vector3();
    _lastSafePos.copy(player.position);
    _lastSafePosT = _now;
    return;
  }
  // 파묻힘 감지됨
  if (_lastSafePos && (_now - _lastSafePosT) < 5000) {
    // 5초 이내 안전 위치가 있으면 순간 복구
    player.position.copy(_lastSafePos);
    velocityY = 0;
    isClimbing = false;
    cachedGroundY = null;
  } else {
    // 안전 위치 저장된 적 없거나 너무 오래됨 → 위로 텔포
    player.position.y += 3;
    velocityY = 5;
    cachedGroundY = null;
    _lastSafePos = null;
  }
}

// ================ Painting ================
let currentTool = 'brush';
let currentColor = '#ff4757';
let brushSize = 20;
let recentColors = ['#ff4757','#ffdd00','#4dd07a','#1e90ff','#a55eea'];

function setTool(t) {
  currentTool = t;
  document.querySelectorAll('.tool').forEach(b => b.classList.toggle('active', b.dataset.tool === t));
  console.log('🛠 툴 변경:', t);
}
document.querySelectorAll('.tool').forEach(b => b.addEventListener('click', () => {
  const t = b.dataset.tool;
  if (t === 'bucket') { bucketFill(); return; }
  setTool(t);
}));

document.getElementById('brushRange').addEventListener('input', e => {
  brushSize = +e.target.value;
  document.getElementById('brushSizeVal').textContent = brushSize;
});

// 페인트 실행
const paintRc = new THREE.Raycaster();
let lastPaintTime = 0;
let _lastPaintSyncTime = 0;
const _paintColor = new THREE.Color(); // 재사용 (매 paint() 호출마다 new 방지)

// 버텍스 컬러 페인트 시스템 (UV 필요없음)
const _tmpMat = new THREE.Matrix4();
const _tmpVec = new THREE.Vector3();

function bucketFill() {
  const c = new THREE.Color(currentColor);
  characterMeshes.forEach(mesh => {
    const colors = mesh.geometry.attributes.color;
    if (!colors) return;
    for (let i = 0; i < colors.count; i++) colors.setXYZ(i, c.r, c.g, c.b);
    colors.needsUpdate = true;
  });
  addRecentColor(currentColor);
  let total = 0;
  characterMeshes.forEach(m => { total += m.geometry.attributes.color?.count || 0; });
  console.log('🎨 버킷 전체 채움:', currentColor, '/ 총 정점:', total);
  // Firebase 로 브로드캐스트 (특수 스트로크)
  if (myRoomId && myUid) {
    const strokesRef = ref(fbDb, `rooms/${myRoomId}/paint/${myUid}/strokes`);
    push(strokesRef, { bucket: true, c: currentColor, t: Date.now() });
  }
}

// 스포이드용 타겟 메쉬 캐시 (매 클릭 traverse 방지)
let _pickerTargets = null;
let _pickerTargetsDirty = true;
function _getPickerTargets() {
  if (!_pickerTargetsDirty && _pickerTargets) return _pickerTargets;
  _pickerTargets = [...characterMeshes];
  // ★ 다른 플레이어 캐릭터
  Object.values(otherPlayers).forEach(ot => {
    if (ot.charMesh) ot.charMesh.traverse(o => { if (o.isMesh) _pickerTargets.push(o); });
  });
  // ★ 맵 구조물 (텍스처 색 뽑기 대상)
  for (let i = 0; i < collidableMeshes.length; i++) _pickerTargets.push(collidableMeshes[i]);
  _pickerTargetsDirty = false;
  return _pickerTargets;
}
function invalidatePickerCache() {
  _pickerTargetsDirty = true;
  // ★ 씬 메쉬 캐시도 동시에 무효화 (스포이드 씬 전체 검색용)
  window._pickerMeshCacheDirty = true;
}

// 바리센트릭 보간으로 히트 포인트의 정확한 vertex color 샘플링
function _sampleVertexColor(mesh, hit) {
  const colors = mesh.geometry.attributes.color;
  const positions = mesh.geometry.attributes.position;
  if (!colors || !positions) return null;

  mesh.updateWorldMatrix(true, false);
  _tmpMat.copy(mesh.matrixWorld).invert();
  const localPt = hit.point.clone().applyMatrix4(_tmpMat);

  const face = hit.face;
  if (!face) {
    let bestI = 0, bestD = Infinity;
    for (let i = 0; i < positions.count; i++) {
      const dx = positions.getX(i) - localPt.x;
      const dy = positions.getY(i) - localPt.y;
      const dz = positions.getZ(i) - localPt.z;
      const d = dx*dx + dy*dy + dz*dz;
      if (d < bestD) { bestD = d; bestI = i; }
    }
    return { r: colors.getX(bestI), g: colors.getY(bestI), b: colors.getZ(bestI) };
  }

  // 바리센트릭 보간
  const a = face.a, b = face.b, c = face.c;
  const pA = new THREE.Vector3(positions.getX(a), positions.getY(a), positions.getZ(a));
  const pB = new THREE.Vector3(positions.getX(b), positions.getY(b), positions.getZ(b));
  const pC = new THREE.Vector3(positions.getX(c), positions.getY(c), positions.getZ(c));
  const bary = new THREE.Vector3();
  THREE.Triangle.getBarycoord(localPt, pA, pB, pC, bary);
  const barySum = bary.x + bary.y + bary.z;
  let wa, wb, wc;
  if (!isFinite(barySum) || barySum < 0.0001) {
    // 폴백: 역거리 가중치
    const da = pA.distanceToSquared(localPt) || 0.0001;
    const db = pB.distanceToSquared(localPt) || 0.0001;
    const dc = pC.distanceToSquared(localPt) || 0.0001;
    const s = 1/da + 1/db + 1/dc;
    wa = (1/da)/s; wb = (1/db)/s; wc = (1/dc)/s;
  } else {
    // ★ 정규화: 합이 1이 되도록 보정해 float 오차 제거 (정확도 극대화)
    wa = bary.x / barySum; wb = bary.y / barySum; wc = bary.z / barySum;
  }
  return {
    r: colors.getX(a)*wa + colors.getX(b)*wb + colors.getX(c)*wc,
    g: colors.getY(a)*wa + colors.getY(b)*wb + colors.getY(c)*wc,
    b: colors.getZ(a)*wa + colors.getZ(b)*wb + colors.getZ(c)*wc,
  };
}

// ★ 스포이드 렌더타겟 (오프스크린 픽셀 읽기용)
let _pickerRenderTarget = null;

// ★ paint()가 저장한 linear vertex color → 원래 hex 색 역추출
// paint()는 _paintColor.set(hex) → ColorManagement가 sRGB→Linear 자동변환 → setXYZ 저장
// 따라서 읽을 때 Linear→sRGB 역변환하면 원래 hex가 나옴
function _pickColorAt(clientX, clientY) {
  if (!characterMeshes.length && !collidableMeshes.length) return null;

  const rect = renderer.domElement.getBoundingClientRect();
  const mv = new THREE.Vector2(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1
  );
  paintRc.camera = camera;
  paintRc.setFromCamera(mv, camera);

  // ★ 캐릭터 + 맵 구조물 모두 대상 (_getPickerTargets 가 관리)
  const hits = paintRc.intersectObjects(_getPickerTargets(), true);
  if (!hits.length) return null;

  const hit  = hits[0];
  const mesh = hit.object;
  const colors = mesh.geometry?.attributes?.color;
  // vertex color 없으면 이 경로로는 못 뽑음 (텍스처는 _renderPickerScene 이 처리)
  if (!colors) return null;

  // 바리센트릭 보간으로 정확한 vertex color 샘플링
  const s = _sampleVertexColor(mesh, hit);
  if (!s) return null;

  // Linear→sRGB 변환 (IEC 61966-2-1 정밀식)
  // paint()가 Color.set(hex)로 sRGB→Linear 변환해 저장했으므로 역변환하면 원래 색
  const toSRGB = v => {
    v = Math.max(0, Math.min(1, v));
    return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  };
  const r = Math.round(toSRGB(s.r) * 255);
  const g = Math.round(toSRGB(s.g) * 255);
  const b = Math.round(toSRGB(s.b) * 255);
  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
}

function _renderPickerScene(clientX, clientY) {
  // ★ 캐릭터 + 맵 구조물 모두 대상으로 오프스크린 렌더 → 픽셀 읽기
  if (!characterMeshes.length && !collidableMeshes.length) return null;

  const rect    = renderer.domElement.getBoundingClientRect();
  const canvasW = renderer.domElement.width;
  const canvasH = renderer.domElement.height;
  const px = Math.round((clientX - rect.left) / rect.width  * canvasW);
  const py = Math.round((1 - (clientY - rect.top) / rect.height) * canvasH);

  // 레이캐스트로 히트 mesh 확인 (캐릭터 + 맵)
  const mv = new THREE.Vector2(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1
  );
  paintRc.camera = camera;
  paintRc.setFromCamera(mv, camera);
  const hits = paintRc.intersectObjects(_getPickerTargets(), true);
  if (!hits.length) return null;
  const hitMesh = hits[0].object;
  // 텍스처만 있고 vertex color가 없는 메쉬도 스포이드 대상
  if (!hitMesh.geometry?.attributes?.color && !(hitMesh.material && hitMesh.material.map)) return null;

  // 풀사이즈 RT (lazy 생성)
  if (!_pickerRenderTarget ||
      _pickerRenderTarget.width  !== canvasW ||
      _pickerRenderTarget.height !== canvasH) {
    if (_pickerRenderTarget) _pickerRenderTarget.dispose();
    _pickerRenderTarget = new THREE.WebGLRenderTarget(canvasW, canvasH, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
    });
  }

  // ★ 텍스처 + vertex color 합쳐진 실제 표시 색을 뽑기 위해 원본 material 유지
  //   (MeshBasic로 바꾸면 텍스처 정보가 사라짐 → 스포이드가 페인트만 찍힘)
  const origMat  = hitMesh.material;
  let basicMat = null;
  const origMap = origMat && origMat.map ? origMat.map : null;
  if (!origMap) {
    // 텍스처 없는 메쉬만 vertex color 전용 fallback
    basicMat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
    hitMesh.material = basicMat;
  } else {
    // 텍스처 있는 경우: MeshBasic + map + vertexColors 로 조명 제거하고 실제 텍스처 색 유지
    basicMat = new THREE.MeshBasicMaterial({
      map: origMap,
      vertexColors: !!hitMesh.geometry?.attributes?.color,
      side: THREE.DoubleSide,
      transparent: !!origMat.transparent,
      alphaTest: origMat.alphaTest || 0
    });
    hitMesh.material = basicMat;
  }

  const hidden = [];
  scene.traverse(o => {
    if (o.isMesh && o !== hitMesh && o.visible) { o.visible = false; hidden.push(o); }
  });

  const prevRT    = renderer.getRenderTarget();
  const prevTone  = renderer.toneMapping;
  const prevCS    = renderer.outputColorSpace;
  const prevClear = renderer.autoClear;

  renderer.toneMapping      = THREE.NoToneMapping;
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.autoClear        = true;
  renderer.setRenderTarget(_pickerRenderTarget);
  renderer.render(scene, camera);

  // 즉시 복원
  renderer.setRenderTarget(prevRT);
  renderer.toneMapping      = prevTone;
  renderer.outputColorSpace = prevCS;
  renderer.autoClear        = prevClear;
  hitMesh.material = origMat;
  basicMat.dispose();
  hidden.forEach(o => { o.visible = true; });

  // 픽셀 읽기
  const buf = new Uint8Array(4);
  renderer.readRenderTargetPixels(_pickerRenderTarget, px, py, 1, 1, buf);
  if (buf[3] < 10) return null;

  // RT는 LinearSRGB로 렌더 → sRGB 변환
  const toSRGB = v => {
    v = Math.max(0, Math.min(1, v / 255));
    return Math.round((v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055) * 255);
  };
  return '#' + [toSRGB(buf[0]), toSRGB(buf[1]), toSRGB(buf[2])]
    .map(v => v.toString(16).padStart(2, '0')).join('');
}

function pickColor(clientX, clientY) {
  // 1차: 오프스크린 렌더 픽셀 (텍스처 + vertex color 합성 결과 = 화면에서 보이는 색)
  const hexRender = _renderPickerScene(clientX, clientY);
  // 2차: vertex color 직접 읽기 (텍스처 없는 메쉬용 fallback)
  const hexDirect = _pickColorAt(clientX, clientY);
  const hex = hexRender || hexDirect;
  if (!hex) { console.log('🎯 스포이드 - 색 없음 (캐릭터 또는 맵을 클릭하세요)'); return; }
  console.log('🎯 스포이드 결과 | direct:', hexDirect, '| render:', hexRender, '| 최종:', hex);
  currentColor = hex;
  document.getElementById('preview').style.background = hex;
  document.getElementById('hexInput').value = hex;
  setTool('brush');
}

const _paintMv = new THREE.Vector2(); // ★ 재사용 (paint 호출당 GC 압박 제거)
function paint(clientX, clientY) {
  if (!characterMeshes.length) { return; }
  const rect = renderer.domElement.getBoundingClientRect();
  _paintMv.set(
    ((clientX - rect.left)/rect.width)*2 - 1,
    -((clientY - rect.top)/rect.height)*2 + 1
  );
  paintRc.camera = camera;
  paintRc.setFromCamera(_paintMv, camera);
  // ★ characterMeshes는 Mesh만 있으므로 스프라이트 충돌 없음
  const hits = paintRc.intersectObjects(characterMeshes, true);
  if (!hits.length) return;
  const hit = hits[0];
  const mesh = hit.object;
  const worldPoint = hit.point.clone();
  
  // 스포이드는 paint() 밖에서 처리하므로 여기선 스킵
  if (currentTool === 'picker') return;
  
  // 월드 좌표 → mesh 로컬 좌표 (matrixWorld 강제 갱신)
  mesh.updateWorldMatrix(true, false);
  _tmpMat.copy(mesh.matrixWorld).invert();
  const localPoint = worldPoint.applyMatrix4(_tmpMat);
  
  const positions = mesh.geometry.attributes.position;
  const colors = mesh.geometry.attributes.color;
  if (!colors) { console.warn('color attribute 없음 - processGlb 확인 필요'); return; }
  
  // 붓 크기를 월드 반경으로 (brushSize 픽셀 → 대략 캐릭터 스케일)
  // 브러시 반경 - 최소 3cm 보장 (정점 하나는 확실히 잡히게)
  const worldScale = mesh.getWorldScale(_tmpVec).x || 1;
  let radiusLocal = brushSize * 0.008 / worldScale;
  // 작은 브러시일 때 정점 하나도 잡히도록 최소값을 아주 작게만 유지 (부드러운 그리기)
  if (radiusLocal < 0.006) radiusLocal = 0.006;
  const radiusSq = radiusLocal * radiusLocal;
  
  const paintColor = _paintColor.set(currentTool === 'eraser' ? '#ffffff' : currentColor);
  
  // 반경 내 모든 정점 색 변경
  let painted = 0;
  for (let i = 0; i < positions.count; i++) {
    const dx = positions.getX(i) - localPoint.x;
    const dy = positions.getY(i) - localPoint.y;
    const dz = positions.getZ(i) - localPoint.z;
    if (dx*dx + dy*dy + dz*dz < radiusSq) {
      colors.setXYZ(i, paintColor.r, paintColor.g, paintColor.b);
      painted++;
    }
  }
  colors.needsUpdate = true;
  mesh.geometry.attributes.color.needsUpdate = true;
  addRecentColor(currentColor);

  // ★ 페인트 스트로크 배칭 — throttle 로 스트로크 손실되던 문제 해결
  //   기존: 120ms 에 1개만 push → 남 화면에 빈 점 생김
  //   변경: 큐에 다 쌓아뒀다가 60ms 마다 update() 한 번에 전송 → 손실 0
  if (myRoomId && myUid) {
    const meshIdx = characterMeshes.indexOf(mesh);
    const cx = +localPoint.x.toFixed(2);
    const cy = +localPoint.y.toFixed(2);
    const cz = +localPoint.z.toFixed(2);
    const strokeColor = currentTool === 'eraser' ? '#ffffff' : currentColor;
    // dedup: 큐 마지막 스트로크와 거의 같은 위치·같은 색·같은 mesh면 스킵 (붓 정지 스팸 방지)
    let skip = false;
    if (_paintStrokeQueue.length > 0) {
      const last = _paintStrokeQueue[_paintStrokeQueue.length - 1];
      if (last.m === meshIdx && last.c === strokeColor) {
        const ddx = last.x - cx, ddy = last.y - cy, ddz = last.z - cz;
        const dedupR = radiusLocal * 0.35;
        if (ddx*ddx + ddy*ddy + ddz*ddz < dedupR * dedupR) skip = true;
      }
    }
    if (!skip) {
      _paintStrokeQueue.push({
        x: cx, y: cy, z: cz,
        c: strokeColor,
        r: +radiusLocal.toFixed(3),
        m: meshIdx,
        t: Date.now()
      });
      _schedulePaintFlush();
    }
  }
}

// ★ 페인트 스트로크 큐 & flush 스케줄러
const _paintStrokeQueue = [];
let _paintFlushTimer = null;
const PAINT_FLUSH_MS = 60;         // 60ms 마다 배치 전송
const PAINT_MAX_BATCH = 40;        // 한 번에 최대 40개 (안전 상한)
function _schedulePaintFlush() {
  if (_paintFlushTimer) return;
  _paintFlushTimer = setTimeout(_flushPaintQueue, PAINT_FLUSH_MS);
}
function _flushPaintQueue() {
  _paintFlushTimer = null;
  if (!myRoomId || !myUid || _paintStrokeQueue.length === 0) return;
  // 상한 초과 시 오래된 것부터 자름 (튐 방지)
  if (_paintStrokeQueue.length > PAINT_MAX_BATCH) {
    _paintStrokeQueue.splice(0, _paintStrokeQueue.length - PAINT_MAX_BATCH);
  }
  const batch = _paintStrokeQueue.splice(0);
  try {
    const strokesRef = ref(fbDb, `rooms/${myRoomId}/paint/${myUid}/strokes`);
    // 각 스트로크에 개별 push key 부여 → 한 번의 update() 로 원자적 전송
    const updates = {};
    for (let i = 0; i < batch.length; i++) {
      const k = push(strokesRef).key;
      updates[k] = batch[i];
    }
    update(strokesRef, updates);
  } catch(e) { /* 실패해도 다음 flush 시 큐가 비어있으면 그만, 이미 로컬은 반영됨 */ }
  // 큐에 뭐 더 쌓였으면 다시 예약
  if (_paintStrokeQueue.length > 0) _schedulePaintFlush();
}

let isPainting = false;
let _lastPaintX = null, _lastPaintY = null;
renderer.domElement.addEventListener('mousedown', e => {
  if (!paintMode || e.button !== 0) return;
  // 스포이드는 mousedown 에 즉시 실행
  if (currentTool === 'picker') { pickColor(e.clientX, e.clientY); return; }
  isPainting = true;
  _lastPaintX = e.clientX; _lastPaintY = e.clientY;
  paint(e.clientX, e.clientY);
  if (currentTool === 'bucket') isPainting = false;
});
addEventListener('mouseup', () => { isPainting = false; _lastPaintX = null; _lastPaintY = null; });
addEventListener('mousemove', e => {
  if (!paintMode || !isPainting) return;
  const cx = e.clientX, cy = e.clientY;
  if (_lastPaintX !== null) {
    const dx = cx - _lastPaintX, dy = cy - _lastPaintY;
    const dist = Math.sqrt(dx*dx + dy*dy);
    // ★ 성능: 보간 스텝 최대 8개로 제한 (멀리 움직여도 raycast 폭탄 방지)
    const step = Math.max(3, brushSize * 0.4);
    const steps = Math.min(8, Math.max(1, Math.ceil(dist / step)));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      paint(_lastPaintX + dx*t, _lastPaintY + dy*t);
    }
  } else {
    paint(cx, cy);
  }
  _lastPaintX = cx; _lastPaintY = cy;
  lastPaintTime = Date.now();
});

// ================ 색 선택기 ================
const hueCanvas = document.getElementById('hueCanvas');
const satCanvas = document.getElementById('satCanvas');
const hueCtx = hueCanvas.getContext('2d');
const satCtx = satCanvas.getContext('2d');
let hue = 0, sat = 1, val = 1;

function drawHue() {
  const g = hueCtx.createLinearGradient(0, 0, hueCanvas.width, 0);
  for (let i = 0; i <= 6; i++) g.addColorStop(i/6, `hsl(${i*60}, 100%, 50%)`);
  hueCtx.fillStyle = g;
  hueCtx.fillRect(0, 0, hueCanvas.width, hueCanvas.height);
  // 지시자
  const x = (hue/360) * hueCanvas.width;
  hueCtx.strokeStyle = '#fff'; hueCtx.lineWidth = 3;
  hueCtx.beginPath(); hueCtx.moveTo(x, 0); hueCtx.lineTo(x, hueCanvas.height); hueCtx.stroke();
}
function drawSat() {
  // 배경: 색상만
  satCtx.fillStyle = `hsl(${hue}, 100%, 50%)`;
  satCtx.fillRect(0, 0, satCanvas.width, satCanvas.height);
  // 흰색 그라디언트 (좌→우: 0→1 채도)
  const gw = satCtx.createLinearGradient(0, 0, satCanvas.width, 0);
  gw.addColorStop(0, 'rgba(255,255,255,1)'); gw.addColorStop(1, 'rgba(255,255,255,0)');
  satCtx.fillStyle = gw;
  satCtx.fillRect(0, 0, satCanvas.width, satCanvas.height);
  // 검은색 그라디언트 (아래→위: 1→0 밝기)
  const gb = satCtx.createLinearGradient(0, 0, 0, satCanvas.height);
  gb.addColorStop(0, 'rgba(0,0,0,0)'); gb.addColorStop(1, 'rgba(0,0,0,1)');
  satCtx.fillStyle = gb;
  satCtx.fillRect(0, 0, satCanvas.width, satCanvas.height);
  // 지시자
  const sx = sat * satCanvas.width;
  const sy = (1-val) * satCanvas.height;
  satCtx.strokeStyle = '#fff'; satCtx.lineWidth = 2;
  satCtx.beginPath(); satCtx.arc(sx, sy, 6, 0, Math.PI*2); satCtx.stroke();
  satCtx.strokeStyle = '#000'; satCtx.lineWidth = 1;
  satCtx.beginPath(); satCtx.arc(sx, sy, 7, 0, Math.PI*2); satCtx.stroke();
}
function hsvToRgb(h, s, v) {
  h /= 60;
  const c = v*s, x = c*(1-Math.abs(h%2 - 1)), m = v-c;
  let r=0,g=0,b=0;
  if (h<1) [r,g,b] = [c,x,0];
  else if (h<2) [r,g,b] = [x,c,0];
  else if (h<3) [r,g,b] = [0,c,x];
  else if (h<4) [r,g,b] = [0,x,c];
  else if (h<5) [r,g,b] = [x,0,c];
  else [r,g,b] = [c,0,x];
  return [Math.round((r+m)*255), Math.round((g+m)*255), Math.round((b+m)*255)];
}
function updateFromHSV() {
  const [r,g,b] = hsvToRgb(hue, sat, val);
  currentColor = '#' + [r,g,b].map(v => v.toString(16).padStart(2,'0')).join('');
  document.getElementById('preview').style.background = currentColor;
  document.getElementById('hexInput').value = currentColor;
  drawHue(); drawSat();
}
hueCanvas.addEventListener('mousedown', e => {
  const move = ev => {
    const rect = hueCanvas.getBoundingClientRect();
    hue = Math.max(0, Math.min(360, ((ev.clientX - rect.left)/rect.width)*360));
    updateFromHSV();
  };
  move(e);
  const up = () => { removeEventListener('mousemove', move); removeEventListener('mouseup', up); };
  addEventListener('mousemove', move); addEventListener('mouseup', up);
});
satCanvas.addEventListener('mousedown', e => {
  const move = ev => {
    const rect = satCanvas.getBoundingClientRect();
    sat = Math.max(0, Math.min(1, (ev.clientX - rect.left)/rect.width));
    val = Math.max(0, Math.min(1, 1 - (ev.clientY - rect.top)/rect.height));
    updateFromHSV();
  };
  move(e);
  const up = () => { removeEventListener('mousemove', move); removeEventListener('mouseup', up); };
  addEventListener('mousemove', move); addEventListener('mouseup', up);
});
document.getElementById('hexInput').addEventListener('change', e => {
  const v = e.target.value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(v)) {
    currentColor = v;
    document.getElementById('preview').style.background = v;
    // TODO: rgb→hsv 역변환
  }
});

function addRecentColor(color) {
  recentColors = [color, ...recentColors.filter(c => c !== color)].slice(0, 6);
  const rc = document.getElementById('recent');
  rc.innerHTML = '';
  recentColors.forEach(c => {
    const el = document.createElement('div');
    el.className = 'recent-color'; el.style.background = c;
    el.addEventListener('click', () => { currentColor = c; document.getElementById('preview').style.background = c; document.getElementById('hexInput').value = c; });
    rc.appendChild(el);
  });
}
addRecentColor('#ff4757'); // 초기
updateFromHSV();

// ================ Firebase 동기화 ================
const otherPlayers = {}; // uid → { group, mesh }
let syncStarted = false;

function startFirebaseSync(room) {
  if (syncStarted) return;
  syncStarted = true;

  const tryReg = () => {
    if (!myUid) { setTimeout(tryReg, 200); return; }
    // 방 안 game/{uid} 경로에 위치 씀
    myRef = ref(fbDb, `rooms/${myRoomId}/game/${myUid}`);

    // 내가 받은 좋아요 개수를 HUD에 표시
    onValue(ref(fbDb, `rooms/${myRoomId}/likes/${myUid}`), snap => {
      const val = snap.val() || {};
      const el = document.getElementById('myLikeCount');
      if (el) el.textContent = Object.keys(val).length;
    });

    // ★ 최적화: 움직일 때 100ms, 정지 시 500ms 주기로 전송 (Firebase write 절감)
    let _lastSyncX = null, _lastSyncY = null, _lastSyncZ = null, _lastSyncPose = null, _lastSyncR = null, _lastSyncStuck = null;
    let _lastSyncTime = 0;
    setInterval(() => {
      if (!myRef) return;
      const now = Date.now();
      const px = +player.position.x.toFixed(1);
      const py = +player.position.y.toFixed(1);
      const pz = +player.position.z.toFixed(1);
      const pr = +player.rotation.y.toFixed(1);
      const stuck = window._myStuck ? 1 : 0;
      const moved = _lastSyncX === null ||
          Math.abs(px - _lastSyncX) >= 0.15 ||
          Math.abs(py - _lastSyncY) >= 0.15 ||
          Math.abs(pz - _lastSyncZ) >= 0.15 ||
          Math.abs(pr - _lastSyncR) >= 0.1 ||
          currentPose !== _lastSyncPose ||
          stuck !== _lastSyncStuck;
      // 움직임 있으면 120ms, 없으면 800ms 주기 (Firebase write 절감)
      const minInterval = moved ? 120 : 800;
      if (now - _lastSyncTime < minInterval) return;
      _lastSyncX = px; _lastSyncY = py; _lastSyncZ = pz; _lastSyncPose = currentPose; _lastSyncR = pr; _lastSyncStuck = stuck; _lastSyncTime = now;
      // ★ 좌표 범위 클램핑 (맵 밖 이탈/텔레포트 방지, 최대 맵 크기 100)
      const clamp = (v, mn, mx) => Math.max(mn, Math.min(mx, v));
      set(myRef, {
        x: clamp(px, -100, 100),
        y: clamp(py, -5, 30),
        z: clamp(pz, -100, 100),
        r: pr,
        n: sanitizeNick(myNick || '익명', 16),
        p: (POSE_LIST.includes(currentPose) ? currentPose : 'stand'), // 유효한 포즈만
        role: (myRole === 'seeker' || myRole === 'hider') ? myRole : 'hider',
        stuck,
        t: now
      });
    }, 100);

    // 다른 플레이어 페인트 스트로크 수신 (uid별 개별 listen - 전체 노드 X)
    const _remoteColor = new THREE.Color();
    const _paintListeners = {}; // uid → unsub
    // 재사용 가능한 mesh 페인팅 유틸 (다른 플레이어 + 분신 공용)
    function applyStrokeToMeshes(meshes, stroke) {
      if (stroke.bucket) {
        _remoteColor.set(stroke.c);
        meshes.forEach(mesh => {
          const colors = mesh.geometry.attributes.color;
          if (!colors) return;
          for (let i = 0; i < colors.count; i++) {
            colors.setXYZ(i, _remoteColor.r, _remoteColor.g, _remoteColor.b);
          }
          colors.needsUpdate = true;
        });
        return;
      }
      const mesh = meshes[stroke.m] || meshes[0];
      if (!mesh) return;
      const colors = mesh.geometry.attributes.color;
      const positions = mesh.geometry.attributes.position;
      if (!colors || !positions) return;
      _remoteColor.set(stroke.c);
      const rSq = stroke.r * stroke.r;
      const lx = stroke.x, ly = stroke.y, lz = stroke.z;
      for (let i = 0; i < positions.count; i++) {
        const dx = positions.getX(i) - lx;
        const dy = positions.getY(i) - ly;
        const dz = positions.getZ(i) - lz;
        if (dx*dx + dy*dy + dz*dz < rSq) {
          colors.setXYZ(i, _remoteColor.r, _remoteColor.g, _remoteColor.b);
        }
      }
      colors.needsUpdate = true;
    }
    function applyRemotePaint(uid, stroke) {
      const ot = otherPlayers[uid];
      if (!ot) return;
      if (!ot._meshCache) {
        ot._meshCache = [];
        ot.charMesh.traverse(o => { if (o.isMesh) ot._meshCache.push(o); });
      }
      applyStrokeToMeshes(ot._meshCache, stroke);
    }
    function subscribePaintForUid(uid) {
      if (_paintListeners[uid]) return;
      // 최근 200개 스트로크만 listen (오래된 건 방 나갈 때 청소됨)
      const q = query(ref(fbDb, `rooms/${myRoomId}/paint/${uid}/strokes`), limitToLast(200));
      const _seen = new Set();
      const unsub = onChildAdded(q, snap => {
        const key = snap.key;
        if (_seen.has(key)) return;
        _seen.add(key);
        const stroke = snap.val();
        if (stroke) applyRemotePaint(uid, stroke);
      });
      _paintListeners[uid] = unsub;
    }
    function unsubPaintForUid(uid) {
      if (_paintListeners[uid]) { _paintListeners[uid](); delete _paintListeners[uid]; }
    }

    // ============ 따봉(좋아요) 시스템 ============
    const _likeListeners = {}; // uid → unsub
    const _likeTexCache = {};
    function makeLikeTexture(count) {
      const key = String(count);
      if (_likeTexCache[key]) return _likeTexCache[key];
      const cv = document.createElement('canvas');
      cv.width = 128; cv.height = 128;
      const cx = cv.getContext('2d');
      // 둥근 배경
      cx.fillStyle = 'rgba(0,0,0,0.7)';
      cx.beginPath(); cx.arc(64, 64, 58, 0, Math.PI*2); cx.fill();
      cx.strokeStyle = '#ffe066'; cx.lineWidth = 3; cx.stroke();
      // 👍 이모지
      cx.font = '52px sans-serif'; cx.textAlign = 'center'; cx.textBaseline = 'middle';
      cx.fillText('👍', 64, 50);
      // 카운트
      cx.fillStyle = '#ffe066';
      cx.font = 'bold 26px sans-serif';
      cx.fillText(String(count || 0), 64, 96);
      const tex = new THREE.CanvasTexture(cv);
      tex.needsUpdate = true;
      _likeTexCache[key] = tex;
      if (Object.keys(_likeTexCache).length > 30) {
        const oldest = Object.keys(_likeTexCache)[0];
        _likeTexCache[oldest].dispose();
        delete _likeTexCache[oldest];
      }
      return tex;
    }
    function updateLikeSprite(ot, count) {
      if (!ot || !ot.likeSprite) return;
      ot.likeCount = count;
      if (ot.likeSprite.material.map) ot.likeSprite.material.map.dispose();
      ot.likeSprite.material.map = makeLikeTexture(count);
      ot.likeSprite.material.needsUpdate = true;
    }
    function subscribeLikesForUid(uid) {
      if (_likeListeners[uid]) return;
      const r = ref(fbDb, `rooms/${myRoomId}/likes/${uid}`);
      const off = onValue(r, snap => {
        const val = snap.val() || {};
        const count = Object.keys(val).length;
        const ot = otherPlayers[uid];
        if (ot) updateLikeSprite(ot, count);
        // 내 좋아요 카운트도 HUD에 반영
        if (uid === myUid) {
          const el = document.getElementById('myLikeCount');
          if (el) el.textContent = count;
        }
      });
      _likeListeners[uid] = () => off();
    }
    function unsubLikesForUid(uid) {
      if (_likeListeners[uid]) { _likeListeners[uid](); delete _likeListeners[uid]; }
    }

    // ============ 분신(디코이) 시스템 ============
    const decoys = {}; // key → { group, ownerUid }
    window._decoys = decoys; // shoot 함수에서 접근용
    const DECOY_COOLDOWN = 8000;
    const DECOY_LIFE = 30000;
    let _lastDecoyTime = 0;
    function spawnDecoy(key, d) {
      if (decoys[key]) return;
      // ★ 분신 포즈 수정: 모든 포즈 지원 (현재 포즈 → stand 순으로 fallback)
      const poseName = d.p && poseModels[d.p] ? d.p : 'stand';
      const templatePose = poseModels[poseName] || poseModels.stand;
      if (!templatePose) return;
      // ★ SkeletonUtils.clone 사용: 애니메이션 가능한 클론 (포즈 모션 재생용)
      const clone = SkeletonUtils.clone(templatePose);
      clone.visible = true;
      const isMine = d.owner === myUid;
      // 분신도 진짜 플레이어처럼 vertexColors 재질로 초기화 (페인트 반영 가능하게)
      clone.traverse(o => {
        o.visible = true;
        if (o.isMesh) {
          o.geometry = o.geometry.clone();
          const posCount = o.geometry.attributes.position.count;
          const ca = new Float32Array(posCount * 3).fill(1);
          const cAttr = new THREE.BufferAttribute(ca, 3);
          cAttr.setUsage(THREE.DynamicDrawUsage);
          o.geometry.setAttribute('color', cAttr);
          o.material = new THREE.MeshLambertMaterial({
            color: 0xffffff,
            vertexColors: true,
            side: THREE.DoubleSide,
            transparent: isMine,
            opacity: isMine ? 0.55 : 1.0
          });
          o.castShadow = false;
          o.frustumCulled = true; // ★ 컬링 활성
        }
      });
      // ★ 분신 포즈 애니메이션 재생 (포즈 모션 공유)
      let decoyMixer = null;
      const poseAnims = templatePose.userData && templatePose.userData.animations;
      if (poseAnims && poseAnims.length) {
        decoyMixer = new THREE.AnimationMixer(clone);
        const decoyAction = decoyMixer.clipAction(poseAnims[0]);
        decoyAction.setLoop(THREE.LoopRepeat, Infinity);
        decoyAction.play();
      }
      const grp = new THREE.Group();
      grp.add(clone);
      grp.position.set(d.x, d.y, d.z);
      grp.rotation.y = d.r || 0;

      // 진짜 플레이어처럼 보이게 - 닉네임 스프라이트 (owner의 실제 닉)
      if (!window._nickTexCache) window._nickTexCache = {};
      const _nickKey = d.nick || '?';
      let nickTex;
      if (window._nickTexCache[_nickKey]) {
        nickTex = window._nickTexCache[_nickKey];
      } else {
        const nickCv = document.createElement('canvas');
        nickCv.width = 256; nickCv.height = 64;
        const ncx = nickCv.getContext('2d');
        ncx.fillStyle = 'rgba(0,0,0,0.6)'; ncx.fillRect(0,0,256,64);
        ncx.fillStyle = '#fff'; ncx.font = 'bold 32px sans-serif'; ncx.textAlign = 'center';
        ncx.fillText(_nickKey, 128, 42);
        nickTex = new THREE.CanvasTexture(nickCv);
        window._nickTexCache[_nickKey] = nickTex;
        if (Object.keys(window._nickTexCache).length > 60) {
          const firstKey = Object.keys(window._nickTexCache)[0];
          window._nickTexCache[firstKey].dispose();
          delete window._nickTexCache[firstKey];
        }
      } // end if cache miss
      const nickSp = new THREE.Sprite(new THREE.SpriteMaterial({ map: nickTex, transparent: true }));
      nickSp.scale.set(1.5, 0.4, 1);
      nickSp.position.y = 2.2;
      grp.add(nickSp);

      // 진짜처럼 좋아요 스프라이트도 (owner의 실시간 카운트를 그대로 반영)
      const likeSp = new THREE.Sprite(new THREE.SpriteMaterial({ map: makeLikeTexture(0), transparent: true }));
      likeSp.scale.set(0.6, 0.6, 1);
      likeSp.position.y = 2.9;
      grp.add(likeSp);
      const likeOff = onValue(ref(fbDb, `rooms/${myRoomId}/likes/${d.owner}`), snap => {
        const count = Object.keys(snap.val() || {}).length;
        if (likeSp.material.map) likeSp.material.map.dispose();
        likeSp.material.map = makeLikeTexture(count);
        likeSp.material.needsUpdate = true;
      });

      // ★ owner의 페인트 스트로크 전체 재생 → 분신 색상 진짜와 동일
      const decoyMeshes = [];
      clone.traverse(o => { if (o.isMesh) decoyMeshes.push(o); });
      const paintQ = query(ref(fbDb, `rooms/${myRoomId}/paint/${d.owner}/strokes`), limitToLast(200));
      const _decoySeen = new Set();
      const paintOff = onChildAdded(paintQ, snap => {
        const k = snap.key;
        if (_decoySeen.has(k)) return;
        _decoySeen.add(k);
        const stroke = snap.val();
        if (stroke) applyStrokeToMeshes(decoyMeshes, stroke);
      });

      // 주인한테만 "분" 표시 (자기 분신 위치 파악용)
      if (isMine) {
        const cv = document.createElement('canvas');
        cv.width = 64; cv.height = 64;
        const cx = cv.getContext('2d');
        cx.fillStyle = 'rgba(80,140,255,0.85)';
        cx.beginPath(); cx.arc(32, 32, 28, 0, Math.PI*2); cx.fill();
        cx.fillStyle = '#fff'; cx.font = 'bold 36px sans-serif';
        cx.textAlign = 'center'; cx.textBaseline = 'middle';
        cx.fillText('분', 32, 34);
        const tex = new THREE.CanvasTexture(cv);
        const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true }));
        sp.scale.set(0.5, 0.5, 1);
        sp.position.y = 3.5;
        grp.add(sp);
      }
      scene.add(grp);
      decoys[key] = { group: grp, ownerUid: d.owner, likeOff, paintOff, mixer: decoyMixer };
    }
    function despawnDecoy(key) {
      const d = decoys[key];
      if (!d) return;
      if (d.likeOff)  { try { d.likeOff();  } catch(e){} }
      if (d.paintOff) { try { d.paintOff(); } catch(e){} }
      if (d.mixer) { try { d.mixer.stopAllAction(); } catch(e){} }
      scene.remove(d.group);
      delete decoys[key];
    }
    // 방 전체 decoys 노드 구독
    onValue(ref(fbDb, `rooms/${myRoomId}/decoys`), snap => {
      const data = snap.val() || {};
      Object.entries(data).forEach(([key, d]) => {
        if (!decoys[key]) spawnDecoy(key, d);
      });
      Object.keys(decoys).forEach(key => {
        if (!data[key]) despawnDecoy(key);
      });
    });
    // 분신 생성 함수 (C 키)
    window.createDecoy = async function() {
      const now = Date.now();
      if (now - _lastDecoyTime < DECOY_COOLDOWN) {
        console.log('⏳ 분신 쿨다운:', Math.ceil((DECOY_COOLDOWN - (now - _lastDecoyTime))/1000), '초 남음');
        return;
      }
      if (!myRoomId || !myUid) return;
      _lastDecoyTime = now;
      const dRef = push(ref(fbDb, `rooms/${myRoomId}/decoys`));
      const payload = {
        owner: myUid,
        nick: myNick,
        x: +player.position.x.toFixed(2),
        y: +player.position.y.toFixed(2),
        z: +player.position.z.toFixed(2),
        r: +player.rotation.y.toFixed(2),
        p: currentPose,
        t: now,
      };
      try {
        await set(dRef, payload);
        // onDisconnect 안 씀 (네트워크 순간 끊김에 오삭제됨) - 수명 타이머만으로 정리
        setTimeout(async () => {
          try { await remove(dRef); } catch(e) {}
        }, DECOY_LIFE);
        console.log('👥 분신 생성');
      } catch(err) { console.warn('분신 실패:', err); }
    };

    // ✅ 위치 수신 throttle: 120ms (Firebase 이벤트 폭증 방지)
    // ★ 수신 데이터 검증: 범위 밖 좌표·비정상 포즈 무시
    let _posRecvThrottle = 0;
    onValue(ref(fbDb, `rooms/${myRoomId}/game`), snap => {
      const _now3 = Date.now();
      if (_now3 - _posRecvThrottle < 120) return;
      _posRecvThrottle = _now3;
      const data = snap.val() || {};
      const uids = Object.keys(data);
      document.getElementById('onlineCount').textContent = uids.length;
      uids.forEach(uid => {
        if (uid === myUid) return;
        const p = data[uid];
        if (!otherPlayers[uid]) {
          const templatePose = (p.p === 'crouch' && poseModels.crouch) ? poseModels.crouch : (poseModels.stand || characterTemplate);
          if (!templatePose) return;
          const clone = templatePose.clone(true);
          // 템플릿이 visible=false 로 시작하므로 강제로 visible 활성화
          clone.visible = true;
          // vertexColors 재질로 (페인트 색 표시 위해)
          clone.traverse(o => {
            o.visible = true;
            if (o.isMesh) {
              o.geometry = o.geometry.clone();
              // 흰색 vertex color 초기화
              const posCount = o.geometry.attributes.position.count;
              const ca = new Float32Array(posCount * 3).fill(1);
              const cAttr = new THREE.BufferAttribute(ca, 3);
              cAttr.setUsage(THREE.DynamicDrawUsage);
              o.geometry.setAttribute('color', cAttr);
              o.material = new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: true, side: THREE.DoubleSide });
              o.castShadow = false;
              o.frustumCulled = true; // ★ 컬링 활성
            }
          });
          const grp = new THREE.Group();
          grp.add(clone);
          // 닉네임 표시 (스프라이트) - 텍스처 캐싱
          if (!window._nickTexCache) window._nickTexCache = {};
          const _nk = p.n || '?';
          let tex;
          if (window._nickTexCache[_nk]) {
            tex = window._nickTexCache[_nk];
          } else {
            const cv = document.createElement('canvas');
            cv.width = 256; cv.height = 64;
            const cx = cv.getContext('2d');
            cx.fillStyle = 'rgba(0,0,0,0.6)'; cx.fillRect(0,0,256,64);
            cx.fillStyle = '#fff'; cx.font = 'bold 32px sans-serif'; cx.textAlign = 'center';
            cx.fillText(_nk, 128, 42);
            tex = new THREE.CanvasTexture(cv);
            window._nickTexCache[_nk] = tex;
            if (Object.keys(window._nickTexCache).length > 60) {
              const fk = Object.keys(window._nickTexCache)[0];
              window._nickTexCache[fk].dispose(); delete window._nickTexCache[fk];
            }
          }
          const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map:tex, transparent:true }));
          sp.scale.set(1.5, 0.4, 1);
          sp.position.y = 2.2;
          grp.add(sp);
          // 따봉 스프라이트 (닉네임 위에)
          const likeTex = makeLikeTexture(0);
          const likeSp = new THREE.Sprite(new THREE.SpriteMaterial({ map: likeTex, transparent: true }));
          likeSp.scale.set(0.6, 0.6, 1);
          likeSp.position.y = 2.9;
          grp.add(likeSp);
          scene.add(grp);
          otherPlayers[uid] = { group: grp, charMesh: clone, currentPose: p.p || 'stand', nickSprite: sp, likeSprite: likeSp, likeCount: 0 };
          // 새로 들어온 플레이어도 즉시 라벨 표시 상태 반영
          if (typeof updateNickLikeLabels === 'function' && _cachedRoom) updateNickLikeLabels(_cachedRoom);
          invalidatePickerCache(); // 스포이드 타겟 캐시 갱신
          subscribePaintForUid(uid); // uid별 페인트 리스너 등록
          subscribeLikesForUid(uid); // 좋아요 리스너 등록
          // 이 플레이어가 술래면 총 부착
          if (_cachedRoom?.seekerUid === uid) attachGunToOther(uid);
        }
        const ot = otherPlayers[uid];
        // ★ 수신 좌표 검증: 숫자가 아니거나 범위 초과면 무시
        const isNum = v => typeof v === 'number' && isFinite(v);
        if (isNum(p.x) && isNum(p.y) && isNum(p.z)) {
          // ★ 스냅샷 버퍼에 추가 (렌더 딜레이 보간용 - 텔포 느낌 제거)
          if (!ot.snapshots) ot.snapshots = [];
          const _nowMs = performance.now();
          const snap2 = {
            t: _nowMs,
            x: Math.max(-100, Math.min(100, p.x)),
            y: Math.max(-5, Math.min(30, p.y)),
            z: Math.max(-100, Math.min(100, p.z)),
            r: isNum(p.r) ? p.r : (ot.snapshots.length ? ot.snapshots[ot.snapshots.length-1].r : 0)
          };
          ot.snapshots.push(snap2);
          // 오래된 스냅샷 정리 (최대 20개, 1초 이상 오래된 건 마지막 2개 빼고 제거)
          if (ot.snapshots.length > 20) ot.snapshots.shift();
          // 기존 target 필드 유지 (다른 코드가 참조할 수 있음)
          ot.targetX = snap2.x; ot.targetY = snap2.y; ot.targetZ = snap2.z; ot.targetR = snap2.r;
          // 첫 스냅샷 - 즉시 위치 세팅 (첫 등장 자연스럽게)
          if (ot.snapshots.length === 1) {
            ot.group.position.set(snap2.x, snap2.y, snap2.z);
            ot.group.rotation.y = snap2.r;
          }
        } else if (isNum(p.r)) {
          ot.targetR = p.r;
        }
        ot.stuck = p.stuck ? 1 : 0;
        // 포즈 바뀌었으면 mesh 교체
        if (p.p && ot.currentPose !== p.p && poseModels[p.p]) {
          ot.group.remove(ot.charMesh);
          // 이전 mixer 정리
          if (otherMixers.has(uid)) { otherMixers.get(uid).mixer.stopAllAction(); otherMixers.delete(uid); }
          // SkeletonUtils.clone: 스켈레톤 유지되는 clone (애니메이션 가능)
          const clone = SkeletonUtils.clone(poseModels[p.p]);
          clone.visible = true;
          clone.traverse(o => {
            o.visible = true;
            if (o.isMesh) {
              o.geometry = o.geometry.clone();
              const posCount = o.geometry.attributes.position.count;
              const ca = new Float32Array(posCount * 3).fill(1);
              const cAttr = new THREE.BufferAttribute(ca, 3);
              cAttr.setUsage(THREE.DynamicDrawUsage);
              o.geometry.setAttribute('color', cAttr);
              o.material = new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: true, side: THREE.DoubleSide });
              o.castShadow = false;
              o.frustumCulled = true;
            }
          });
          // 애니메이션 시작
          const anims = poseModels[p.p].userData.animations;
          if (anims && anims.length) {
            const mixer = new THREE.AnimationMixer(clone);
            const action = mixer.clipAction(anims[0]);
            action.setLoop(THREE.LoopRepeat, Infinity);
            action.play();
            otherMixers.set(uid, { mixer, action });
          }
          ot.group.add(clone);
          ot.charMesh = clone;
          ot._meshes = null;
          ot._meshCache = null; // 페인트 mesh 캐시 무효화
          ot.currentPose = p.p;
          // 포즈 바뀌어도 술래면 총 유지 (기존 gun은 group에 남아있음 - 안 건드림)
          if (_cachedRoom?.seekerUid === uid && !ot.gun) attachGunToOther(uid);
        }
      });
      // 없어진 유저 제거
      Object.keys(otherPlayers).forEach(uid => {
        if (!data[uid]) {
          scene.remove(otherPlayers[uid].group);
          unsubPaintForUid(uid); // 페인트 리스너 해제
          unsubLikesForUid(uid); // 좋아요 리스너 해제
          delete otherPlayers[uid];
          invalidatePickerCache(); // 스포이드 타겟 캐시 갱신
        }
      });
    });
    // ========== 도발 휘슬 시스템 ==========
    subscribeWhistles();
    subscribeChat(myRoomId);
    subscribeSplats(myRoomId);
  };
  tryReg();
}

// ================ 도발 휘슬 시스템 (H) ================
const WHISTLE_URL = 'https://www.myinstants.com/media/sounds/geoje-yaho.mp3';
const WHISTLE_MAX_DIST = 200; // 이 거리 넘으면 안 들림 (맵 대부분 커버)
const WHISTLE_COOLDOWN = 3000; // 로컬 스팸 방지
let _lastWhistleSent = 0;
const _lastWhistleSeen = {}; // uid -> last timestamp we played
// 프리로드 (한 번 캐시)
const _whistlePreload = new Audio(WHISTLE_URL);
_whistlePreload.preload = 'auto';
_whistlePreload.load();

function playWhistleAt(x, y, z, isMe) {
  let vol;
  if (isMe) {
    vol = 0.7;
  } else {
    const dx = x - player.position.x;
    const dy = y - player.position.y;
    const dz = z - player.position.z;
    const dist = Math.hypot(dx, dy, dz);
    vol = Math.max(0, 1 - dist / WHISTLE_MAX_DIST);
    if (vol <= 0.02) return;
    vol = Math.sqrt(vol); // 완만한 감쇠 - 멀어도 잘 들리게
  }
  const a = new Audio(WHISTLE_URL);
  a.volume = Math.min(1, vol);
  a.play().catch(err => console.warn('휘슬 재생 실패:', err.message));
}

async function sendWhistle() {
  if (!myUid || !myRoomId) return;
  const now = Date.now();
  if (now - _lastWhistleSent < WHISTLE_COOLDOWN) {
    console.log('⏱ 휘슬 쿨다운 중');
    return;
  }
  _lastWhistleSent = now;
  // 로컬 즉시 재생
  playWhistleAt(player.position.x, player.position.y, player.position.z, true);
  // Firebase 로 브로드캐스트 (위치 포함)
  try {
    await set(ref(fbDb, `rooms/${myRoomId}/whistles/${myUid}`), {
      at: now,
      x: player.position.x,
      y: player.position.y,
      z: player.position.z
    });
    console.log('📢 휘슬 전송');
  } catch (err) {
    console.warn('휘슬 전송 실패:', err);
  }
}

function subscribeWhistles() {
  if (!myRoomId) return;
  onValue(ref(fbDb, `rooms/${myRoomId}/whistles`), snap => {
    const data = snap.val() || {};
    Object.entries(data).forEach(([uid, w]) => {
      if (!w || !w.at) return;
      if (uid === myUid) return; // 내 건 이미 로컬 재생
      const prev = _lastWhistleSeen[uid] || 0;
      if (w.at <= prev) return; // 새 이벤트만
      _lastWhistleSeen[uid] = w.at;
      // 처음 구독시엔 기존 값들 무시 (최근 5초 이내만 재생)
      if (Date.now() - w.at > 5000) return;
      playWhistleAt(w.x || 0, w.y || 0, w.z || 0, false);
      console.log('📣 상대 휘슬 감지:', uid);
    });
  });
}

// H 키로 휘슬
addEventListener('keydown', e => {
  if (e.code === 'KeyH' && !paintMode && currentScreen === 'game') {
    sendWhistle();
  }
});


// ================ 채팅 시스템 ================
let chatUnsub = null;
let chatInputOpen = false;
let _chatMsgTimers = [];

const chatBox      = document.getElementById('chatBox');
const chatMessages = document.getElementById('chatMessages');
const chatInputWrap= document.getElementById('chatInputWrap');
const chatInput    = document.getElementById('chatInput');
const chatSendBtn  = document.getElementById('chatSendBtn');
const chatHint     = document.getElementById('chatHint');

// 메시지 UI 추가
function addChatMsg(nick, text, isSystem) {
  const div = document.createElement('div');
  div.className = 'chat-msg' + (isSystem ? ' system' : '');
  div.innerHTML = '<span class="chat-nick">' + escHtml(nick || '?') + '</span>' + escHtml(text);
  chatMessages.appendChild(div);
  // 최대 30개 유지
  while (chatMessages.children.length > 30) chatMessages.children[0].remove();
  // 7초 후 페이드아웃 (인풋 닫혀있을 때만)
  const timer = setTimeout(() => {
    if (!chatInputOpen) div.style.transition = 'opacity 1s';
    if (!chatInputOpen) div.style.opacity = '0';
    setTimeout(() => div.remove(), 1000);
  }, 7000);
  _chatMsgTimers.push(timer);
  // 채팅창 잠깐 보이기
  showChatBox();
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
// 닉네임/방이름 sanitize: HTML 특수문자·제어문자 제거, 공백 정리, 길이 제한
function sanitizeNick(s, maxLen) {
  if (!s || typeof s !== 'string') return '익명';
  const clean = s.replace(/[<>'"&\x00-\x1f\x7f]/g, '').trim();
  return clean.slice(0, maxLen || 16) || '익명';
}

let _chatBoxTimer = null;
function showChatBox() {
  chatBox.classList.add('visible');
  clearTimeout(_chatBoxTimer);
  if (!chatInputOpen) {
    _chatBoxTimer = setTimeout(() => {
      if (!chatInputOpen) chatBox.classList.remove('visible');
    }, 8000);
  }
}

// 채팅 입력창 열기/닫기
function openChatInput() {
  if (!myRoomId || !isChatAllowedScreen()) return;
  chatInputOpen = true;
  chatBox.classList.add('visible');
  chatInputWrap.classList.add('active');
  chatHint.style.display = 'none';
  chatInput.value = '';
  // 채팅 열 때 포인터락 해제 (마우스 커서 풀기)
  if (document.pointerLockElement) document.exitPointerLock();
  setTimeout(() => chatInput.focus(), 50);
  // 메시지 모두 불투명하게 (fade 취소)
  chatMessages.querySelectorAll('.chat-msg').forEach(m => { m.style.opacity='1'; m.style.transition=''; });
}

function closeChatInput() {
  chatInputOpen = false;
  chatInputWrap.classList.remove('active');
  chatHint.style.display = '';
  chatInput.blur();
  // 인풋 닫으면 타이머 재시작
  _chatBoxTimer = setTimeout(() => chatBox.classList.remove('visible'), 5000);
}

// 메시지 전송
let _lastChatTime = 0;
const CHAT_COOLDOWN = 1500; // 채팅 1.5초 쿨다운 (스팸 방지)
async function sendChatMsg() {
  const text = chatInput.value.trim();
  if (!text || !myRoomId || !myUid) return;
  // 채팅 rate limit
  const nowChat = Date.now();
  if (nowChat - _lastChatTime < CHAT_COOLDOWN) return;
  _lastChatTime = nowChat;
  // 내용 검증: 길이 제한 + 특수문자 필터
  const safeText = text.slice(0, 60);
  if (!safeText) return;
  chatInput.value = '';
  try {
    const chatRef = ref(fbDb, 'rooms/' + myRoomId + '/chat');
    await push(chatRef, {
      uid: myUid,
      nick: sanitizeNick(myNick || '익명', 16),
      text: safeText,
      at: nowChat
    });
  } catch(e) { console.warn('채팅 전송 실패:', e); }
}

// Firebase 채팅 구독
function subscribeChat(roomId) {
  if (chatUnsub) { chatUnsub(); chatUnsub = null; }
  const chatRef = query(ref(fbDb, 'rooms/' + roomId + '/chat'), limitToLast(50));
  let firstLoad = true;
  chatUnsub = onChildAdded(chatRef, snap => {
    const d = snap.val();
    if (!d) return;
    if (firstLoad) { firstLoad = false; return; } // 첫 로드 기존 메시지 스킵
    const isMine = d.uid === myUid;
    addChatMsg(isMine ? '나' : sanitizeNick(d.nick || '?', 16), d.text?.slice(0,200) || '', false);
  });
}

// 채팅 구독 해제
function unsubscribeChat() {
  if (chatUnsub) { chatUnsub(); chatUnsub = null; }
  chatMessages.innerHTML = '';
  chatBox.classList.remove('visible');
  chatInputOpen = false;
  chatInputWrap.classList.remove('active');
}

// 버튼 이벤트
chatSendBtn.addEventListener('click', () => {
  sendChatMsg();
  chatInput.focus();
});
chatInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); sendChatMsg(); }
  if (e.key === 'Escape') { closeChatInput(); }
  e.stopPropagation(); // 게임 키 입력 막기
});
chatInput.addEventListener('keyup', e => e.stopPropagation());
chatInput.addEventListener('keypress', e => e.stopPropagation());

// 채팅 가능한 화면 (게임/방/투표/뽑기)
const CHAT_ALLOWED_SCREENS = ['game', 'lobby', 'vote', 'draw'];
function isChatAllowedScreen() { return CHAT_ALLOWED_SCREENS.includes(currentScreen); }

// Enter 키로 채팅 열기 (허용 화면 + 인풋 닫혀있을 때)
addEventListener('keydown', e => {
  if (e.key === 'Enter' && isChatAllowedScreen() && !chatInputOpen && !paintMode) {
    // 방목록/닉입력에서는 그 화면의 Enter 로직이 우선
    const active = document.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return;
    e.preventDefault();
    openChatInput();
  }
  if (e.key === 'Escape' && chatInputOpen) {
    closeChatInput();
  }
});

// ★ 게임 중 마우스 클릭 → 채팅 닫기 + 포인터락 재잠금
renderer.domElement.addEventListener('mousedown', (e) => {
  if (currentScreen !== 'game') return;
  if (paintMode) return;
  // 채팅 인풋이 열려있으면 닫고 포인터락 재잠금
  if (chatInputOpen) {
    closeChatInput();
    setTimeout(() => {
      lockPointer();
    }, 30);
    return;
  }
  // 채팅이 닫혀있고 포인터락도 없으면 재잠금
  if (!pointerLocked) {
    setTimeout(() => lockPointer(), 100);
  }
});

// ================ Animate ================
let _animRunning = true;
// ===== 카메라 줌 변수 (animate보다 먼저 선언해야 TDZ 안 남) =====
let _camZoom = 6;
let _lastGunCheck = 0;
let _blinkCheckFrame = 0, _needBlinkCache = false;
const CAM_ZOOM_MIN = 2;
const CAM_ZOOM_MAX = 20;

// ★ 카메라 벽 체크용 재사용 객체 (매 프레임 new 방지)
const _camFocusPt = new THREE.Vector3();
const _idealCamPt = new THREE.Vector3();
const _camToFocus = new THREE.Vector3();
const _camRc = new THREE.Raycaster();

function animate() {
  if (!_animRunning) return;
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  // ★ 포즈 애니메이션 mixer 갱신
  if (selfMixer) selfMixer.update(dt);
  // ★ 최적화: 화면 밖/멀리 있는 다른 플레이어는 mixer 스킵 (fog 밖은 이미 visible=false)
  otherMixers.forEach((m, uid) => {
    const op = otherPlayers[uid];
    if (!op || !op.group || op.group.visible !== false) m.mixer.update(dt);
  });
  // ★ 분신 애니메이션 mixer 갱신 (포즈 모션 공유)
  if (window._decoys) {
    for (const key in window._decoys) {
      const dec = window._decoys[key];
      if (dec && dec.mixer && (!dec.group || dec.group.visible !== false)) dec.mixer.update(dt);
    }
  }
  const _frameNow = Date.now(); // 매 프레임 1회만 호출
  if (mixer) mixer.update(dt);
  // ★ 최적화: 게임 화면 아닐 때 물리/연산 완전 스킵
  if (currentScreen !== 'game') return;
  updateDustBursts(dt);
  updateSplats(dt);
  clampPlayerToBounds();
  enforceSafePosition(); // ★ 벽에 파묻혔으면 마지막 안전 위치로 순간 복구 (절대 낑김 방지)
  // 총 부착 watchdog - 500ms throttle (매 프레임 불필요)
  if (!_lastGunCheck || _frameNow - _lastGunCheck > 500) {
    _lastGunCheck = _frameNow;
    ensureGunAttached();
  }

  // 다른 플레이어 lerp + 빨간 깜빡임 처리
  const roomNow = _cachedRoom;
  const isEnded = roomNow && roomNow.state === 'ended';
  const aliveMap = roundState?.alive || {};
  // ★ 최적화: blinkPhase - 200ms마다 needBlink 재계산 (Object.values 할당 회피)
  if (!_blinkCheckFrame || _frameNow - _blinkCheckFrame > 200) {
    _blinkCheckFrame = _frameNow;
    let hasStuck = false;
    for (const uid in otherPlayers) {
      if (otherPlayers[uid].stuck === 1) { hasStuck = true; break; }
    }
    _needBlinkCache = isEnded || hasStuck;
  }
  const blinkPhase = _needBlinkCache ? (Math.sin(_frameNow * 0.012) + 1) * 0.5 : 0;
  // ★ 스냅샷 버퍼 보간: 서버 시간보다 150ms 뒤에서 렌더 → 두 스냅샷 사이 보간
  //   패킷이 100~200ms 간격으로 와도 항상 두 스냅샷 사이에 있어서 완전 부드러움
  const RENDER_DELAY_MS = 150;
  const _renderNow = performance.now();
  const _renderT = _renderNow - RENDER_DELAY_MS;
  for (const uid in otherPlayers) {
    const ot = otherPlayers[uid];
    const buf = ot.snapshots;
    if (buf && buf.length > 0) {
      // 두 스냅샷 사이 보간 위치 찾기
      let a = null, b = null;
      for (let i = buf.length - 1; i >= 0; i--) {
        if (buf[i].t <= _renderT) { a = buf[i]; b = buf[i+1] || null; break; }
      }
      let px, py, pz, pr;
      if (!a) {
        // 렌더 시간이 첫 스냅샷보다 이전 → 첫 스냅샷 사용
        a = buf[0]; px = a.x; py = a.y; pz = a.z; pr = a.r;
      } else if (!b) {
        // 렌더 시간 이후 스냅샷 없음 (패킷 늦음) → 마지막 스냅샷으로 살짝 외삽 lerp
        // 급격한 튐 방지: 목표점으로 0.2 lerp
        const ogp = ot.group.position;
        px = ogp.x + (a.x - ogp.x) * 0.2;
        py = ogp.y + (a.y - ogp.y) * 0.2;
        pz = ogp.z + (a.z - ogp.z) * 0.2;
        pr = a.r;
      } else {
        // 두 스냅샷 사이 선형 보간 — 이게 부드러움의 핵심
        const dt = b.t - a.t;
        const t = dt > 0 ? Math.max(0, Math.min(1, (_renderT - a.t) / dt)) : 0;
        px = a.x + (b.x - a.x) * t;
        py = a.y + (b.y - a.y) * t;
        pz = a.z + (b.z - a.z) * t;
        // rotation shortest-path 보간
        let dr = b.r - a.r;
        dr = ((dr + Math.PI) % (Math.PI*2)) - Math.PI;
        pr = a.r + dr * t;
      }
      const _dx = px - player.position.x;
      const _dz = pz - player.position.z;
      const _distSq = _dx*_dx + _dz*_dz;
      if (_distSq > 5625) {
        ot.group.position.set(px, py, pz);
        ot.group.rotation.y = pr;
        if (ot.group.visible) ot.group.visible = false;
      } else {
        if (!ot.group.visible) ot.group.visible = true;
        ot.group.position.set(px, py, pz);
        if (_distSq < 900) {
          ot.group.rotation.y = pr;
        }
      }
      // 오래된 스냅샷 정리 (렌더 시간에서 500ms 이상 오래된 건 제거, 최소 2개 유지)
      while (buf.length > 2 && buf[1].t < _renderT - 500) buf.shift();
    }
    const shouldBlink = ot.stuck === 1 || (isEnded && aliveMap[uid] !== false);
    // idle이고 이전에도 idle이면 아무것도 안 함
    if (!shouldBlink && !ot._wasBlinking) continue;
    // mesh 캐시 (traverse 1회만)
    if (!ot._meshes && ot.charMesh) {
      ot._meshes = [];
      ot.charMesh.traverse(o => { if (o.isMesh && o.material && o.material.emissive) ot._meshes.push(o); });
    }
    if (ot._meshes) {
      const r = shouldBlink ? blinkPhase * 0.9 : 0;
      // 게임 종료 깜빡임: 구조물 뚫고 보이게 (x-ray)
      const xray = isEnded && aliveMap[uid] !== false;
      for (let i = 0; i < ot._meshes.length; i++) {
        const mat = ot._meshes[i].material;
        mat.emissive.setRGB(r, 0, 0);
        if (xray !== mat._xrayOn) {
          mat.depthTest = !xray;
          mat.depthWrite = !xray;
          ot._meshes[i].renderOrder = xray ? 999 : 0;
          mat._xrayOn = xray;
          mat.needsUpdate = true;
        }
      }
    }
    ot._wasBlinking = shouldBlink;
  }
  // 내 캐릭터 깜빡임 (throttle - isStuckInWall 매프레임 X)
  //   ★ 자동 밀어내기 로직 제거됨 — enforceSafePosition 롤백이 담당
  //     (밀어내기가 등반 중 벽에서 자꾸 떼어놔서 "붙잡힌 느낌" 유발)
  //     여기선 시각 피드백(빨간 깜빡임)만 처리
  {
    const now = _frameNow;
    if (!window._lastStuckCheck || now - window._lastStuckCheck > 500) {
      window._lastStuckCheck = now;
      const justLanded = window._justLandedAt && (now - window._justLandedAt < 400);
      // ★ 등반 중이면 stuck 표시 안 함 (벽 붙는 게 정상)
      window._myStuck = (!justLanded && !isClimbing && collidableMeshes && collidableMeshes.length) ? isStuckInWall() : false;
    }
    const shouldBlinkMe = window._myStuck || (isEnded && aliveMap[myUid] !== false);
    if (shouldBlinkMe || player._wasBlinking) {
      if (!player._meshes && currentPoseGlb) {
        player._meshes = [];
        currentPoseGlb.traverse(o => { if (o.isMesh && o.material && o.material.emissive) player._meshes.push(o); });
      }
      if (player._meshes) {
        const r = shouldBlinkMe ? blinkPhase * 0.9 : 0;
        const xrayMe = isEnded && aliveMap[myUid] !== false;
        for (let i = 0; i < player._meshes.length; i++) {
          const mat = player._meshes[i].material;
          mat.emissive.setRGB(r, 0, 0);
          if (xrayMe !== mat._xrayOn) {
            mat.depthTest = !xrayMe;
            mat.depthWrite = !xrayMe;
            player._meshes[i].renderOrder = xrayMe ? 999 : 0;
            mat._xrayOn = xrayMe;
            mat.needsUpdate = true;
          }
        }
      }
    }
    player._wasBlinking = shouldBlinkMe;
  }

  // 입력 - 숨는 시간에 술래는 움직임 금지, 관전 중엔 아무도 못 움직임
  const canMove = !paintMode && !(inHidePhase && myRole === 'seeker') && !spectatorMode;
  if (canMove) {
    const running = keys['ShiftLeft'] || keys['ShiftRight'];
    const speed = (running ? 22 : 10) * dt;
    let mx = 0, mz = 0;
    if (keys['KeyW']) mz -= 1;
    if (keys['KeyS']) mz += 1;
    if (keys['KeyA']) mx -= 1;
    if (keys['KeyD']) mx += 1;
    const mag = Math.hypot(mx, mz);
    if (mag > 0) {
      mx /= mag; mz /= mag;
      const sy = Math.sin(cameraYaw), cy = Math.cos(cameraYaw);
      const wx = mx*cy + mz*sy, wz = -mx*sy + mz*cy;
      tryMove(wx*speed, wz*speed);
      const tr = Math.atan2(wx, wz) + Math.PI;
      let d = tr - player.rotation.y;
      while (d > Math.PI) d -= Math.PI*2;
      while (d < -Math.PI) d += Math.PI*2;
      player.rotation.y += d * Math.min(1, dt*10);
    }
  }

  // ★ 슬라이드 적용 (앉기 계열 포즈 발동 시 1.5초 미끄러짐)
  const nowMs = performance.now();
  if (nowMs < _slideEndTime) {
    const remaining = (_slideEndTime - nowMs) / SLIDE_DURATION_MS; // 1 → 0
    const factor = remaining * remaining; // 처음 빠르고 뒤로 갈수록 느려짐
    tryMove(_slideVX * factor * dt, _slideVZ * factor * dt);
  }

  // 벽 타기 판정 — 공중 상태에서 벽 근처 + 스페이스 누를 때만 붙음
  // ★ 버그 수정: 스페이스 없이는 벽에 붙지 않음 (자동 달라붙기 제거)
  const MAX_CLIMB_Y = 12;
  const spaceHeld = keys['Space'];
  // ★ 이동 중(WASD)이거나 속도가 아래로 심하게 빠르면 climbing 해제 (탈출 가능하게)
  const isMovingHoriz = (keys['KeyW'] || keys['KeyS'] || keys['KeyA'] || keys['KeyD']);
  const nearWall = !isGrounded && !paintMode && player.position.y < MAX_CLIMB_Y && spaceHeld ? checkNearWall() : false;
  if (nearWall && spaceHeld) {
    isClimbing = true;
  } else {
    // ★ 벽에서 떨어질 때: 스페이스 뗀 순간 살짝 반동 주어 자연스럽게 이탈
    if (isClimbing && !spaceHeld) {
      velocityY = Math.max(velocityY, 2); // 살짝 위로 튕겨서 이탈
    }
    isClimbing = false;
  }

  // 물리
  if (isClimbing) {
    velocityY = CLIMB_SPEED; // 스페이스 홀드 시 위로 오름 (항상)
  } else {
    velocityY += GRAVITY * dt;
  }
  // ★ 벨로시티 캡: 이상값 방지 (갑작스런 튕김 방지)
  if (velocityY > 15) velocityY = 15;
  if (velocityY < -40) velocityY = -40;
  // ★ 천장 체크: 위로 이동 중일 때 머리 위 벽 있으면 상승 중단 (지붕 뚫림 방지)
  if (velocityY > 0 && _nearbyColliders.length > 0) {
    _ceilOrigin.set(player.position.x, player.position.y + 1.7, player.position.z);
    _ceilRc.set(_ceilOrigin, _upV);
    _ceilRc.far = 0.4 + velocityY * dt;
    if (_ceilRc.intersectObjects(_nearbyColliders, false).length > 0) {
      velocityY = 0;
      isClimbing = false;
    }
  }
  // ★ Y 이동량 캡: 한 프레임에 최대 1m 만 이동 (프레임 스킵/버그로 인한 순간이동 방지)
  const deltaY = velocityY * dt;
  const clampedDeltaY = Math.max(-0.4, Math.min(0.4, deltaY)); // 한 프레임 최대 이동량 축소 → 프레임 드랍 시 바닥 통과 방지
  player.position.y += clampedDeltaY;
  
  // 매 프레임 바닥 감지 (단순: null이면 이전값 유지)
  const rawGY = getGroundHeight(player.position.x, player.position.z);
  if (rawGY !== null) cachedGroundY = rawGY;
  if (cachedGroundY === null) cachedGroundY = -9999;
  const gY = cachedGroundY;
  const wasAirborne = !isGrounded;
  if (player.position.y <= gY) {
    player.position.y = gY; velocityY = 0; isGrounded = true; isClimbing = false;
    _lastSolidGroundY = gY;
    if (wasAirborne) window._justLandedAt = performance.now();
  }
  else if (player.position.y > gY + 0.1) isGrounded = false;
  
  // 안전망: 너무 낮이 지면 마지막 바닥 위로 복귀
  if (player.position.y < -50 || !isFinite(player.position.y)) {
    const safeY = (_lastSolidGroundY !== null) ? _lastSolidGroundY + 3 : 10;
    player.position.y = safeY;
    velocityY = 0;
    cachedGroundY = null;
  }

  // ★ 끼임 자동 탈출: 오래 끼어있으면 위로 순간이동
  if (!window._stuckSince) window._stuckSince = 0;
  if (window._myStuck) {
    if (!window._stuckSince) window._stuckSince = _frameNow;
    else if (_frameNow - window._stuckSince > 1200) {
      // 1.2초 이상 끼임 → 위로 탈출 (빠르게 풀어줌)
      player.position.y += 3;
      velocityY = 5;
      cachedGroundY = null;
      window._stuckSince = 0;
      console.warn('🚨 끼임 탈출 → 위로 이동');
    }
  } else {
    window._stuckSince = 0;
  }

  // 카메라 - 관전 모드면 타겟 플레이어 따라가기
  if (spectatorMode && spectatorTargetUid && otherPlayers[spectatorTargetUid]) {
    const tgt = otherPlayers[spectatorTargetUid];
    const tx = tgt.group.position.x, ty = tgt.group.position.y, tz = tgt.group.position.z;
    const tHeadY = 1.55;
    const camDist = _camZoom;
    const focusY = ty + tHeadY;
    const hd = camDist * Math.cos(cameraPitch);
    const vo = camDist * Math.sin(cameraPitch);
    const specIdealX = tx + Math.sin(cameraYaw) * hd;
    const specIdealZ = tz + Math.cos(cameraYaw) * hd;
    const specIdealY = Math.max(0.5, focusY + vo);
    if (collidableMeshes.length > 0) {
      _camFocusPt.set(tx, focusY, tz);
      _idealCamPt.set(specIdealX, specIdealY, specIdealZ);
      _camToFocus.subVectors(_idealCamPt, _camFocusPt).normalize();
      const _specDist = _camFocusPt.distanceTo(_idealCamPt);
      _camRc.set(_camFocusPt, _camToFocus);
      _camRc.near = 0.1;
      _camRc.far = _specDist + 0.5;
      const _specHits = _camRc.intersectObjects(_nearbyColliders, false);
      if (_specHits.length > 0) {
        const safeDist = Math.max(0, _specHits[0].distance - 0.3);
        camera.position.copy(_camFocusPt).addScaledVector(_camToFocus, safeDist);
      } else {
        camera.position.set(specIdealX, specIdealY, specIdealZ);
      }
    } else {
      camera.position.set(specIdealX, specIdealY, specIdealZ);
    }
    camera.lookAt(tx, focusY - 0.3, tz);
  } else {
  // 카메라 - 3인칭 (현재 포즈의 머리 위치에 정확히 맞춤)
  const headY = poseHeadY[currentPose] || 1.5;
  const camDist = paintMode ? 4 : _camZoom;
  const focusY = player.position.y + headY;
  const hd = camDist * Math.cos(cameraPitch);
  const vo = camDist * Math.sin(cameraPitch);
  const idealCamX = player.position.x + Math.sin(cameraYaw) * hd;
  const idealCamZ = player.position.z + Math.cos(cameraYaw) * hd;
  const idealCamY = Math.max(0.5, focusY + vo);

  // 카메라 벽 체크 - 원래 코드 (단순)
  if (collidableMeshes.length > 0) {
    _camFocusPt.set(player.position.x, focusY, player.position.z);
    _idealCamPt.set(idealCamX, idealCamY, idealCamZ);
    _camToFocus.subVectors(_idealCamPt, _camFocusPt).normalize();
    const _camDist = _camFocusPt.distanceTo(_idealCamPt);
    _camRc.set(_camFocusPt, _camToFocus);
    _camRc.near = 0.1;
    _camRc.far = _camDist + 0.5;
    const _camHits = _camRc.intersectObjects(_nearbyColliders, false);
    if (_camHits.length > 0) {
      const safeDist = Math.max(0, _camHits[0].distance - 0.3);
      camera.position.copy(_camFocusPt).addScaledVector(_camToFocus, safeDist);
    } else {
      camera.position.set(idealCamX, idealCamY, idealCamZ);
    }
    if (camera.position.distanceTo(_camFocusPt) < 0.5) {
      camera.position.copy(_camFocusPt).addScaledVector(_camToFocus, 0.5);
    }
  } else {
    camera.position.set(idealCamX, idealCamY, idealCamZ);
  }
  camera.lookAt(player.position.x, focusY - 0.3, player.position.z);
  }

  // 게임 화면(인게임)일 때만 렌더
  if (currentScreen === 'game') renderer.render(scene, camera);
  // ★ 최적화: 포즈휠 닫혀 있으면 함수 호출조차 스킵
  if (poseWheelOpen) renderPoseWheel();
  renderHomePreview();
}

// ===== 마우스 휠 줌 =====
// (변수 선언은 animate 함수 위로 이동함 - TDZ 방지)

// animate 에서 참조하는 변수들은 모두 위에 선언 완료
animate();

// 탭 숨겨지면 렌더 완전 정지
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { _animRunning = false; }
  else { if (!_animRunning) { _animRunning = true; requestAnimationFrame(animate); } }
});

// ★ 페이지 언로드 시 렌더 타겟 해제
window.addEventListener('beforeunload', () => {
  try { if (_poseWheelRT) _poseWheelRT.dispose(); } catch(e) {}
  try { if (_homeRT) _homeRT.dispose(); } catch(e) {}
});

let _resizeTimer = null;
addEventListener('resize', () => {
  clearTimeout(_resizeTimer);
  _resizeTimer = setTimeout(() => {
    camera.aspect = innerWidth/innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  }, 100);
});

addEventListener('wheel', e => {
  if (currentScreen !== 'game' || paintMode) return;
  e.preventDefault();
  _camZoom += e.deltaY * 0.01;
  _camZoom = Math.max(CAM_ZOOM_MIN, Math.min(CAM_ZOOM_MAX, _camZoom));
}, { passive: false });
