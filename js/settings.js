const Settings = (() => {
  function _buildCustomChipsList() {
    const chips = NoteChips.getCustom();
    if (!chips.length) return '<p class="settings-chip-empty">無自訂標籤</p>';
    return chips.map(c =>
      `<div class="note-chip-manage-row">
        <span class="chip note-chip-tag">${c}</span>
        <button class="btn-chip-delete" data-chip="${c}">✕</button>
      </div>`
    ).join('');
  }

  function _fmt(n) {
    const abs = '$' + Math.abs(n).toLocaleString('zh-TW');
    if (n > 0)  return `Bear 欠 Sin ${abs}`;
    if (n < 0)  return `Sin 欠 Bear ${abs}`;
    return '已結清 ✓';
  }

  async function _loadSettlement() {
    const el = document.getElementById('settings-settlement');
    if (!el) return;
    el.textContent = '…';
    try {
      const val = await Sheets.getSettlement();
      el.textContent = _fmt(val);
      el.className   = 'settings-settlement-val '
        + (val > 0 ? 'amount-expense' : val < 0 ? 'amount-income' : '');
    } catch (e) {
      if (e.message !== 'auth_expired') el.textContent = '讀取失敗';
    }
  }

  function _currentYm() {
    const { year, month } = window.AppMonth?.get() || {
      year: new Date().getFullYear(),
      month: new Date().getMonth() + 1,
    };
    return { year, month, label: `${year}-${String(month).padStart(2, '0')}` };
  }

  function _renderCardStatus(rows) {
    return rows.map(({ bank, count }) => `
      <div class="settings-bank-row">
        <span class="settings-bank-name">${bank}</span>
        <span class="settings-bank-val ${count ? '' : 'settings-bank-empty'}">
          ${count ? `${count} 筆` : '未到'}
        </span>
      </div>
    `).join('');
  }

  async function _loadCardStatus() {
    const el = document.getElementById('settings-card-status');
    const monthEl = document.getElementById('settings-card-month');
    if (!el) return;
    const { year, month, label } = _currentYm();
    if (monthEl) monthEl.textContent = label;
    el.innerHTML = '<div class="settings-bank-loading">讀取中…</div>';
    try {
      el.innerHTML = _renderCardStatus(await Sheets.getCreditCardImportStatus(year, month));
    } catch (e) {
      if (e.message !== 'auth_expired') {
        el.innerHTML = '<div class="settings-bank-loading">讀取失敗</div>';
      }
    }
  }

  function _buildContent() {
    const email = Auth.getEmail() || '—';
    const issin = email === CONFIG.EMAIL_WHITELIST[0];
    return `
      <div class="modal-header">
        <span class="modal-title">⚙️ 設定</span>
        <button class="modal-close" id="settings-close">✕</button>
      </div>
      <div class="modal-body">
        <div class="section-title" style="margin-top:0">帳戶</div>
        <div class="card">
          <div class="settings-row">
            <span class="settings-label">登入帳號</span>
            <span class="settings-val">${email}</span>
          </div>
          <div class="settings-row">
            <span class="settings-label">身份</span>
            <span class="settings-val">${issin ? '🌟 Sin' : '🐨 Bear'}</span>
          </div>
        </div>

        <div class="section-title">結算</div>
        <div class="card">
          <div class="settings-row">
            <span class="settings-label">Bear 結算（累計淨額）</span>
            <button class="month-btn refresh-btn" id="settings-refresh" title="重新載入">↺</button>
          </div>
          <div id="settings-settlement" class="settings-settlement-val">…</div>
        </div>


        <div class="section-title">資料</div>
        <div class="card">
          <div class="settings-row">
            <span class="settings-label">試算表 ID</span>
            <span class="settings-val settings-mono">${CONFIG.SHEET_ID.slice(0, 16)}…</span>
          </div>
          <div class="settings-row settings-row-stack">
            <div class="settings-row-head">
              <span class="settings-label">信用卡匯入狀態</span>
              <span class="settings-val" id="settings-card-month">—</span>
            </div>
            <div id="settings-card-status" class="settings-bank-list">
              <div class="settings-bank-loading">讀取中…</div>
            </div>
          </div>
        </div>

        ${issin ? `
        <div class="section-title">備註快速選項</div>
        <div class="card" id="note-chips-card">
          <div class="note-chip-manage-row">
            ${CONFIG.DEFAULT_NOTE_CHIPS.map(c => `<span class="chip note-chip-tag">${c}</span>`).join('')}
            <span class="settings-label-sub">預設</span>
          </div>
          <div id="custom-chips-list">${_buildCustomChipsList()}</div>
          <div class="note-chip-add-row">
            <input type="text" id="new-chip-input" class="field-input" placeholder="新增自訂標籤">
            <button class="btn-primary" id="new-chip-add">新增</button>
          </div>
        </div>
        ` : ''}

        <div class="settings-logout-wrap">
          <button class="btn-logout" id="settings-logout">登出</button>
        </div>
        <p class="settings-version">v${CONFIG.APP_VERSION}</p>
      </div>
    `;
  }

  function open() {
    const sheet = document.getElementById('settings-sheet');
    const modal = document.getElementById('settings-modal');
    if (!sheet || !modal) return;
    sheet.innerHTML = _buildContent();
    modal.classList.remove('hidden');

    document.getElementById('settings-close').addEventListener('click', close);
    modal.addEventListener('click', e => { if (e.target === modal) close(); });
    document.getElementById('settings-refresh').addEventListener('click', _loadSettlement);
    document.getElementById('settings-logout').addEventListener('click', () => {
      if (confirm('確定登出？')) Auth.logout();
    });

    // 備註快速選項管理（Sin Only）
    const addBtn = document.getElementById('new-chip-add');
    if (addBtn) {
      const _rebindDeletes = () => {
        document.querySelectorAll('#note-chips-card .btn-chip-delete').forEach(btn => {
          btn.addEventListener('click', () => {
            NoteChips.remove(btn.dataset.chip);
            document.getElementById('custom-chips-list').innerHTML = _buildCustomChipsList();
            _rebindDeletes();
          });
        });
      };
      addBtn.addEventListener('click', () => {
        const inp = document.getElementById('new-chip-input');
        if (NoteChips.add(inp.value)) {
          inp.value = '';
          document.getElementById('custom-chips-list').innerHTML = _buildCustomChipsList();
          _rebindDeletes();
        }
      });
      document.getElementById('new-chip-input').addEventListener('keydown', e => {
        if (e.key === 'Enter') addBtn.click();
      });
      _rebindDeletes();
    }

    _loadSettlement();
    _loadCardStatus();
  }

  function close() {
    document.getElementById('settings-modal')?.classList.add('hidden');
  }

  function init() {
    // settings 現在是 Modal，不需要 tab 初始化
  }

  return { init, open, close };
})();

window.Settings = Settings;
