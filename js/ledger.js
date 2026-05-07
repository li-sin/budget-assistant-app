const Ledger = (() => {
  const CATEGORIES = ['🍴', '🛒', '⛽', '📦', '🎬', '👗', '🏠', '💊'];
  const SHARED_OPTS = ['是', '否', '部分', '-', 'x'];

  const now = new Date();
  let _year  = now.getFullYear();
  let _month = now.getMonth() + 1;
  let _memberFilter  = 'all';
  let _sharedFilter  = 'all';
  let _catFilter     = '';
  let _allRows       = [];
  let _pendingFilter = null;
  let _itemsCache    = null;
  let _itemsCacheTs  = 0;
  const ITEMS_CACHE_TTL = 5 * 60 * 1000;

  let _editPayer  = '🌟 Star';
  let _editShared = '是';

  function _fmt(n) {
    return '$' + Math.abs(n).toLocaleString('zh-TW');
  }

  function _ym() {
    return `${_year}-${String(_month).padStart(2, '0')}`;
  }

  function _isSin() {
    return Auth.getEmail() === 'lovelisa00000@gmail.com';
  }

  function _updateMonthLabel() {
    document.getElementById('ledger-month').textContent =
      `${_year} 年 ${String(_month).padStart(2, '0')} 月`;
  }

  function _filtered() {
    let rows = _allRows;
    if (_memberFilter === 'sin')    rows = rows.filter(r => r.sinShare  > 0);
    if (_memberFilter === 'bear')   rows = rows.filter(r => r.bearShare > 0);
    if (_sharedFilter === 'shared') rows = rows.filter(r => r.shared === '是' || r.shared === '否' || r.shared === '部分');
    if (_sharedFilter === 'personal') rows = rows.filter(r => r.shared === '-');
    if (_catFilter)                 rows = rows.filter(r => r.category === _catFilter);
    return [...rows].sort((a, b) => b.date.localeCompare(a.date));
  }

  function _renderList() {
    const el   = document.getElementById('ledger-list');
    const rows = _filtered();

    document.getElementById('ledger-count').textContent = `${rows.length} 筆`;

    const sumEl = document.getElementById('ledger-summary');
    if (rows.length) {
      const total = rows.reduce((s, r) => s + r.amount,    0);
      const sin   = rows.reduce((s, r) => s + r.sinShare,  0);
      const bear  = rows.reduce((s, r) => s + r.bearShare, 0);
      sumEl.textContent = `總 ${_fmt(total)}　Sin ${_fmt(sin)}　Bear ${_fmt(bear)}`;
      sumEl.classList.remove('hidden');
    } else {
      sumEl.classList.add('hidden');
    }

    if (!rows.length) {
      el.innerHTML = '<div class="empty-state"><span>📭</span><p>沒有符合條件的記錄</p></div>';
      return;
    }

    const srcIcon = s => s === '發票' ? '🧾' : s === '信用卡' ? '💳' : '✏️';
    const isSin   = _isSin();

    el.innerHTML = rows.map(r => {
      const mmdd = r.date.slice(5).replace('-', '/');
      const cat  = r.category || '💳';
      const shares = [];
      if (r.sinShare  > 0) shares.push(`Sin ${_fmt(r.sinShare)}`);
      if (r.bearShare > 0) shares.push(`Bear ${_fmt(r.bearShare)}`);
      const bearBadge = r.payer === '🐨 Bear'
        ? '<span class="badge badge-bear">Bear付</span>' : '';
      const sharedLabel = r.shared ? `<span class="tag-shared">${r.shared}</span>` : '';
      const noteText    = r.note   ? `<span class="ledger-note">　${r.note}</span>` : '';
      const isInvoice   = (r.source === '發票' || r.source === '掃描發票') && r.sourceLink;
      return `
        <div class="list-item${isSin ? ' list-item-editable' : ''}" data-row="${r.rowIndex}">
          <span class="list-item-icon">${cat}</span>
          <div class="list-item-body">
            <div class="list-item-title">${r.item || '（未命名）'} ${bearBadge} ${sharedLabel}</div>
            <div class="list-item-sub">
              ${mmdd}　${srcIcon(r.source)} ${r.source}
              ${shares.length ? '　' + shares.join(' · ') : ''}
              ${noteText}
            </div>
          </div>
          <div class="list-item-right">
            <div class="amount-expense">${_fmt(r.amount)}</div>
            ${isInvoice ? `<button class="expand-btn" data-row="${r.rowIndex}">▼</button>` : ''}
          </div>
        </div>`;
    }).join('');

    if (isSin) {
      el.querySelectorAll('.list-item').forEach(item => {
        item.addEventListener('click', () => {
          const rowIndex = parseInt(item.dataset.row, 10);
          const row = _allRows.find(r => r.rowIndex === rowIndex);
          if (row) _openEdit(row);
        });
      });
    }

    el.querySelectorAll('.expand-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const rowIndex = parseInt(btn.dataset.row, 10);
        const row = _allRows.find(r => r.rowIndex === rowIndex);
        if (row) _toggleItemDetail(row, btn);
      });
    });
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

  function _applyFilter(f) {
    if (f.member !== undefined) {
      _memberFilter = f.member;
      document.querySelectorAll('#tab-ledger .chip[data-member]').forEach(b => {
        b.classList.toggle('active', b.dataset.member === _memberFilter);
      });
    }
    if (f.shared !== undefined) {
      _sharedFilter = f.shared;
      document.querySelectorAll('#tab-ledger .chip[data-shared-filter]').forEach(b => {
        b.classList.toggle('active', b.dataset.sharedFilter === _sharedFilter);
      });
    }
    if (f.category !== undefined) {
      _catFilter = f.category;
      const sel = document.getElementById('ledger-cat');
      if (sel) sel.value = _catFilter;
    }
  }

  async function _toggleItemDetail(row, btnEl) {
    const detailId = `item-detail-${row.rowIndex}`;
    const listItem = btnEl.closest('.list-item');
    const existing = document.getElementById(detailId);
    if (existing) { existing.remove(); btnEl.textContent = '▼'; return; }

    btnEl.textContent = '…';
    try {
      if (!_itemsCache || Date.now() - _itemsCacheTs >= ITEMS_CACHE_TTL) {
        _itemsCache   = await Sheets.getItemData();
        _itemsCacheTs = Date.now();
      }
      const invItems = _itemsCache.filter(it => it.invNum === row.sourceLink);
      const detail   = document.createElement('div');
      detail.id        = detailId;
      detail.className = 'item-detail-list';
      if (!invItems.length) {
        detail.innerHTML = '<div class="item-detail-empty">無品項明細</div>';
      } else {
        detail.innerHTML = invItems.map(it => `
          <div class="item-detail-row">
            <span class="item-detail-name">${it.itemName || '（未命名）'}</span>
            <span class="item-detail-attr">${it.attribution || '—'}</span>
            <span class="item-detail-amt">$${it.itemAmount.toLocaleString('zh-TW')}</span>
          </div>`).join('');
      }
      listItem.insertAdjacentElement('afterend', detail);
      btnEl.textContent = '▲';
    } catch (e) {
      btnEl.textContent = '▼';
    }
  }

  function jumpTo({ member, category, shared } = {}) {
    _pendingFilter = {};
    if (member   !== undefined) _pendingFilter.member   = member;
    if (shared   !== undefined) _pendingFilter.shared   = shared;
    if (category !== undefined) _pendingFilter.category = category;
    Router.navigate('ledger');
  }

  // ── Edit Modal ─────────────────────────────────────────────────

  function _buildEditModal() {
    if (document.getElementById('edit-modal')) return;
    const el = document.createElement('div');
    el.id = 'edit-modal';
    el.className = 'modal-overlay hidden';
    el.innerHTML = `
      <div class="modal-sheet">
        <div class="modal-header">
          <span class="modal-title">編輯支出</span>
          <button class="modal-close" id="edit-close">✕</button>
        </div>
        <div class="modal-body">
          <label class="field-label">日期</label>
          <input type="date" id="edit-date" class="field-input">

          <label class="field-label">項目</label>
          <input type="text" id="edit-item" class="field-input">

          <label class="field-label">總金額</label>
          <div class="amount-wrap">
            <span class="amount-prefix">$</span>
            <input type="number" id="edit-amount" class="field-input amount-input" min="0" step="1" inputmode="decimal">
          </div>

          <label class="field-label">類別</label>
          <select id="edit-cat" class="field-input cat-select">
            <option value="">（未分類）</option>
            ${CATEGORIES.map(c => `<option value="${c}">${c}</option>`).join('')}
          </select>

          <label class="field-label">負責人</label>
          <div class="chip-row" id="edit-payer-chips">
            <button class="chip active" data-payer="🌟 Star">🌟 Sin 付</button>
            <button class="chip" data-payer="🐨 Bear">🐨 Bear 付</button>
          </div>

          <label class="field-label">是否共用</label>
          <div class="chip-row" id="edit-shared-chips">
            ${SHARED_OPTS.map(v => `<button class="chip" data-shared="${v}">${v}</button>`).join('')}
          </div>

          <label class="field-label">Sin 負擔</label>
          <div class="amount-wrap">
            <span class="amount-prefix">$</span>
            <input type="number" id="edit-sin" class="field-input amount-input" min="0" step="1" inputmode="decimal">
          </div>

          <label class="field-label">Bear 負擔</label>
          <div class="amount-wrap">
            <span class="amount-prefix">$</span>
            <input type="number" id="edit-bear" class="field-input amount-input" min="0" step="1" inputmode="decimal">
          </div>

          <label class="field-label">備註</label>
          <input type="text" id="edit-note" class="field-input">

          <p id="edit-error" class="add-error hidden"></p>
        </div>
        <div class="modal-footer">
          <button class="btn-secondary" id="edit-cancel">取消</button>
          <button class="btn-primary" id="edit-submit">儲存</button>
        </div>
      </div>
    `;
    document.body.appendChild(el);

    el.querySelectorAll('#edit-payer-chips .chip').forEach(btn => {
      btn.addEventListener('click', () => {
        el.querySelectorAll('#edit-payer-chips .chip').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        _editPayer = btn.dataset.payer;
      });
    });

    el.querySelectorAll('#edit-shared-chips .chip').forEach(btn => {
      btn.addEventListener('click', () => {
        el.querySelectorAll('#edit-shared-chips .chip').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        _editShared = btn.dataset.shared;
      });
    });

    document.getElementById('edit-close').addEventListener('click',  _closeEdit);
    document.getElementById('edit-cancel').addEventListener('click', _closeEdit);
    el.addEventListener('click', e => { if (e.target === el) _closeEdit(); });
    document.getElementById('edit-submit').addEventListener('click', _submitEdit);
  }

  let _editRowIndex = null;
  let _editOrigDate = '';

  function _openEdit(row) {
    _buildEditModal();
    _editRowIndex = row.rowIndex;
    _editOrigDate = row.date;

    document.getElementById('edit-date').value   = row.date;
    document.getElementById('edit-item').value   = row.item;
    document.getElementById('edit-amount').value = row.amount || '';
    document.getElementById('edit-cat').value    = row.category || '';
    document.getElementById('edit-sin').value    = row.sinShare  || '';
    document.getElementById('edit-bear').value   = row.bearShare || '';
    document.getElementById('edit-note').value   = row.note || '';
    document.getElementById('edit-error').classList.add('hidden');

    _editPayer  = row.payer  || '🌟 Star';
    _editShared = row.shared || '是';

    document.querySelectorAll('#edit-payer-chips .chip')
      .forEach(b => b.classList.toggle('active', b.dataset.payer === _editPayer));
    document.querySelectorAll('#edit-shared-chips .chip')
      .forEach(b => b.classList.toggle('active', b.dataset.shared === _editShared));

    document.getElementById('edit-modal').classList.remove('hidden');
  }

  function _closeEdit() {
    const el = document.getElementById('edit-modal');
    if (el) el.classList.add('hidden');
  }

  async function _submitEdit() {
    const date   = document.getElementById('edit-date').value;
    const item   = document.getElementById('edit-item').value.trim();
    const amount = parseFloat(document.getElementById('edit-amount').value);
    const cat    = document.getElementById('edit-cat').value;
    const sin    = document.getElementById('edit-sin').value;
    const bear   = document.getElementById('edit-bear').value;
    const note   = document.getElementById('edit-note').value.trim();

    if (!date || !item || !amount) {
      document.getElementById('edit-error').textContent = '日期、項目、金額為必填';
      document.getElementById('edit-error').classList.remove('hidden');
      return;
    }

    // 找原始列以保留 source / sourceLink / importedAt
    const orig = _allRows.find(r => r.rowIndex === _editRowIndex);
    const row = [
      date, item, amount, _editPayer, _editShared, cat,
      sin !== '' ? parseFloat(sin) : '',
      bear !== '' ? parseFloat(bear) : '',
      note,
      orig?.source     || '手動記帳',
      orig?.sourceLink || '',
      orig?.importedAt || '',
    ];

    const btn = document.getElementById('edit-submit');
    btn.disabled    = true;
    btn.textContent = '儲存中…';

    try {
      await Sheets.updateMonthlyRow(_editRowIndex, row);
      _closeEdit();
      // 清兩個月份快取（日期可能被修改）
      const ymOrig = _editOrigDate.slice(0, 7);
      const ymNew  = date.slice(0, 7);
      Sheets.invalidateMonth(ymOrig);
      if (ymNew !== ymOrig) Sheets.invalidateMonth(ymNew);
      await _load();
      window.Home?.reload();
    } catch (e) {
      document.getElementById('edit-error').textContent = '儲存失敗：' + e.message;
      document.getElementById('edit-error').classList.remove('hidden');
    } finally {
      btn.disabled    = false;
      btn.textContent = '儲存';
    }
  }

  // ── Shell ─────────────────────────────────────────────────────

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
        <div class="chip-row" id="ledger-shared-chips">
          <button class="chip active" data-shared-filter="all">全部</button>
          <button class="chip" data-shared-filter="shared">共用</button>
          <button class="chip" data-shared-filter="personal">個人</button>
        </div>
        <div class="filter-row">
          <select id="ledger-cat" class="cat-select">
            <option value="">全部類別</option>
          </select>
          <span id="ledger-count" class="ledger-count"></span>
        </div>
        <div id="ledger-summary" class="ledger-summary hidden"></div>
      </div>

      <div class="card" id="ledger-list"></div>
    `;

    document.getElementById('ledger-prev').addEventListener('click', () => {
      _month--;
      if (_month < 1) { _month = 12; _year--; }
      window.AppMonth.set(_year, _month);
      _updateMonthLabel();
      _load();
    });
    document.getElementById('ledger-next').addEventListener('click', () => {
      _month++;
      if (_month > 12) { _month = 1; _year++; }
      window.AppMonth.set(_year, _month);
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

    document.querySelectorAll('#tab-ledger .chip[data-shared-filter]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#tab-ledger .chip[data-shared-filter]')
          .forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        _sharedFilter = btn.dataset.sharedFilter;
        _renderList();
      });
    });

    document.getElementById('ledger-cat').addEventListener('change', e => {
      _catFilter = e.target.value;
      _renderList();
    });
  }

  function activate({ year, month }) {
    const pending = _pendingFilter;
    _pendingFilter = null;
    if (year !== _year || month !== _month) {
      _year = year; _month = month;
      if (pending) _applyFilter(pending);
      _updateMonthLabel();
      _load();
    } else if (pending) {
      _applyFilter(pending);
      _renderList();
    }
  }

  function init() {
    _buildShell();
    _updateMonthLabel();
    _load();
  }

  return { init, reload: _load, activate, jumpTo };
})();

window.Ledger = Ledger;
