(function(){
  // 프로덕션 렉 감소: console.log 노-옵화 (warn/error는 유지)
  const noop = () => {};
  try { console.log = noop; console.debug = noop; console.info = noop; console.trace = noop; } catch(e){}
})();
