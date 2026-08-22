import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import {
  getAuth, signInAnonymously, onAuthStateChanged,
  createUserWithEmailAndPassword, signInWithEmailAndPassword,
  updateProfile, signOut
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { getDatabase, ref, set, get, update } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";

const firebaseConfig = {
  apiKey: "AIzaSyBNft9WQTqrRde1avLdj0WD1SV7dZOOhSs",
  authDomain: "world-4a855.firebaseapp.com",
  databaseURL: "https://world-4a855-default-rtdb.firebaseio.com",
  projectId: "world-4a855",
  storageBucket: "world-4a855.firebasestorage.app",
  messagingSenderId: "1010314295713",
  appId: "1:1010314295713:web:78595c249ed0d7af0ef3e0",
  measurementId: "G-KGWBF4B49F"
};

export const fbApp  = initializeApp(firebaseConfig);
export const fbAuth = getAuth(fbApp);
export const fbDb   = getDatabase(fbApp);
export let myUid = null;
export let myProfile = null;

function defaultProfile(nick, isGuest) {
  return { nick: nick || '카멜레온' + Math.floor(Math.random()*999), trophy: 0, wins: 0, losses: 0, kills: 0, gamesPlayed: 0, createdAt: Date.now(), isGuest: !!isGuest };
}

async function loadOrCreateProfile(uid, displayName, isGuest) {
  try {
    const snap = await get(ref(fbDb, `users/${uid}`));
    if (snap.exists()) {
      myProfile = snap.val();
    } else {
      myProfile = defaultProfile(displayName, isGuest);
      await set(ref(fbDb, `users/${uid}`), myProfile).catch(() => {});
    }
  } catch (e) {
    console.warn('프로필 로드 실패:', e.code || e.message);
    myProfile = defaultProfile(displayName, isGuest);
  }
}

export async function saveProfile() {
  if (!myUid || !myProfile) return;
  try { await update(ref(fbDb, `users/${myUid}`), myProfile); } catch(e) {}
}

export async function recordMatch(result) {
  if (!myProfile) return;
  myProfile.gamesPlayed = (myProfile.gamesPlayed || 0) + 1;
  if (result === 'win') { myProfile.wins = (myProfile.wins || 0) + 1; myProfile.trophy = (myProfile.trophy || 0) + 30; }
  else { myProfile.losses = (myProfile.losses || 0) + 1; myProfile.trophy = Math.max(0, (myProfile.trophy || 0) - 10); }
  await saveProfile();
}

export async function addKills(n) {
  if (!myProfile) return;
  myProfile.kills = (myProfile.kills || 0) + n;
  myProfile.trophy = (myProfile.trophy || 0) + n * 5;
  await saveProfile();
}

// ★ 게스트 로그인 — 실패 시 가짜 UID 안 만듦, 에러 표시
export async function loginAsGuest() {
  try {
    const cred = await signInAnonymously(fbAuth);
    myUid = cred.user.uid;
    console.log('✅ 익명 로그인 성공:', myUid);
    await loadOrCreateProfile(myUid, null, true);
    return { ok: true };
  } catch (e) {
    console.error('❌ 익명 로그인 실패:', e.code, e.message);
    return { ok: false, error: '익명 로그인 실패: ' + (e.code || e.message) };
  }
}

export async function loginWithEmail(email, password) {
  try {
    const cred = await signInWithEmailAndPassword(fbAuth, email, password);
    myUid = cred.user.uid;
    console.log('✅ 이메일 로그인 성공:', myUid);
    await loadOrCreateProfile(myUid, cred.user.displayName, false);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.code === 'auth/invalid-credential' ? '이메일 또는 비밀번호 틀림' : (e.code || e.message) };
  }
}

export async function signUpWithEmail(email, password, nick) {
  try {
    const cred = await createUserWithEmailAndPassword(fbAuth, email, password);
    try { await updateProfile(cred.user, { displayName: nick }); } catch(e) {}
    myUid = cred.user.uid;
    console.log('✅ 회원가입 성공:', myUid);
    myProfile = defaultProfile(nick, false);
    await set(ref(fbDb, `users/${myUid}`), myProfile).catch(() => {});
    return { ok: true };
  } catch (e) {
    let msg = e.code || e.message;
    if (e.code === 'auth/email-already-in-use') msg = '이미 사용 중인 이메일';
    if (e.code === 'auth/weak-password') msg = '비밀번호 6자 이상';
    if (e.code === 'auth/invalid-email') msg = '이메일 형식 오류';
    return { ok: false, error: msg };
  }
}

export async function logOut() {
  try { await signOut(fbAuth); } catch(e) {}
  myUid = null; myProfile = null;
}

// ★ 자동 인증 복원 (새로고침 시)
onAuthStateChanged(fbAuth, async (u) => {
  if (u) {
    myUid = u.uid;
    console.log('✅ 인증 복원:', myUid, u.isAnonymous ? '(게스트)' : '(계정)');
    await loadOrCreateProfile(myUid, u.displayName, u.isAnonymous);
    // ★ 이미 인증됐으면 자동으로 방 목록 진입 가능하도록 표시
    document.body.setAttribute('data-auth', 'ready');
  } else {
    console.log('⚠️ 인증 없음 — 로그인 필요');
  }
});

document.getElementById('scr-nick').classList.remove('hidden');
