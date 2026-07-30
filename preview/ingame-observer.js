(function(){
  // 어떤 스크린이 활성인지 관측 → 게임 화면일 때 body.ingame 추가
  const target = document.body;
  const OBSERVE = ['scr-nick','scr-home','scr-rooms','scr-lobby','scr-vote','scr-draw','scr-scoreboard'];
  function update(){
    // OBSERVE 중 하나라도 보이면 UI 화면 → ingame off
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
