if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

window.AppMonth = (() => {
  const now = new Date();
  let _y = now.getFullYear(), _m = now.getMonth() + 1;
  function get() { return { year: _y, month: _m }; }
  function set(y, m) { _y = y; _m = m; }
  return { get, set };
})();

document.addEventListener('DOMContentLoaded', () => {
  const verEl = document.getElementById('login-version');
  if (verEl) verEl.textContent = `v${CONFIG.APP_VERSION}`;

  Auth.init((email) => {
    document.getElementById('screen-login').classList.add('hidden');
    document.getElementById('screen-app').classList.remove('hidden');

    const inited = new Set();
    const tabModules = { home: Home, ledger: Ledger, stats: Stats, pending: Pending };

    Router.init();

    Router.onNavigate = (tab) => {
      if (!inited.has(tab) && tabModules[tab]) {
        tabModules[tab].init();
        inited.add(tab);
      } else if (inited.has(tab) && tabModules[tab]?.activate) {
        tabModules[tab].activate(window.AppMonth.get());
      }
    };

    window.Home     = Home;
    window.Ledger   = Ledger;
    window.Settings = Settings;

    // 初始化首頁
    tabModules.home.init();
    inited.add('home');
  });
});
