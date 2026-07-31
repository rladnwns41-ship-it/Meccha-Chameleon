// ============================================================
// boot.js — 게임 시작 전/후 실행되는 작은 유틸들
// ============================================================

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
