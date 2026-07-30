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
