const Home = (() => {
  const now = new Date();
  let _year  = now.getFullYear();
  let _month = now.getMonth() + 1;
  let _bearMonthly = 0;

  function _fmt(n) { return '$' + Math.abs(n).toLocaleString('zh-TW'); }
  function _ym()   { return `${_year}-${String(_month).padStart(2, '0')}`; }
  function _ymLabel() {
    return `${_year} 年 ${String(_month).padStart(2, '0')} 月`;
  }
  function _isSin() {
    return Auth.getEmail() === CONFIG.EMAIL_WHITELIST[0];
  }

  function _updateMonthLabel() {
    document.getElementById('home-month').textContent = _ymLabel();
  }

  function _renderSummary(rows, settlement, paid) {
    const total    = rows.reduce((s, r) => s + r.amount,    0);
    const sinTotal = rows.reduce((s, r) => s + r.sinShare,  0);
    _bearMonthly   = rows.reduce((s, r) => s + r.bearShare, 0);
    const net      = _bearMonthly - paid;

    document.getElementById('home-total').textContent = _fmt(total);
    document.getElementById('home-sin').textContent   = _fmt(sinTotal);

    const settEl = document.getElementById('home-settlement');
    settEl.textContent = _fmt(net);
    settEl.className   = `settlement-val ${net > 0 ? 'amount-expense' : net < 0 ? 'amount-income' : ''}`;

    const cumEl = document.getElementById('home-cumulative');
    if (settlement > 0) {
      cumEl.textContent = `累計 Bear 欠 ${_fmt(settlement)}`;
      cumEl.className   = 'settlement-val settlement-cumul amount-expense';
    } else if (settlement < 0) {
      cumEl.textContent = `累計 Sin 欠 ${_fmt(-settlement)}`;
      cumEl.className   = 'settlement-val settlement-cumul amount-income';
    } else {
      cumEl.textContent = '累計 已結清 ✓';
      cumEl.className   = 'settlement-val settlement-cumul';
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
    document.getElementById('home-cumulative').textContent = '…';
    document.getElementById('home-list').innerHTML = '<div class="spinner"></div>';
  }

  async function _load() {
    _setLoading();
    try {
      const ym = _ym();
      const [rows, settlement, settlementRows] = await Promise.all([
        Sheets.getMonthlyData(_year, _month),
        Sheets.getSettlement(),
        Sheets.getSettlementRows().catch(() => []),
      ]);
      const paid = settlementRows
        .filter(r => r.note.startsWith(ym))
        .reduce((s, r) => s + r.amount, 0);
      _renderSummary(rows, settlement, paid);
      _renderList(rows);
    } catch (e) {
      if (e.message !== 'auth_expired') {
        document.getElementById('home-list').innerHTML =
          `<div class="empty-state"><span>⚠️</span><p>${e.message}</p></div>`;
      }
    }
  }

  // ── Payment Modal ─────────────────────────────────────────────

  function _buildPaymentModal() {
    if (document.getElementById('payment-modal')) return;
    const el = document.createElement('div');
    el.id = 'payment-modal';
    el.className = 'modal-overlay hidden';
    el.innerHTML = `
      <div class="modal-sheet">
        <div class="modal-header">
          <span class="modal-title" id="payment-modal-title">記錄還款</span>
          <button class="modal-close" id="payment-close">✕</button>
        </div>
        <div class="modal-body" id="payment-modal-body">
          <div class="spinner"></div>
        </div>
        <div class="modal-footer">
          <button class="btn-secondary" id="payment-cancel">取消</button>
          <button class="btn-primary" id="payment-submit">儲存</button>
        </div>
      </div>
    `;
    document.body.appendChild(el);
    document.getElementById('payment-close').addEventListener('click',  _closePaymentModal);
    document.getElementById('payment-cancel').addEventListener('click', _closePaymentModal);
    el.addEventListener('click', e => { if (e.target === el) _closePaymentModal(); });
    document.getElementById('payment-submit').addEventListener('click', _submitPayment);
  }

  async function _openPaymentModal() {
    if (!_isSin()) return;
    _buildPaymentModal();
    const modal = document.getElementById('payment-modal');
    const body  = document.getElementById('payment-modal-body');
    document.getElementById('payment-modal-title').textContent = `記錄還款 · ${_ymLabel()}`;
    body.innerHTML = '<div class="spinner"></div>';
    modal.classList.remove('hidden');

    try {
      const allRows   = await Sheets.getSettlementRows();
      const ym        = _ym();
      const monthRows = allRows.filter(r => r.note.startsWith(ym));
      const paid      = monthRows.reduce((s, r) => s + r.amount, 0);
      const remain    = _bearMonthly - paid;

      body.innerHTML = `
        <div class="payment-summary">
          <div class="payment-row">
            <span class="payment-label">本月 Bear 負擔</span>
            <span class="payment-val amount-expense">${_fmt(_bearMonthly)}</span>
          </div>
          <div class="payment-row">
            <span class="payment-label">本月已還款</span>
            <span class="payment-val">${_fmt(paid)}</span>
          </div>
          <div class="payment-row payment-remain">
            <span class="payment-label">剩餘</span>
            <span class="payment-val ${remain > 0 ? 'amount-expense' : 'amount-income'}">${_fmt(remain)}</span>
          </div>
        </div>
        ${monthRows.length ? `
          <div class="section-title" style="margin-top:12px">本月還款記錄</div>
          <div class="payment-list">
            ${monthRows.map(r => `
              <div class="payment-hist-row">
                <span class="payment-hist-date">${r.date.slice(5)}</span>
                <span class="payment-hist-note">${r.note}</span>
                <span class="payment-hist-amt">${_fmt(r.amount)}</span>
              </div>
            `).join('')}
          </div>` : ''}
        <div class="section-title" style="margin-top:12px">新增還款</div>
        <label class="field-label">金額</label>
        <div class="amount-wrap">
          <span class="amount-prefix">$</span>
          <input type="number" id="payment-amount" class="field-input amount-input"
                 min="0" step="1" inputmode="decimal" placeholder="0">
        </div>
        <div class="payment-quick-chips">
          <button class="chip" data-add="100">+100</button>
          <button class="chip" data-add="500">+500</button>
          <button class="chip" data-add="1000">+1000</button>
          ${remain > 0 ? `<button class="chip" data-add="${Math.round(remain)}">全額 ${_fmt(remain)}</button>` : ''}
        </div>
        <label class="field-label">備註</label>
        <input type="text" id="payment-note" class="field-input" value="${ym}">
        <p id="payment-error" class="add-error hidden"></p>
      `;

      body.querySelectorAll('.chip[data-add]').forEach(btn => {
        btn.addEventListener('click', () => {
          const inp = document.getElementById('payment-amount');
          inp.value = (parseFloat(inp.value) || 0) + parseInt(btn.dataset.add, 10);
        });
      });
    } catch (e) {
      body.innerHTML = `<div class="empty-state"><span>⚠️</span><p>${e.message}</p></div>`;
    }
  }

  function _closePaymentModal() {
    document.getElementById('payment-modal')?.classList.add('hidden');
  }

  async function _submitPayment() {
    const amount = parseFloat(document.getElementById('payment-amount')?.value);
    const note   = document.getElementById('payment-note')?.value.trim() || _ym();
    const errEl  = document.getElementById('payment-error');

    if (!amount || amount <= 0) {
      errEl.textContent = '請輸入還款金額';
      errEl.classList.remove('hidden');
      return;
    }

    const btn = document.getElementById('payment-submit');
    btn.disabled    = true;
    btn.textContent = '儲存中…';
    try {
      await Sheets.appendSettlementRow(amount, note);
      _closePaymentModal();
    } catch (e) {
      errEl.textContent = '儲存失敗：' + e.message;
      errEl.classList.remove('hidden');
    } finally {
      btn.disabled    = false;
      btn.textContent = '儲存';
    }
  }

  // ── Shell ─────────────────────────────────────────────────────

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
          <div class="summary-right home-settlement-btn">
            <div class="summary-label">本月 Bear 負擔 ▸</div>
            <div id="home-cumulative" class="settlement-val settlement-cumul">…</div>
            <div id="home-settlement" class="settlement-val amount-expense">…</div>
          </div>
        </div>
        <div class="summary-bottom">
          <span class="share-item">Sin <strong id="home-sin">…</strong></span>
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
    document.querySelector('.home-settlement-btn').addEventListener('click', _openPaymentModal);
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
