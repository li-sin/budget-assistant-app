const Home = (() => {
  const now = new Date();
  let _year  = now.getFullYear();
  let _month = now.getMonth() + 1;
  let _bearMonthly = 0;
  let _payYear     = 0;
  let _payMonth    = 0;
  let _allRepayments = [];

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
    document.getElementById('home-bear').textContent  = _fmt(_bearMonthly);

    const settEl = document.getElementById('home-settlement');
    settEl.textContent = _fmt(net);
    settEl.className   = `settlement-val ${net > 0 ? 'amount-expense' : net < 0 ? 'amount-income' : ''}`;

    const cumEl = document.getElementById('home-cumulative');
    if (settlement > 0) {
      cumEl.textContent = `Bear 欠 ${_fmt(settlement)}`;
      cumEl.className   = 'settlement-val settlement-cumul amount-expense';
    } else if (settlement < 0) {
      cumEl.textContent = `Sin 欠 ${_fmt(-settlement)}`;
      cumEl.className   = 'settlement-val settlement-cumul amount-income';
    } else {
      cumEl.textContent = '已結清 ✓';
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
    document.getElementById('home-bear').textContent       = '…';
    document.getElementById('home-cumulative').textContent = '…';
    document.getElementById('home-list').innerHTML = '<div class="spinner"></div>';
  }

  async function _load() {
    _setLoading();
    try {
      const ym = _ym();
      const [rows, settlement, repayments] = await Promise.all([
        Sheets.getMonthlyData(_year, _month),
        Sheets.getSettlement(),
        Sheets.getRepayments().catch(() => []),
      ]);
      const monthRepayment = repayments.find(r => r.ym === ym);
      const paid = monthRepayment?.amount || 0;
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

  function _payYm() {
    return `${_payYear}-${String(_payMonth).padStart(2, '0')}`;
  }

  function _payYmLabel() {
    return `${_payYear} 年 ${String(_payMonth).padStart(2, '0')} 月`;
  }

  async function _renderPaymentBody() {
    const body = document.getElementById('payment-modal-body');
    const ym   = _payYm();

    const rows      = await Sheets.getMonthlyData(_payYear, _payMonth).catch(() => []);
    const bear      = rows.reduce((s, r) => s + r.bearShare, 0);
    const repayment = _allRepayments.find(r => r.ym === ym);
    const paid      = repayment?.amount || 0;
    const remain    = bear - paid;

    body.innerHTML = `
      <div class="payment-month-pick">
        <button class="month-btn" id="pay-prev-m">◀</button>
        <span class="payment-month-lbl">${_payYmLabel()}</span>
        <button class="month-btn" id="pay-next-m">▶</button>
      </div>
      <div class="payment-summary">
        <div class="payment-row">
          <span class="payment-label">Bear 負擔</span>
          <span class="payment-val amount-expense">${_fmt(bear)}</span>
        </div>
        <div class="payment-row">
          <span class="payment-label">已還款</span>
          <span class="payment-val">${_fmt(paid)}</span>
        </div>
        ${repayment ? `
        <div class="payment-row">
          <span class="payment-label">最後還款日</span>
          <span class="payment-val">${repayment.lastDate}</span>
        </div>` : ''}
        <div class="payment-row payment-remain">
          <span class="payment-label">剩餘</span>
          <span class="payment-val ${remain > 0 ? 'amount-expense' : 'amount-income'}">${_fmt(remain)}</span>
        </div>
      </div>
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
      <p id="payment-error" class="add-error hidden"></p>
    `;

    document.getElementById('pay-prev-m').addEventListener('click', () => {
      _payMonth--;
      if (_payMonth < 1) { _payMonth = 12; _payYear--; }
      _renderPaymentBody();
    });
    document.getElementById('pay-next-m').addEventListener('click', () => {
      _payMonth++;
      if (_payMonth > 12) { _payMonth = 1; _payYear++; }
      _renderPaymentBody();
    });

    body.querySelectorAll('.chip[data-add]').forEach(btn => {
      btn.addEventListener('click', () => {
        const inp = document.getElementById('payment-amount');
        inp.value = (parseFloat(inp.value) || 0) + parseInt(btn.dataset.add, 10);
      });
    });
  }

  async function _openPaymentModal() {
    if (!_isSin()) return;
    _buildPaymentModal();

    // 預設為今天的上個月（通常是付上個月的款）
    const today = new Date();
    _payMonth = today.getMonth(); // getMonth() 回傳 0–11，剛好等於上個月的 1–12
    _payYear  = today.getFullYear();
    if (_payMonth === 0) { _payMonth = 12; _payYear--; }

    const modal = document.getElementById('payment-modal');
    const body  = document.getElementById('payment-modal-body');
    document.getElementById('payment-modal-title').textContent = '記錄還款';
    body.innerHTML = '<div class="spinner"></div>';
    modal.classList.remove('hidden');

    try {
      _allRepayments = await Sheets.getRepayments();
      await _renderPaymentBody();
    } catch (e) {
      body.innerHTML = `<div class="empty-state"><span>⚠️</span><p>${e.message}</p></div>`;
    }
  }

  function _closePaymentModal() {
    document.getElementById('payment-modal')?.classList.add('hidden');
  }

  async function _submitPayment() {
    const amount = parseFloat(document.getElementById('payment-amount')?.value);
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
      await Sheets.upsertRepayment(_payYm(), amount);
      _closePaymentModal();
      _load();
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
            <div class="summary-label">本月 Bear 淨負擔 ▸</div>
            <div id="home-settlement" class="settlement-val amount-expense">…</div>
            <div class="summary-label" style="margin-top:4px;font-size:11px">累計 Bear 淨負擔</div>
            <div id="home-cumulative" class="settlement-val settlement-cumul">…</div>
          </div>
        </div>
        <div class="summary-bottom">
          <span class="share-item">Sin <strong id="home-sin">…</strong></span>
          <span class="share-item">Bear <strong id="home-bear">…</strong></span>
        </div>
      </div>

      <div class="section-title">最近記錄</div>
      <div class="card" id="home-list"></div>

      <button class="fab" id="btn-add">＋</button>
    `;

    document.getElementById('home-prev').addEventListener('click', () => {
      _month--;
      if (_month < 1) { _month = 12; _year--; }
      window.AppMonth.set(_year, _month);
      _updateMonthLabel();
      _load();
    });
    document.getElementById('home-next').addEventListener('click', () => {
      _month++;
      if (_month > 12) { _month = 1; _year++; }
      window.AppMonth.set(_year, _month);
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

  function activate({ year, month }) {
    if (year !== _year || month !== _month) {
      _year = year; _month = month;
      _updateMonthLabel();
      _load();
    }
  }

  function init() {
    _buildShell();
    _updateMonthLabel();
    _load();
  }

  return { init, reload: _load, activate };
})();

window.Home = Home;
