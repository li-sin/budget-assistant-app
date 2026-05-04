const Ledger = (() => {
  const now = new Date();
  let _year  = now.getFullYear();
  let _month = now.getMonth() + 1;
  let _memberFilter = 'all';  // 'all' | 'sin' | 'bear'
  let _catFilter    = '';
  let _allRows      = [];

  function _fmt(n) {
    return '$' + Math.abs(n).toLocaleString('zh-TW');
  }

  function _ym() {
    return `${_year}-${String(_month).padStart(2, '0')}`;
  }

  function _updateMonthLabel() {
    document.getElementById('ledger-month').textContent =
      `${_year} 年 ${String(_month).padStart(2, '0')} 月`;
  }

  function _filtered() {
    let rows = _allRows;
    if (_memberFilter === 'sin')  rows = rows.filter(r => r.sinShare  > 0);
    if (_memberFilter === 'bear') rows = rows.filter(r => r.bearShare > 0);
    if (_catFilter)               rows = rows.filter(r => r.category === _catFilter);
    return [...rows].sort((a, b) => b.date.localeCompare(a.date));
  }

  function _renderList() {
    const el   = document.getElementById('ledger-list');
    const rows = _filtered();

    document.getElementById('ledger-count').textContent = `${rows.length} 筆`;

    if (!rows.length) {
      el.innerHTML = '<div class="empty-state"><span>📭</span><p>沒有符合條件的記錄</p></div>';
      return;
    }

    const srcIcon = s => s === '發票' ? '🧾' : s === '信用卡' ? '💳' : '✏️';

    el.innerHTML = rows.map(r => {
      const mmdd = r.date.slice(5).replace('-', '/');
      const cat  = r.category || '💳';
      const shares = [];
      if (r.sinShare  > 0) shares.push(`Sin ${_fmt(r.sinShare)}`);
      if (r.bearShare > 0) shares.push(`Bear ${_fmt(r.bearShare)}`);
      const bearBadge = r.payer === '🐨 Bear'
        ? '<span class="badge badge-bear">Bear付</span>' : '';
      return `
        <div class="list-item">
          <span class="list-item-icon">${cat}</span>
          <div class="list-item-body">
            <div class="list-item-title">${r.item || '（未命名）'} ${bearBadge}</div>
            <div class="list-item-sub">
              ${mmdd}　${srcIcon(r.source)} ${r.source}
              ${shares.length ? '　' + shares.join(' · ') : ''}
            </div>
          </div>
          <div class="list-item-right amount-expense">${_fmt(r.amount)}</div>
        </div>`;
    }).join('');
  }

  function _refreshCatOptions() {
    const cats = [...new Set(_allRows.map(r => r.category).filter(Boolean))].sort();
    const sel  = document.getElementById('ledger-cat');
    const prev = sel.value;
    sel.innerHTML = '<option value="">全部類別</option>'
      + cats.map(c => `<option value="${c}">${c}</option>`).join('');
    sel.value  = cats.includes(prev) ? prev : '';
    _catFilter = sel.value;
  }

  async function _load() {
    document.getElementById('ledger-list').innerHTML = '<div class="spinner"></div>';
    document.getElementById('ledger-count').textContent = '';
    try {
      _allRows = await Sheets.getMonthlyData(_year, _month);
      _refreshCatOptions();
      _renderList();
    } catch (e) {
      if (e.message !== 'auth_expired') {
        document.getElementById('ledger-list').innerHTML =
          `<div class="empty-state"><span>⚠️</span><p>${e.message}</p></div>`;
      }
    }
  }

  function _buildShell() {
    document.getElementById('tab-ledger').innerHTML = `
      <div class="home-nav">
        <button class="month-btn" id="ledger-prev">◀</button>
        <span id="ledger-month"></span>
        <button class="month-btn" id="ledger-next">▶</button>
        <button class="month-btn refresh-btn" id="ledger-refresh">↺</button>
      </div>

      <div class="ledger-filters card">
        <div class="chip-row">
          <button class="chip active" data-member="all">全部</button>
          <button class="chip" data-member="sin">🌟 Sin</button>
          <button class="chip" data-member="bear">🐨 Bear</button>
        </div>
        <div class="filter-row">
          <select id="ledger-cat" class="cat-select">
            <option value="">全部類別</option>
          </select>
          <span id="ledger-count" class="ledger-count"></span>
        </div>
      </div>

      <div class="card" id="ledger-list"></div>
    `;

    document.getElementById('ledger-prev').addEventListener('click', () => {
      _month--;
      if (_month < 1) { _month = 12; _year--; }
      _updateMonthLabel();
      _load();
    });
    document.getElementById('ledger-next').addEventListener('click', () => {
      _month++;
      if (_month > 12) { _month = 1; _year++; }
      _updateMonthLabel();
      _load();
    });
    document.getElementById('ledger-refresh').addEventListener('click', () => {
      Sheets.invalidateMonth(_ym());
      _load();
    });

    document.querySelectorAll('#tab-ledger .chip[data-member]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#tab-ledger .chip[data-member]')
          .forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        _memberFilter = btn.dataset.member;
        _renderList();
      });
    });

    document.getElementById('ledger-cat').addEventListener('change', e => {
      _catFilter = e.target.value;
      _renderList();
    });
  }

  function init() {
    _buildShell();
    _updateMonthLabel();
    _load();
  }

  return { init, reload: _load };
})();
