if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

// ── 備註快速選項 ─────────────────────────────────────
const NoteChips = (() => {
  const LS_KEY = 'budget_note_chips';

  function getCustom() {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || '[]'); }
    catch { return []; }
  }

  function all() { return [...CONFIG.DEFAULT_NOTE_CHIPS, ...getCustom()]; }

  function add(label) {
    label = label.trim();
    if (!label) return false;
    const chips = getCustom();
    if (CONFIG.DEFAULT_NOTE_CHIPS.includes(label) || chips.includes(label)) return false;
    chips.push(label);
    localStorage.setItem(LS_KEY, JSON.stringify(chips));
    return true;
  }

  function remove(label) {
    localStorage.setItem(LS_KEY, JSON.stringify(getCustom().filter(c => c !== label)));
  }

  function render(inputId) {
    const input = document.getElementById(inputId);
    if (!input) return;
    const next = input.nextElementSibling;
    if (next?.classList.contains('note-chip-row')) next.remove();
    const chips = all();
    if (!chips.length) return;
    const row = document.createElement('div');
    row.className = 'note-chip-row chip-row';
    row.innerHTML = chips.map(c =>
      `<button type="button" class="chip note-chip" data-chip="${c}">${c}</button>`
    ).join('');
    input.after(row);
    row.querySelectorAll('.note-chip').forEach(btn => {
      btn.addEventListener('click', () => {
        const inp = document.getElementById(inputId);
        if (!inp) return;
        const cur = inp.value.trim();
        inp.value = cur ? cur + ' ' + btn.dataset.chip : btn.dataset.chip;
      });
    });
  }

  return { all, getCustom, add, remove, render };
})();
window.NoteChips = NoteChips;

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
