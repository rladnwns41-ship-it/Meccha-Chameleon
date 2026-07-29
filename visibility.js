(function(){
  // 탭 백그라운드일 때 CSS 애니 일시정지 → CPU 절약
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
  // (제거) 게임 입력 호환성을 위해 passive 강제 override는 뺌
})();
