const Add = (() => {
  const CATEGORIES = ['🍴', '🛒', '⛽', '📦', '🎬', '👗', '🏠', '💊'];

  let _payer  = '🌟 Star';
  let _shared = '是';

  // ── 分擔計算 ───────────────────────────────────────────────────
  // 是     → 各半
  // 否     → 負責人代墊，對方全欠
  // -      → Sin 個人，不計入 Bear
  // 部分共用 → 留空（需在 Sheet 補品項明細）
  function _calcShares(amount, payer, shared) {
    const half = +(amount / 2).toFixed(0);
    if (shared === '是')    return [half, half];
    if (shared === '-')     return [amount, 0];
    if (shared === '否') {
      return payer === '🌟 Star' ? [0, amount] : [amount, 0];
    }
    return ['', ''];  // 部分共用：留空
  }

  function _todayStr() {
    return new Date().toISOString().slice(0, 10);
  }

  function _nowStr() {
    const d = new Date();
    return d.toISOString().slice(0, 16).replace('T', ' ');
  }

  // ── Modal HTML ─────────────────────────────────────────────────
  function _buildModal() {
    if (document.getElementById('add-modal')) return;

    const el = document.createElement('div');
    el.id = 'add-modal';
    el.className = 'modal-overlay hidden';
    el.innerHTML = `
      <div class="modal-sheet">
        <div class="modal-header">
          <span class="modal-title">新增支出</span>
          <button class="btn-scan-header" id="add-scan">📷 掃描發票</button>
          <button class="modal-close" id="add-close">✕</button>
        </div>

        <div class="modal-body">
          <label class="field-label">日期</label>
          <input type="date" id="add-date" class="field-input" value="${_todayStr()}">

          <label class="field-label">金額 <span class="required">*</span></label>
          <div class="amount-wrap">
            <span class="amount-prefix">$</span>
            <input type="number" id="add-amount" class="field-input amount-input"
                   placeholder="0" min="0" step="1" inputmode="decimal">
          </div>

          <label class="field-label">項目 <span class="required">*</span></label>
          <input type="text" id="add-item" class="field-input" placeholder="商店或品項名稱">

          <label class="field-label">類別</label>
          <div class="chip-row cat-chip-row" id="add-cat-chips">
            <button class="chip cat-chip active" data-cat="">✕</button>
            ${CATEGORIES.map(c => `<button class="chip cat-chip" data-cat="${c}">${c}</button>`).join('')}
          </div>
          <input type="hidden" id="add-cat" value="">

          <label class="field-label">負責人</label>
          <div class="chip-row">
            <button class="chip active" data-payer="🌟 Star">🌟 Sin 付</button>
            <button class="chip" data-payer="🐨 Bear">🐨 Bear 付</button>
          </div>

          <label class="field-label">是否共用</label>
          <div class="chip-row">
            <button class="chip active" data-shared="是">是（各半）</button>
            <button class="chip" data-shared="否">否（對方全欠）</button>
            <button class="chip" data-shared="-">- 個人</button>
          </div>

          <label class="field-label">備註</label>
          <input type="text" id="add-note" class="field-input" placeholder="（選填）">

          <p id="add-error" class="add-error hidden"></p>
        </div>

        <div class="modal-footer">
          <button class="btn-secondary" id="add-cancel">取消</button>
          <button class="btn-primary" id="add-submit">新增</button>
        </div>
      </div>
    `;
    document.body.appendChild(el);

    // Category chips
    el.querySelectorAll('.cat-chip').forEach(btn => {
      btn.addEventListener('click', () => {
        el.querySelectorAll('.cat-chip').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById('add-cat').value = btn.dataset.cat;
      });
    });

    // Payer chips
    el.querySelectorAll('.chip[data-payer]').forEach(btn => {
      btn.addEventListener('click', () => {
        el.querySelectorAll('.chip[data-payer]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        _payer = btn.dataset.payer;
      });
    });

    // Shared chips
    el.querySelectorAll('.chip[data-shared]').forEach(btn => {
      btn.addEventListener('click', () => {
        el.querySelectorAll('.chip[data-shared]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        _shared = btn.dataset.shared;
      });
    });

    document.getElementById('add-close').addEventListener('click',  close);
    document.getElementById('add-cancel').addEventListener('click', close);
    el.addEventListener('click', e => { if (e.target === el) close(); });
    document.getElementById('add-submit').addEventListener('click', _submit);
    document.getElementById('add-scan').addEventListener('click', () => {
      Scan.start();
    });
  }

  // ── Open / Close ───────────────────────────────────────────────
  function open() {
    _buildModal();
    _resetForm();
    NoteChips.render('add-note');
    document.getElementById('add-modal').classList.remove('hidden');
    document.getElementById('add-amount').focus();
  }

  function close() {
    const el = document.getElementById('add-modal');
    if (el) el.classList.add('hidden');
  }

  function _resetForm() {
    document.getElementById('add-date').value   = _todayStr();
    document.getElementById('add-amount').value = '';
    document.getElementById('add-item').value   = '';
    document.getElementById('add-cat').value    = '';
    document.getElementById('add-note').value   = '';
    document.querySelectorAll('#add-modal .cat-chip')
      .forEach(b => b.classList.toggle('active', b.dataset.cat === ''));

    _payer  = '🌟 Star';
    _shared = '是';
    document.querySelectorAll('#add-modal .chip[data-payer]')
      .forEach(b => b.classList.toggle('active', b.dataset.payer === _payer));
    document.querySelectorAll('#add-modal .chip[data-shared]')
      .forEach(b => b.classList.toggle('active', b.dataset.shared === _shared));

    _hideError();
  }

  function _showError(msg) {
    const el = document.getElementById('add-error');
    el.textContent = msg;
    el.classList.remove('hidden');
  }
  function _hideError() {
    document.getElementById('add-error').classList.add('hidden');
  }

  // ── Submit ─────────────────────────────────────────────────────
  async function _submit() {
    _hideError();

    const date   = document.getElementById('add-date').value;
    const amount = parseFloat(document.getElementById('add-amount').value);
    const item   = document.getElementById('add-item').value.trim();
    const cat    = document.getElementById('add-cat').value;
    const note   = document.getElementById('add-note').value.trim();

    if (!date)          return _showError('請選擇日期');
    if (!amount || amount <= 0) return _showError('請輸入有效金額');
    if (!item)          return _showError('請輸入項目名稱');

    const [sinShare, bearShare] = _calcShares(amount, _payer, _shared);

    // [date, item, amount, payer, shared, category, sinShare, bearShare, note, source, sourceLink, importedAt]
    const row = [
      date, item, amount, _payer, _shared, cat,
      sinShare, bearShare, note,
      '手動記帳', '', _nowStr(),
    ];

    const btn = document.getElementById('add-submit');
    btn.disabled    = true;
    btn.textContent = '新增中…';

    try {
      await Sheets.appendMonthlyRow(row);
      close();
      window.Home?.reload();
      window.Ledger?.reload();
    } catch (e) {
      _showError('寫入失敗：' + e.message);
    } finally {
      btn.disabled    = false;
      btn.textContent = '新增';
    }
  }

  return { open, close };
})();

window.Add = Add;
