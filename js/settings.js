const Settings = (() => {
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

        ${issin ? `
        <div class="section-title">記錄還款</div>
        <div class="card">
          <div class="settings-row">
            <span class="settings-label">Bear 還款金額</span>
          </div>
          <div class="settings-row" style="gap:8px;flex-wrap:wrap">
            <input type="number" id="settle-amount" placeholder="金額" min="1" step="1"
              style="flex:1;min-width:100px;padding:6px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--text-primary);font-size:15px">
            <input type="text" id="settle-note" placeholder="備註（選填）"
              style="flex:2;min-width:140px;padding:6px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--text-primary);font-size:15px">
          </div>
          <div id="settle-err" class="error-msg hidden" style="margin-top:6px"></div>
          <button class="btn-primary" id="settle-submit" style="margin-top:10px;width:100%">記錄還款</button>
        </div>
        ` : ''}

        <div class="section-title">資料</div>
        <div class="card">
          <div class="settings-row">
            <span class="settings-label">試算表 ID</span>
            <span class="settings-val settings-mono">${CONFIG.SHEET_ID.slice(0, 16)}…</span>
          </div>
        </div>

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

    const submitBtn = document.getElementById('settle-submit');
    if (submitBtn) {
      submitBtn.addEventListener('click', async () => {
        const amount = parseFloat(document.getElementById('settle-amount').value);
        const note   = document.getElementById('settle-note').value.trim();
        const errEl  = document.getElementById('settle-err');
        errEl.classList.add('hidden');
        if (!amount || amount <= 0) {
          errEl.textContent = '請輸入有效金額';
          errEl.classList.remove('hidden');
          return;
        }
        submitBtn.disabled    = true;
        submitBtn.textContent = '寫入中…';
        try {
          await Sheets.appendSettlementRow(amount, note);
          document.getElementById('settle-amount').value = '';
          document.getElementById('settle-note').value   = '';
          await _loadSettlement();
          alert('✓ 還款記錄已儲存');
        } catch (e) {
          errEl.textContent = '寫入失敗：' + e.message;
          errEl.classList.remove('hidden');
        } finally {
          submitBtn.disabled    = false;
          submitBtn.textContent = '記錄還款';
        }
      });
    }

    _loadSettlement();
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
