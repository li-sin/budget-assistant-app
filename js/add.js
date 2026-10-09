const Add = (() => {
  const CATEGORIES = ['🍴', '🛒', '🧋', '⛽', '📦', '🎬', '👗', '🏠', '💊', '📚', '🎁'];

  let _payer  = '🌟 Star';
  let _shared = '是';
  let _mode   = 'expense';   // expense＝一般支出；prize＝中獎獎金（寫負金額，沿用 G/H 矩陣沖抵結算）

  function _todayStr() {
    return new Date().toISOString().slice(0, 10);
  }

  function _nowStr() {
    const d = new Date();
    return d.toISOString().slice(0, 16).replace('T', ' ');
  }

  function _defaultPayer() {
    const email = (Auth.getEmail() || '').toLowerCase();
    const bearEmail = (CONFIG.EMAIL_WHITELIST?.[1] || '').toLowerCase();
    return email === bearEmail ? '🐨 Bear' : '🌟 Star';
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
          <button class="btn-scan-header" id="add-scan">📷 掃描</button>
          <button class="btn-scan-header" id="add-query-detail">🧾 查詢明細</button>
          <button class="modal-close" id="add-close">✕</button>
        </div>

        <div class="modal-body">
          <div class="chip-row" id="add-mode-chips">
            <button class="chip active" data-mode="expense">💸 支出</button>
            <button class="chip" data-mode="prize">🎉 中獎獎金</button>
          </div>

          <label class="field-label">日期</label>
          <input type="date" id="add-date" class="field-input" value="${_todayStr()}">

          <label class="field-label"><span id="add-amount-label">金額</span> <span class="required">*</span></label>
          <div class="amount-wrap">
            <span class="amount-prefix">$</span>
            <input type="number" id="add-amount" class="field-input amount-input"
                   placeholder="0" min="0" step="1" inputmode="decimal">
            <button type="button" class="amount-calc-btn" id="add-calc" aria-label="計算機">🧮</button>
          </div>

          <label class="field-label">項目 <span class="required">*</span></label>
          <input type="text" id="add-item" class="field-input" placeholder="商店或品項名稱">

          <div id="add-cat-wrap">
            <label class="field-label">類別</label>
            <div class="chip-row cat-chip-row" id="add-cat-chips">
              <button class="chip cat-chip active" data-cat="">✕</button>
              ${CATEGORIES.map(c => `<button class="chip cat-chip" data-cat="${c}">${c}</button>`).join('')}
            </div>
            <input type="hidden" id="add-cat" value="">
          </div>

          <label class="field-label" id="add-payer-label">負責人</label>
          <div class="chip-row">
            <button class="chip active" data-payer="🌟 Star"><span class="payer-name">🌟 Sin</span><span class="payer-suffix"> 付</span></button>
            <button class="chip" data-payer="🐨 Bear"><span class="payer-name">🐨 Bear</span><span class="payer-suffix"> 付</span></button>
          </div>

          <label class="field-label" id="add-shared-label">是否共用</label>
          <div class="chip-row">
            <button class="chip active" data-shared="是">是（各半）</button>
            <button class="chip expense-only" data-shared="否">否（對方全欠）</button>
            <button class="chip expense-only" data-shared="-">- 個人</button>
            <button class="chip prize-only hidden" data-shared="部分">自訂</button>
          </div>
          <div id="add-bear-share-wrap" class="hidden">
            <label class="field-label">Bear 分到</label>
            <div class="amount-wrap">
              <span class="amount-prefix">$</span>
              <input type="number" id="add-bear-share" class="field-input amount-input"
                     placeholder="0" min="0" step="1" inputmode="decimal">
            </div>
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
      btn.addEventListener('click', () => _setShared(btn.dataset.shared));
    });

    // Mode chips（支出 / 中獎獎金）
    el.querySelectorAll('.chip[data-mode]').forEach(btn => {
      btn.addEventListener('click', () => _setMode(btn.dataset.mode));
    });

    document.getElementById('add-calc').addEventListener('click', () => {
      Calculator.open(document.getElementById('add-amount').value, result => {
        document.getElementById('add-amount').value = result;
      });
    });

    document.getElementById('add-close').addEventListener('click',  close);
    document.getElementById('add-cancel').addEventListener('click', close);
    el.addEventListener('click', e => { if (e.target === el) close(); });
    document.getElementById('add-submit').addEventListener('click', _submit);
    document.getElementById('add-scan').addEventListener('click', () => {
      Scan.start();
    });
    // 查詢明細記帳：不開鏡頭，直接手動輸入發票號碼後貼上財政部查詢明細（桌機可用）
    document.getElementById('add-query-detail').addEventListener('click', () => {
      Scan.startQueryDetail();
    });
  }

  function _setShared(val) {
    _shared = val;
    document.querySelectorAll('#add-modal .chip[data-shared]')
      .forEach(b => b.classList.toggle('active', b.dataset.shared === _shared));
    document.getElementById('add-bear-share-wrap').classList.toggle('hidden', _shared !== '部分');
  }

  // 中獎模式：負責人＝領獎人；共用只留「各半／自訂」；類別不適用
  function _setMode(mode) {
    _mode = mode;
    const prize = mode === 'prize';
    document.querySelectorAll('#add-modal .chip[data-mode]')
      .forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
    document.getElementById('add-amount-label').textContent = prize ? '獎金金額' : '金額';
    document.getElementById('add-payer-label').textContent  = prize ? '誰領的獎' : '負責人';
    document.getElementById('add-shared-label').textContent = prize ? '怎麼分' : '是否共用';
    document.getElementById('add-cat-wrap').classList.toggle('hidden', prize);
    document.querySelectorAll('#add-modal .payer-suffix').forEach(s => s.textContent = prize ? ' 領' : ' 付');
    document.querySelectorAll('#add-modal .expense-only').forEach(b => b.classList.toggle('hidden', prize));
    document.querySelectorAll('#add-modal .prize-only').forEach(b => b.classList.toggle('hidden', !prize));
    const itemEl = document.getElementById('add-item');
    if (prize && !itemEl.value) itemEl.value = '🎉 發票中獎';
    if (!prize && itemEl.value === '🎉 發票中獎') itemEl.value = '';
    _setShared('是');
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

    document.getElementById('add-bear-share').value = '';

    _payer  = _defaultPayer();
    document.querySelectorAll('#add-modal .chip[data-payer]')
      .forEach(b => b.classList.toggle('active', b.dataset.payer === _payer));
    _setMode('expense');

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

    let row;
    let gh = null;
    if (_mode === 'prize') {
      // 獎金＝負支出：C 寫負數，G/H 照矩陣變負值 → 領獎人那邊的應收自動沖抵對方的一半
      // 自訂分配：G/H 寫靜態值＋備註註明（audit_monthly_gh.py 視為已註記例外）
      let shared = _shared;
      if (_shared === '部分') {
        const bearShare = parseFloat(document.getElementById('add-bear-share').value);
        if (isNaN(bearShare) || bearShare < 0 || bearShare > amount) return _showError('Bear 分到的金額需介於 0 ～ 獎金');
        gh = [-(amount - bearShare), -bearShare];
      }
      const prizeNote = '🎉 中獎獎金' + (gh ? `（自訂：Bear 分 ${-gh[1]}）` : '') + (note ? ' ' + note : '');
      row = [
        date, item, -amount, _payer, shared, '',
        '', '', prizeNote,
        '手動記帳', '', _nowStr(),
      ];
    } else {
      row = [
        date, item, amount, _payer, _shared, cat,
        '', '', note,
        '手動記帳', '', _nowStr(),
      ];
    }

    const btn = document.getElementById('add-submit');
    btn.disabled    = true;
    btn.textContent = '新增中…';

    try {
      await Sheets.appendMonthlyRow(row, gh);
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
