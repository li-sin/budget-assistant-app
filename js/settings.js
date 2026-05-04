const Settings = (() => {
  function _fmt(n) {
    const abs = '$' + Math.abs(n).toLocaleString('zh-TW');
    if (n > 0)  return `Bear 欠 Sin ${abs}`;
    if (n < 0)  return `Sin 欠 Bear ${abs}`;
    return '已結清 ✓';
  }

  async function _loadSettlement() {
    const el = document.getElementById('settings-settlement');
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

  function _buildShell() {
    const email = Auth.getEmail() || '—';
    const issin = CONFIG.EMAIL_WHITELIST[0] === email;

    document.getElementById('tab-settings').innerHTML = `
      <div class="section-title">帳戶</div>
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
      </div>

      <div class="settings-logout-wrap">
        <button class="btn-logout" id="settings-logout">登出</button>
      </div>
    `;

    document.getElementById('settings-refresh').addEventListener('click', _loadSettlement);
    document.getElementById('settings-logout').addEventListener('click', () => {
      if (confirm('確定登出？')) Auth.logout();
    });
  }

  function init() {
    _buildShell();
    _loadSettlement();
  }

  return { init };
})();
