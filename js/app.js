if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

document.addEventListener('DOMContentLoaded', () => {
  const verEl = document.getElementById('login-version');
  if (verEl) verEl.textContent = `v${CONFIG.APP_VERSION}`;

  Auth.init((email) => {
    document.getElementById('screen-login').classList.add('hidden');
    document.getElementById('screen-app').classList.remove('hidden');

    const inited = new Set();
    const tabModules = { home: Home, ledger: Ledger, pending: Pending, stats: Stats };

    Router.init();

    Router.onNavigate = (tab) => {
      if (!inited.has(tab) && tabModules[tab]) {
        tabModules[tab].init();
        inited.add(tab);
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
