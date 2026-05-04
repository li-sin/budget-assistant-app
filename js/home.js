const Home = (() => {
  const now = new Date();
  let _year  = now.getFullYear();
  let _month = now.getMonth() + 1;

  function _fmt(n) {
    return '$' + Math.abs(n).toLocaleString('zh-TW');
  }

  function _ym() {
    return `${_year}-${String(_month).padStart(2, '0')}`;
  }

  function _updateMonthLabel() {
    document.getElementById('home-month').textContent =
      `${_year} 年 ${String(_month).padStart(2, '0')} 月`;
  }

  function _renderSummary(rows, settlement) {
    const total    = rows.reduce((s, r) => s + r.amount,    0);
    const sinTotal = rows.reduce((s, r) => s + r.sinShare,  0);
    const bearMonthly = rows.reduce((s, r) => s + r.bearShare, 0);

    document.getElementById('home-total').textContent = _fmt(total);
    document.getElementById('home-sin').textContent   = _fmt(sinTotal);
    document.getElementById('home-bear-monthly').textContent = _fmt(bearMonthly);

    const el = document.getElementById('home-settlement');
    if (settlement > 0) {
      el.textContent  = `Bear 欠 ${_fmt(settlement)}`;
      el.className    = 'settlement-val amount-expense';
    } else if (settlement < 0) {
      el.textContent  = `Sin 欠 ${_fmt(-settlement)}`;
      el.className    = 'settlement-val amount-income';
    } else {
      el.textContent  = '已結清 ✓';
      el.className    = 'settlement-val';
    }
  }

  function _renderList(rows) {
    const el = document.getElementById('home-list');
    if (!rows.length) {
      el.innerHTML = '<div class="empty-state"><span>📭</span><p>本月尚無記錄</p></div>';
      return;
    }

    const sorted = [...rows].sort((a, b) => b.date.localeCompare(a.date));
    el.innerHTML = sorted.map(r => {
      const mmdd = r.date.slice(5).replace('-', '/');
      const cat  = r.category || '💳';
      let sub = mmdd;
      if (r.payer === '🐨 Bear') sub += '　Bear付';
      else if (r.shared === '-')  sub += '　個人';
      return `
        <div class="list-item">
          <span class="list-item-icon">${cat}</span>
          <div class="list-item-body">
            <div class="list-item-title">${r.item || '（未命名）'}</div>
            <div class="list-item-sub">${sub}</div>
          </div>
          <div class="list-item-right amount-expense">${_fmt(r.amount)}</div>
        </div>`;
    }).join('');
  }

  function _setLoading() {
    document.getElementById('home-total').textContent      = '…';
    document.getElementById('home-settlement').textContent = '…';
    document.getElementById('home-sin').textContent        = '…';
    document.getElementById('home-bear-monthly').textContent = '…';
    document.getElementById('home-list').innerHTML = '<div class="spinner"></div>';
  }

  async function _load() {
    _setLoading();
    try {
      const [rows, settlement] = await Promise.all([
        Sheets.getMonthlyData(_year, _month),
        Sheets.getSettlement(),
      ]);
      _renderSummary(rows, settlement);
      _renderList(rows);
    } catch (e) {
      if (e.message !== 'auth_expired') {
        document.getElementById('home-list').innerHTML =
          `<div class="empty-state"><span>⚠️</span><p>${e.message}</p></div>`;
      }
    }
  }

  function _buildShell() {
    document.getElementById('tab-home').innerHTML = `
      <div class="home-nav">
        <button class="month-btn" id="home-prev">◀</button>
        <span id="home-month"></span>
        <button class="month-btn" id="home-next">▶</button>
        <button class="month-btn refresh-btn" id="home-refresh" title="重新載入">↺</button>
      </div>

      <div class="card summary-card">
        <div class="summary-top">
          <div>
            <div class="summary-label">總支出</div>
            <div class="summary-value amount-expense" id="home-total">…</div>
          </div>
          <div class="summary-right">
            <div class="summary-label">Bear結算（累計）</div>
            <div id="home-settlement" class="settlement-val">…</div>
          </div>
        </div>
        <div class="summary-bottom">
          <span class="share-item">Sin <strong id="home-sin">…</strong></span>
          <span class="share-item">Bear <strong id="home-bear-monthly">…</strong></span>
        </div>
      </div>

      <div class="section-title">最近記錄</div>
      <div class="card" id="home-list"></div>

      <button class="fab" id="btn-add">＋</button>
    `;

    document.getElementById('home-prev').addEventListener('click', () => {
      _month--;
      if (_month < 1) { _month = 12; _year--; }
      _updateMonthLabel();
      _load();
    });

    document.getElementById('home-next').addEventListener('click', () => {
      _month++;
      if (_month > 12) { _month = 1; _year++; }
      _updateMonthLabel();
      _load();
    });

    document.getElementById('home-refresh').addEventListener('click', () => {
      Sheets.invalidateMonth(_ym());
      _load();
    });

    document.getElementById('btn-add').addEventListener('click', () => {
      window.Add?.open();
    });
  }

  function init() {
    _buildShell();
    _updateMonthLabel();
    _load();
  }

  return { init, reload: _load };
})();

window.Home = Home;
