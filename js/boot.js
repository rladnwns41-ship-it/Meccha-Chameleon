// ============================================================
// boot.js — 게임 시작 전/후 실행되는 작은 유틸들
// ============================================================
'use strict';

// ============================================================
// 보안 강화 (CSP 백업 계층 - 오래된 브라우저나 CSP 무시되는 경우 대비)
// ============================================================
(function(){
  // ★ 클릭재킹 방지: 다른 사이트 iframe 안에 심어지면 최상위로 강제 이동
  //   CSP의 frame-ancestors 'none' 을 무시하는 옛 브라우저 방어망
  try {
    if (self !== top) {
      // 백업 방어: 콘텐츠 숨김 후 최상위로 리다이렉트
      document.documentElement.style.display = 'none';
      top.location = self.location;
    }
  } catch (e) {
    // 크로스오리진 프레임 접근 실패 = 임베딩 시도 → 콘텐츠 숨김
    document.documentElement.style.display = 'none';
  }

  // ★ Prototype 오염 방지는 CSP(외부 스크립트 차단) 와 strict mode 로 이미 커버됨
  //   Object.prototype freeze 는 라이브러리 호환성 위험이 있어 제거
})();

// ★ 렉 감소: console.log/debug/info 최상단에서 노-옵화
// (hot path 에서 log 인자 문자열 조립 오버헤드까지 없앰)
(function(){
  const noop = () => {};
  try { console.log = noop; console.debug = noop; console.info = noop; console.trace = noop; } catch(e){}
})();

// 탭 백그라운드일 때 CSS 애니 일시정지 → CPU 절약
(function(){
  document.addEventListener('visibilitychange', () => {
    document.documentElement.style.animationPlayState =
      document.hidden ? 'paused' : 'running';
    document.querySelectorAll('.btn,.cta,.voteMap,.nick-chip').forEach(el => {
      el.style.animationPlayState = document.hidden ? 'paused' : 'running';
    });
  });
  // reduced-motion 자동 감지 시 위글 강제 정지 (이미 있지만 안전망)
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    document.documentElement.classList.add('rm');
  }
})();

// 어떤 스크린이 활성인지 관측 → 게임 화면일 때 body.ingame 추가
(function(){
  const OBSERVE = ['scr-nick','scr-home','scr-rooms','scr-lobby','scr-vote','scr-draw','scr-scoreboard'];
  function update(){
    let anyUi = false;
    for (const id of OBSERVE) {
      const el = document.getElementById(id);
      if (el && !el.classList.contains('hidden')) { anyUi = true; break; }
    }
    document.body.classList.toggle('ingame', !anyUi);
  }
  const mo = new MutationObserver(update);
  mo.observe(document.body, {subtree:true, attributes:true, attributeFilter:['class']});
  setTimeout(update, 500);
})();
