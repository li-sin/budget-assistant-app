const Add = (() => {
  const CATEGORIES = ['🍴', '🛒', '🧋', '⛽', '📦', '🎬', '👗', '🏠', '💊', '📚', '🎁'];

  let _payer  = '🌟 Star';
  let _shared = '是';
  let _mode   = 'expense';   // expense＝一般支出；income＝收入／抵銷（寫負金額，沿用 G/H 矩陣）
  let _src    = 'prize';     // 收入來源：prize＝中獎（不算花費）；其餘＝抵銷某類別的花費
  let _giftBalance = null;   // 媽媽禮金餘額（代管款加總），讀到才有
  // 收入來源。gift＝從媽媽禮金扣（同時寫一筆代管款支出）
  const INCOME_SRCS = [
    { k: 'prize',  label: '🎉 中獎',       tag: '' },
    { k: 'mom',    label: '👩 媽媽給',     tag: '媽媽給' },
    { k: 'gift',   label: '🧧 用媽媽禮金', tag: '媽媽禮金' },
    { k: 'refund', label: '↩️ 退款',       tag: '退款' },
  ];
  const GIFT_WHO = '媽媽';

  // 用本地時間（toISOString 是 UTC，台灣早上 8 點前會差一天）
  function _localIso() {
    const d = new Date();
    return new Date(d - d.getTimezoneOffset() * 60000).toISOString();
  }

  function _todayStr() {
    return _localIso().slice(0, 10);
  }

  function _nowStr() {
    return _localIso().slice(0, 16).replace('T', ' ');
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
            <button class="chip" data-mode="income">💰 收入／抵銷</button>
          </div>
          <div id="add-income-wrap" class="hidden">
            <div class="chip-row" id="add-src-chips">
              ${INCOME_SRCS.map(s => `<button class="chip" data-src="${s.k}">${s.label}</button>`).join('')}
            </div>
            <p class="settings-label-sub" id="add-src-hint" style="margin:-4px 0 8px"></p>
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
          <div id="add-coupon-wrap">
            <label class="field-label">🎟️ 我的優惠券折抵（選填）</label>
            <div class="amount-wrap">
              <span class="amount-prefix">$</span>
              <input type="number" id="add-coupon" class="field-input amount-input" placeholder="0"
                     min="0" step="1" inputmode="decimal" data-calc-label="🎟️ 我的優惠券折抵多少">
            </div>
            <p class="settings-label-sub" id="add-coupon-hint" style="margin:4px 0 0">金額填原價；優惠券是你的，折掉的錢算你的，共用照原價分</p>
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
            <button class="chip" data-shared="否">否（對方全欠）</button>
            <button class="chip" data-shared="-">- 個人</button>
            <button class="chip" data-shared="部分">部分</button>
          </div>
          <div id="add-bear-share-wrap" class="hidden">
            <label class="field-label" id="add-bear-label">Bear 負擔</label>
            <div class="amount-wrap">
              <span class="amount-prefix">$</span>
              <input type="number" id="add-bear-share" class="field-input amount-input"
                     placeholder="0" min="0" step="1" inputmode="decimal">
            </div>
          </div>

          <div id="add-note-wrap">
            <label class="field-label">備註</label>
            <input type="text" id="add-note" class="field-input" placeholder="（選填）">
          </div>

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
      btn.addEventListener('click', () => _setShared(btn.dataset.shared, { prompt: true }));
    });

    // Mode chips（支出 / 收入抵銷）
    el.querySelectorAll('.chip[data-mode]').forEach(btn => {
      btn.addEventListener('click', () => _setMode(btn.dataset.mode));
    });
    el.querySelectorAll('.chip[data-src]').forEach(btn => {
      btn.addEventListener('click', () => _setSrc(btn.dataset.src));
    });
    Calculator.attach(document.getElementById('add-bear-share'));
    Calculator.attach(document.getElementById('add-coupon'));

    document.getElementById('add-calc').addEventListener('click', () => {
      Calculator.open(document.getElementById('add-amount').value, result => {
        document.getElementById('add-amount').value = result;
      }, document.getElementById('add-amount-label').textContent);
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

  // 支出「部分」：Bear 金額存備註欄（與明細編輯一致），所以備註欄換成 Bear 負擔欄
  function _setShared(val, { prompt = false } = {}) {
    _shared = val;
    const partial = _shared === '部分';
    document.querySelectorAll('#add-modal .chip[data-shared]')
      .forEach(b => b.classList.toggle('active', b.dataset.shared === _shared));
    document.getElementById('add-bear-share-wrap').classList.toggle('hidden', !partial);
    document.getElementById('add-note-wrap').classList.toggle('hidden', partial && _mode === 'expense');
    document.getElementById('add-bear-share').dataset.calcLabel = document.getElementById('add-bear-label').textContent;
    if (partial && prompt) Calculator.promptFor(document.getElementById('add-bear-share'));
  }

  // 各模式能選的共用方式：支出全部；中獎＝各半／自訂；其他收入＝個人／各半／自訂
  const _SHARED_OPTS = { expense: ['是', '否', '-', '部分'], prize: ['是', '部分'], offset: ['-', '是', '部分'] };
  function _applySharedOpts(kind, def) {
    document.querySelectorAll('#add-modal .chip[data-shared]').forEach(b => {
      b.classList.toggle('hidden', !_SHARED_OPTS[kind].includes(b.dataset.shared));
      if (b.dataset.shared === '部分') b.textContent = kind === 'expense' ? '部分' : '自訂';
    });
    _setShared(def);
  }

  function _setMode(mode) {
    _mode = mode;
    const income = mode === 'income';
    document.querySelectorAll('#add-modal .chip[data-mode]')
      .forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
    document.getElementById('add-income-wrap').classList.toggle('hidden', !income);
    document.getElementById('add-coupon-wrap').classList.toggle('hidden', income);   // 優惠券只用在支出
    if (income) { _setSrc(_src); return; }
    document.getElementById('add-amount-label').textContent = '金額';
    document.getElementById('add-payer-label').textContent  = '負責人';
    document.getElementById('add-shared-label').textContent = '是否共用';
    document.getElementById('add-bear-label').textContent   = 'Bear 負擔';
    document.getElementById('add-cat-wrap').classList.remove('hidden');
    document.querySelectorAll('#add-modal .payer-suffix').forEach(s => s.textContent = ' 付');
    const itemEl = document.getElementById('add-item');
    if (itemEl.value === '🎉 發票中獎') itemEl.value = '';
    _applySharedOpts('expense', '是');
  }

  // 收入來源：中獎＝領獎人、不選類別、不算花費；其他＝選要抵銷的類別，會扣掉那個類別的花費
  function _setSrc(k) {
    _src = k;
    const prize = k === 'prize';
    document.querySelectorAll('#add-modal .chip[data-src]')
      .forEach(b => b.classList.toggle('active', b.dataset.src === k));
    document.getElementById('add-amount-label').textContent = prize ? '獎金金額' : '金額';
    document.getElementById('add-payer-label').textContent  = prize ? '誰領的獎' : '誰收到';
    document.getElementById('add-shared-label').textContent = '怎麼分';
    document.getElementById('add-bear-label').textContent   = 'Bear 分到';
    document.getElementById('add-cat-wrap').classList.toggle('hidden', prize);
    document.querySelectorAll('#add-modal .payer-suffix').forEach(s => s.textContent = prize ? ' 領' : ' 收');
    const itemEl = document.getElementById('add-item');
    if (prize && !itemEl.value) itemEl.value = '🎉 發票中獎';
    if (!prize && itemEl.value === '🎉 發票中獎') itemEl.value = '';
    _applySharedOpts(prize ? 'prize' : 'offset', prize ? '是' : '-');
    _renderSrcHint();
    if (k === 'gift' && _giftBalance === null) {
      Sheets.getCustodyRecords()
        .then(rs => { _giftBalance = rs.filter(r => r.who === GIFT_WHO).reduce((s, r) => s + r.amount, 0); _renderSrcHint(); })
        .catch(() => { _giftBalance = null; document.getElementById('add-src-hint').textContent = '讀不到媽媽禮金餘額'; });
    }
  }

  function _fmtMoney(n) { return '$' + Math.round(n).toLocaleString('zh-TW'); }
  function _renderSrcHint() {
    const el = document.getElementById('add-src-hint');
    if (!el) return;
    el.textContent = _src === 'prize' ? '中獎只影響結算，不算進花費'
      : _src === 'gift' ? (_giftBalance === null ? '媽媽禮金餘額讀取中…' : `媽媽禮金剩 ${_fmtMoney(_giftBalance)}，記了會從餘額扣`)
      : '選要抵銷的類別，會扣掉那個類別的花費';
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
    document.getElementById('add-coupon').value = '';
    document.querySelectorAll('#add-modal .cat-chip')
      .forEach(b => b.classList.toggle('active', b.dataset.cat === ''));

    document.getElementById('add-bear-share').value = '';

    _payer  = _defaultPayer();
    document.querySelectorAll('#add-modal .chip[data-payer]')
      .forEach(b => b.classList.toggle('active', b.dataset.payer === _payer));
    _src = 'prize';
    _giftBalance = null;   // 每次打開重讀，避免用到舊餘額
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
    let custody = null;   // 用媽媽禮金時，另寫一筆代管款支出
    const srcInfo = INCOME_SRCS.find(s => s.k === _src);
    if (_mode === 'income' && _src !== 'prize') {
      if (!cat) return _showError('請選要抵銷的類別（例如衣服就選 👗）');
      if (_src === 'gift') {
        if (_giftBalance === null) return _showError('還讀不到媽媽禮金餘額，請稍等再按');
        if (amount > _giftBalance) return _showError(`媽媽禮金只剩 ${_fmtMoney(_giftBalance)}`);
        custody = { date, who: GIFT_WHO, item, amount: -amount, note: `抵銷：${item}` };
      }
      if (_shared === '部分') {
        const bearShare = parseFloat(document.getElementById('add-bear-share').value);
        if (isNaN(bearShare) || bearShare < 0 || bearShare > amount) return _showError('Bear 分到的金額需介於 0 ～ 金額');
        gh = [-(amount - bearShare), -bearShare];
      }
      const incomeNote = `💰 收入：${srcInfo.tag}` + (gh ? `（自訂：Bear 分 ${-gh[1]}）` : '') + (note ? ' ' + note : '');
      row = [
        date, item, -amount, _payer, _shared, cat,
        '', '', incomeNote,
        '手動記帳', '', _nowStr(),
      ];
    } else if (_mode === 'income') {
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
      let rowNote = note;
      if (_shared === '部分') {
        // 與明細編輯／信用卡一致：Bear 金額存備註欄，G/H 寫靜態值
        const bearShare = parseFloat(document.getElementById('add-bear-share').value);
        if (isNaN(bearShare) || bearShare < 0 || bearShare > amount) return _showError('Bear 負擔金額需介於 0 ～ 金額');
        gh = [amount - bearShare, bearShare];
        rowNote = String(bearShare);
      }
      row = [
        date, item, amount, _payer, _shared, cat,
        '', '', rowNote,
        '手動記帳', '', _nowStr(),
      ];
    }

    // 我的優惠券（2026-11-08 Sin）：支出照原價記、共用照原價分，另記一筆 −折抵（共用「-」＝全算 Sin），
    //   同一天、同項目；「先記的帳」比對時用實付（原價－折抵）去對發票／刷卡
    let couponRow = null;
    const coupon = _mode === 'expense' ? parseFloat(document.getElementById('add-coupon').value) : NaN;
    if (coupon > 0) {
      if (coupon > amount) return _showError('優惠券折抵不能大於金額');
      if (!cat) return _showError('用優惠券時請選類別（折抵會扣那個類別的花費）');
      couponRow = [
        date, item, -coupon, _payer, '-', cat,
        '', '', `🎟️ 我的優惠券折抵（原價 ${amount}，實付 ${amount - coupon}）`,
        '手動記帳', '', _nowStr(),
      ];
    }

    const btn = document.getElementById('add-submit');
    btn.disabled    = true;
    btn.textContent = '新增中…';

    try {
      await Sheets.appendMonthlyRow(row, gh);
      if (couponRow) {
        try { await Sheets.appendMonthlyRow(couponRow, null); }
        catch (e) { return _showError('支出已記，但優惠券折抵沒記到：' + e.message + '（請用收入／抵銷補一筆）'); }
      }
      if (custody) {
        try { await Sheets.appendCustody(custody); }
        catch (e) { return _showError('帳本已記，但媽媽禮金餘額沒扣到：' + e.message + '（請到設定頁手動補一筆）'); }
      }
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
