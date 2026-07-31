// ============================================================
// firebase.js — Firebase 초기화 + 익명 로그인
// 다른 파일이 import: fbApp, fbAuth, fbDb, myUid (live binding)
// ============================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getAuth, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { getDatabase } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";

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

// myUid 은 live binding 으로 export — 여기서만 재할당, 다른 파일은 읽기만 함
export let myUid = null;

// 랜덤 UID 생성기 (Firebase 실패 시 폴백)
function genRandomUid() {
  return 'guest_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

// 초기 화면 표시
document.getElementById('scr-nick').classList.remove('hidden');

// 로그인 상태 변화 감지
onAuthStateChanged(fbAuth, u => {
  if (u) { myUid = u.uid; console.log('✅ Firebase 로그인:', myUid); }
});

// 익명 로그인 시도, 실패 시 랜덤 UID
signInAnonymously(fbAuth)
  .then(cred => { myUid = cred.user.uid; console.log('✅ 익명 로그인 성공'); })
  .catch(e => {
    console.warn('⚠️ Firebase auth 실패 (콘솔에서 Anonymous 활성화 필요). 게스트 모드로 전환:', e.code);
    myUid = genRandomUid();
    console.log('🎮 게스트 UID:', myUid);
  });
