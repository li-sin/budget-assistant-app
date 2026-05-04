const Router = (() => {
  let currentTab = 'home';
  let onNavigate = null;

  function navigate(tab) {
    document.querySelectorAll('.tab-content').forEach(el => el.classList.add('hidden'));
    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));

    const content = document.getElementById(`tab-${tab}`);
    const navBtn  = document.querySelector(`.nav-item[data-tab="${tab}"]`);
    if (content) content.classList.remove('hidden');
    if (navBtn)  navBtn.classList.add('active');

    currentTab = tab;
    if (onNavigate) onNavigate(tab);
  }

  function init() {
    document.querySelectorAll('.nav-item').forEach(btn => {
      btn.addEventListener('click', () => navigate(btn.dataset.tab));
    });
  }

  return {
    init, navigate,
    get current()    { return currentTab; },
    set onNavigate(fn) { onNavigate = fn; },
  };
})();
