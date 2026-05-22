const Ledger = (() => {
  const CATEGORIES = ['🍴', '🛒', '⛽', '📦', '🎬', '👗', '🏠', '💊', '🧋'];
  const SHARED_OPTS = ['是', '否', '部分', '-', 'x'];
  const ITEM_ATTR_OPTS = ['🌟 Sin', '🐨 Bear', '共用', '部分'];

  const now = new Date();
  let _year  = now.getFullYear();
  let _month = now.getMonth() + 1;
  let _memberFilter   = 'all';
  let _sharedSelected = new Set(); // empty = 全部
  let _catFilter      = '';
  let _sourceFilter   = ''; // '' = 全部
  let _sortMode       = 'date-desc'; // date-desc | date-asc | import-desc | import-asc | amount-desc | amount-asc
  let _searchQuery    = '';
  let _allRows        = [];
  let _pendingFilter   = null;
  let _pendingScrollRow = null;
  let _itemsCache    = null;
  let _itemsCacheTs  = 0;
  let _invoiceCache  = null;
  let _invoiceCacheTs = 0;
  const ITEMS_CACHE_TTL = 5 * 60 * 1000;
  let _expandCCRow   = null; // 展開中發票的 CC 配對列（有配對才非 null）
  let _swipeActiveWrap  = null;
  let _sharedDeleteBg   = null;
  let _activeSubTab    = 'monthly';
  let _invRows         = [];
  let _invSharedFilter = new Set();
  let _invSearchQuery  = '';
  let _ccRows          = [];
  let _ccSharedFilter  = new Set();
  let _ccSearchQuery   = '';
  let _invoiceScrollRow = null;
  let _ccUnlinkRow      = null;
  let _ccUnlinkContext  = null;

  function _collapseActiveSwipe() {
    if (!_swipeActiveWrap) return;
    _swipeActiveWrap.classList.remove('swipe-open');
    if (_sharedDeleteBg) { _sharedDeleteBg.classList.remove('swipe-open'); _sharedDeleteBg.style.display = 'none'; }
    const inner = _swipeActiveWrap.querySelector('.list-item');
    inner.style.transition = 'transform 0.2s';
    inner.style.transform  = '';
    inner.addEventListener('transitionend', () => { inner.style.transition = ''; }, { once: true });
    _swipeActiveWrap = null;
  }

  async function _getItemCache() {
    if (!_itemsCache || Date.now() - _itemsCacheTs >= ITEMS_CACHE_TTL) {
      _itemsCache   = await Sheets.getItemData();
      _itemsCacheTs = Date.now();
    }
    return _itemsCache;
  }

  async function _getInvoiceCache() {
    if (!_invoiceCache || Date.now() - _invoiceCacheTs >= ITEMS_CACHE_TTL) {
      _invoiceCache   = await Sheets.getInvoiceData();
      _invoiceCacheTs = Date.now();
    }
    return _invoiceCache;
  }

  function _clearInvoiceCache() {
    _invoiceCache = null;
    _invoiceCacheTs = 0;
  }

  let _editPayer  = '🌟 Star';
  let _editShared = '是';

  let _invSubEditRow = null;
  let _invSubEditShared = '';
  let _ccSubEditRow = null;
  let _ccSubEditShared = '';

  function _fmt(n) {
    return '$' + Math.abs(n).toLocaleString('zh-TW');
  }

  function _ym() {
    return `${_year}-${String(_month).padStart(2, '0')}`;
  }

  function _isSin() {
    return Auth.getEmail() === 'lovelisa00000@gmail.com';
  }

  function _defaultPayer() {
    const email = (Auth.getEmail() || '').toLowerCase();
    const bearEmail = (CONFIG.EMAIL_WHITELIST?.[1] || '').toLowerCase();
    return email === bearEmail ? '🐨 Bear' : '🌟 Star';
  }

  function _updateMonthLabel() {
    document.getElementById('ledger-month').textContent =
      `${_year} 年 ${String(_month).padStart(2, '0')} 月`;
  }

  function _filtered() {
    let rows = _allRows;
    if (_memberFilter === 'sin')    rows = rows.filter(r => r.sinShare  > 0);
    if (_memberFilter === 'bear')   rows = rows.filter(r => r.bearShare > 0);
    if (_sharedSelected.size > 0) rows = rows.filter(r => _sharedSelected.has(r.shared));
    if (_catFilter)                 rows = rows.filter(r => r.category === _catFilter);
    if (_sourceFilter)              rows = rows.filter(r => r.source === _sourceFilter);
    if (_searchQuery) {
      const q = _searchQuery.toLowerCase();
      rows = rows.filter(r =>
        (r.item || '').toLowerCase().includes(q) ||
        (r.note || '').toLowerCase().includes(q)
      );
    }
    return [...rows].sort((a, b) => {
      switch (_sortMode) {
        case 'date-asc':    return a.date.localeCompare(b.date);
        case 'import-desc': return (b.importedAt || '').localeCompare(a.importedAt || '');
        case 'import-asc':  return (a.importedAt || '').localeCompare(b.importedAt || '');
        case 'amount-desc': return b.amount - a.amount;
        case 'amount-asc':  return a.amount - b.amount;
        default:            return b.date.localeCompare(a.date); // date-desc
      }
    });
  }

  function _renderList() {
    _swipeActiveWrap = null;
    _sharedDeleteBg  = null;
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

    const srcIcon = s => s === '發票' ? '🧾' : s === '信用卡' ? '💳' : (s === '掃描發票' || s === '手查發票') ? '📷' : '✏️';
    const isInvoiceSource = s => s === '發票' || s === '掃描發票' || s === '手查發票';
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
      const noteText    = r.note   ? `<span class="ledger-note"> ${r.note}</span>` : '';
      const isInvoice   = isInvoiceSource(r.source) && r.sourceLink;
      const sharesRow   = shares.length
        ? `<div class="ledger-shares">${shares.join('　')}</div>` : '';
      return `
        <div class="swipe-container">
          <div class="list-item" data-row="${r.rowIndex}" data-is-invoice="${isInvoice ? '1' : ''}">
            <span class="list-item-icon">${cat}</span>
            <div class="list-item-body">
              <div class="list-item-title">${srcIcon(r.source)} ${r.item || '（未命名）'}</div>
              <div class="list-item-sub">${mmdd}　${sharedLabel}${bearBadge}${noteText}</div>
              ${sharesRow}
            </div>
            <div class="list-item-right">
              <div class="amount-expense">${_fmt(r.amount)}</div>
              ${isSin ? `<button class="expand-btn" data-row="${r.rowIndex}">${isInvoice ? '▼' : '✎'}</button>` : ''}
            </div>
          </div>
        </div>`;
    }).join('');

    // expand 按鈕（發票→展開明細；非發票→inline 編輯；swipe 開啟時只 collapse）
    el.querySelectorAll('.expand-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        if (_swipeActiveWrap) { _collapseActiveSwipe(); return; }
        const rowIndex = parseInt(btn.dataset.row, 10);
        const row = _allRows.find(r => r.rowIndex === rowIndex);
        if (!row) return;
        const isInv = isInvoiceSource(row.source) && row.sourceLink;
        if (isInv) _toggleItemDetail(row, btn);
        else _toggleNonInvoiceDetail(row, btn);
      });
    });

    // 右滑刪除
    if (isSin) _setupSwipeDelete(el);

    if (_pendingScrollRow !== null) {
      const rowIndex = _pendingScrollRow;
      _pendingScrollRow = null;
      requestAnimationFrame(() => {
        const target = el.querySelector(`[data-row="${rowIndex}"]`);
        if (target) {
          target.scrollIntoView({ behavior: 'smooth', block: 'center' });
          const container = target.closest('.swipe-container');
          const overlay = document.createElement('div');
          overlay.className = 'highlight-overlay';
          (container || target).appendChild(overlay);
          overlay.addEventListener('animationend', () => { overlay.remove(); });
        }
      });
    }
  }

  // ── 右滑刪除手勢設定 ─────────────────────────────────────────

  function _setupSwipeDelete(containerEl) {
    const SNAP_OPEN = -80;
    const THRESHOLD = -40;
    let _lastTouchEnd = 0;

    // 共用刪除背景（一個列表只建一個，放在 containerEl 內，與各 swipe-container 平行）
    containerEl.style.position = 'relative';
    const sharedBg = document.createElement('div');
    sharedBg.className = 'swipe-delete-bg';
    sharedBg.innerHTML = '<button class="swipe-del-btn">刪除</button>';
    sharedBg.style.display = 'none';
    containerEl.appendChild(sharedBg);
    _sharedDeleteBg = sharedBg;

    function _positionBg(wrap) {
      const wr = wrap.getBoundingClientRect();
      const cr = containerEl.getBoundingClientRect();
      sharedBg.style.top    = (wr.top - cr.top + containerEl.scrollTop) + 'px';
      sharedBg.style.height = wr.height + 'px';
      sharedBg.style.display = '';
      sharedBg.classList.remove('swipe-open');
    }

    sharedBg.querySelector('.swipe-del-btn').addEventListener('click', e => {
      e.stopPropagation();
      const wrap = _swipeActiveWrap;
      if (!wrap) return;
      const rowIndex = parseInt(wrap.querySelector('.list-item').dataset.row, 10);
      const row = _allRows.find(r => r.rowIndex === rowIndex);
      if (!row) return;
      _collapseActiveSwipe();
      const src = row.source || '';
      if (src === '發票' || src === '掃描發票' || src === '手查發票') _openDeleteModal(row);
      else if (src === '信用卡') _openCCDeleteModal(row);
      else _openManualDeleteModal(row);
    });

    containerEl.querySelectorAll('.swipe-container').forEach(wrap => {
      const inner = wrap.querySelector('.list-item');
      if (!inner) return;
      let startX = 0, startY = 0, dragging = false, isHoriz = null, startOffset = 0;

      inner.addEventListener('touchstart', e => {
        if (e.touches.length !== 1) return;
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
        startOffset = _swipeActiveWrap === wrap ? SNAP_OPEN : 0;
        dragging = true;
        isHoriz  = null;
        inner.style.transition = '';
      }, { passive: true });

      // touch-action:pan-y（CSS）已讓瀏覽器自行防止橫向捲動，不需 preventDefault
      inner.addEventListener('touchmove', e => {
        if (!dragging || e.touches.length !== 1) return;
        const dx = e.touches[0].clientX - startX;
        const dy = e.touches[0].clientY - startY;
        if (isHoriz === null) {
          if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
          isHoriz = Math.abs(dx) > Math.abs(dy) * 2;
          if (isHoriz) _positionBg(wrap);  // 確認水平才顯示共用背景
        }
        if (!isHoriz) { dragging = false; return; }
        const x = Math.min(0, Math.max(SNAP_OPEN, startOffset + dx));
        inner.style.transform = `translateX(${x}px)`;
      }, { passive: true });

      inner.addEventListener('touchend', e => {
        _lastTouchEnd = Date.now();
        if (!dragging || !isHoriz) { dragging = false; return; }
        dragging = false;
        const dx = e.changedTouches[0].clientX - startX;
        if (startOffset + dx < THRESHOLD) {
          if (startOffset === SNAP_OPEN && Math.abs(dx) < 20) {
            _collapseActiveSwipe();
          } else {
            if (_swipeActiveWrap && _swipeActiveWrap !== wrap) _collapseActiveSwipe();
            inner.style.transition = 'transform 0.2s';
            inner.style.transform  = `translateX(${SNAP_OPEN}px)`;
            inner.addEventListener('transitionend', () => { inner.style.transition = ''; }, { once: true });
            _positionBg(wrap);
            sharedBg.classList.add('swipe-open');
            _swipeActiveWrap = wrap;
            wrap.classList.add('swipe-open');
          }
        } else {
          inner.style.transition = 'transform 0.2s';
          inner.style.transform  = '';
          sharedBg.classList.remove('swipe-open');
          sharedBg.style.display = 'none';
          inner.addEventListener('transitionend', () => { inner.style.transition = ''; }, { once: true });
          if (_swipeActiveWrap === wrap) { _swipeActiveWrap = null; wrap.classList.remove('swipe-open'); }
        }
      }, { passive: true });

      // 桌面滑鼠支援：touchend 後 500ms 內的 mousedown 為 iOS 合成事件，略過
      let mouseStartX = 0, mouseStartOffset = 0, mouseDragging = false;
      const onMouseMove = e => {
        const dx = e.clientX - mouseStartX;
        if (!mouseDragging) {
          if (Math.abs(dx) < 10) return;
          mouseDragging = true;
          inner.style.transition = '';
          inner.style.cursor = 'grabbing';
          _positionBg(wrap);
        }
        inner.style.transform = `translateX(${Math.min(0, Math.max(SNAP_OPEN, mouseStartOffset + dx))}px)`;
      };
      const onMouseUp = e => {
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        if (!mouseDragging) return;
        mouseDragging = false;
        inner.style.cursor = '';
        const dx = e.clientX - mouseStartX;
        if (mouseStartOffset + dx < THRESHOLD) {
          if (mouseStartOffset === SNAP_OPEN && Math.abs(dx) < 30) {
            _collapseActiveSwipe();
          } else {
            if (_swipeActiveWrap && _swipeActiveWrap !== wrap) _collapseActiveSwipe();
            inner.style.transition = 'transform 0.2s';
            inner.style.transform  = `translateX(${SNAP_OPEN}px)`;
            inner.addEventListener('transitionend', () => { inner.style.transition = ''; }, { once: true });
            _positionBg(wrap);
            sharedBg.classList.add('swipe-open');
            _swipeActiveWrap = wrap;
            wrap.classList.add('swipe-open');
          }
        } else {
          inner.style.transition = 'transform 0.2s';
          inner.style.transform  = '';
          sharedBg.classList.remove('swipe-open');
          sharedBg.style.display = 'none';
          inner.addEventListener('transitionend', () => { inner.style.transition = ''; }, { once: true });
          if (_swipeActiveWrap === wrap) { _swipeActiveWrap = null; wrap.classList.remove('swipe-open'); }
        }
      };
      inner.addEventListener('mousedown', e => {
        if (e.button !== 0) return;
        if (Date.now() - _lastTouchEnd < 500) return;
        mouseStartX = e.clientX;
        mouseStartOffset = _swipeActiveWrap === wrap ? SNAP_OPEN : 0;
        mouseDragging = false;
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
      });
    });
  }

  function _setupCCUnlinkSwipe(containerEl) {
    const SNAP_OPEN = -80;
    const THRESHOLD = -40;
    let _lastTouchEnd = 0;

    containerEl.style.position = 'relative';
    const sharedBg = document.createElement('div');
    sharedBg.className = 'swipe-delete-bg swipe-unlink-bg';
    sharedBg.innerHTML = '<button class="swipe-del-btn swipe-unlink-btn">解除</button>';
    sharedBg.style.display = 'none';
    containerEl.appendChild(sharedBg);
    _sharedDeleteBg = sharedBg;

    function _positionBg(wrap) {
      const wr = wrap.getBoundingClientRect();
      const cr = containerEl.getBoundingClientRect();
      sharedBg.style.top    = (wr.top - cr.top + containerEl.scrollTop) + 'px';
      sharedBg.style.height = wr.height + 'px';
      sharedBg.style.display = '';
      sharedBg.classList.remove('swipe-open');
    }

    sharedBg.querySelector('.swipe-unlink-btn').addEventListener('click', e => {
      e.stopPropagation();
      const wrap = _swipeActiveWrap;
      if (!wrap) return;
      const rowIndex = parseInt(wrap.querySelector('.list-item').dataset.row, 10);
      const row = _ccRows.find(r => r.rowIndex === rowIndex);
      if (!row || !row.matched) return;
      _collapseActiveSwipe();
      _openCCUnlinkModal(row);
    });

    containerEl.querySelectorAll('.cc-link-wrap').forEach(wrap => {
      const inner = wrap.querySelector('.list-item');
      if (!inner) return;
      let startX = 0, startY = 0, dragging = false, isHoriz = null, startOffset = 0;

      inner.addEventListener('touchstart', e => {
        if (e.touches.length !== 1) return;
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
        startOffset = _swipeActiveWrap === wrap ? SNAP_OPEN : 0;
        dragging = true;
        isHoriz  = null;
        inner.style.transition = '';
      }, { passive: true });

      inner.addEventListener('touchmove', e => {
        if (!dragging || e.touches.length !== 1) return;
        const dx = e.touches[0].clientX - startX;
        const dy = e.touches[0].clientY - startY;
        if (isHoriz === null) {
          if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
          isHoriz = Math.abs(dx) > Math.abs(dy) * 2;
          if (isHoriz) _positionBg(wrap);
        }
        if (!isHoriz) { dragging = false; return; }
        inner.style.transform = `translateX(${Math.min(0, Math.max(SNAP_OPEN, startOffset + dx))}px)`;
      }, { passive: true });

      inner.addEventListener('touchend', e => {
        _lastTouchEnd = Date.now();
        if (!dragging || !isHoriz) { dragging = false; return; }
        dragging = false;
        const dx = e.changedTouches[0].clientX - startX;
        if (startOffset + dx < THRESHOLD) {
          if (startOffset === SNAP_OPEN && Math.abs(dx) < 20) {
            _collapseActiveSwipe();
          } else {
            if (_swipeActiveWrap && _swipeActiveWrap !== wrap) _collapseActiveSwipe();
            inner.style.transition = 'transform 0.2s';
            inner.style.transform  = `translateX(${SNAP_OPEN}px)`;
            inner.addEventListener('transitionend', () => { inner.style.transition = ''; }, { once: true });
            _positionBg(wrap);
            sharedBg.classList.add('swipe-open');
            _swipeActiveWrap = wrap;
            wrap.classList.add('swipe-open');
          }
        } else {
          inner.style.transition = 'transform 0.2s';
          inner.style.transform  = '';
          sharedBg.classList.remove('swipe-open');
          sharedBg.style.display = 'none';
          inner.addEventListener('transitionend', () => { inner.style.transition = ''; }, { once: true });
          if (_swipeActiveWrap === wrap) { _swipeActiveWrap = null; wrap.classList.remove('swipe-open'); }
        }
      }, { passive: true });

      let mouseStartX = 0, mouseStartOffset = 0, mouseDragging = false;
      const onMouseMove = e => {
        const dx = e.clientX - mouseStartX;
        if (!mouseDragging) {
          if (Math.abs(dx) < 10) return;
          mouseDragging = true;
          inner.style.transition = '';
          inner.style.cursor = 'grabbing';
          _positionBg(wrap);
        }
        inner.style.transform = `translateX(${Math.min(0, Math.max(SNAP_OPEN, mouseStartOffset + dx))}px)`;
      };
      const onMouseUp = e => {
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        if (!mouseDragging) return;
        mouseDragging = false;
        inner.style.cursor = '';
        const dx = e.clientX - mouseStartX;
        if (mouseStartOffset + dx < THRESHOLD) {
          if (mouseStartOffset === SNAP_OPEN && Math.abs(dx) < 30) {
            _collapseActiveSwipe();
          } else {
            if (_swipeActiveWrap && _swipeActiveWrap !== wrap) _collapseActiveSwipe();
            inner.style.transition = 'transform 0.2s';
            inner.style.transform  = `translateX(${SNAP_OPEN}px)`;
            inner.addEventListener('transitionend', () => { inner.style.transition = ''; }, { once: true });
            _positionBg(wrap);
            sharedBg.classList.add('swipe-open');
            _swipeActiveWrap = wrap;
            wrap.classList.add('swipe-open');
          }
        } else {
          inner.style.transition = 'transform 0.2s';
          inner.style.transform  = '';
          sharedBg.classList.remove('swipe-open');
          sharedBg.style.display = 'none';
          inner.addEventListener('transitionend', () => { inner.style.transition = ''; }, { once: true });
          if (_swipeActiveWrap === wrap) { _swipeActiveWrap = null; wrap.classList.remove('swipe-open'); }
        }
      };
      inner.addEventListener('mousedown', e => {
        if (e.button !== 0) return;
        if (Date.now() - _lastTouchEnd < 500) return;
        mouseStartX = e.clientX;
        mouseStartOffset = _swipeActiveWrap === wrap ? SNAP_OPEN : 0;
        mouseDragging = false;
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
      });
    });
  }

  // ── 手動記帳刪除（直接 confirm）──────────────────────────────

  function _openManualDeleteModal(row) {
    if (!confirm(`確定刪除「${row.item || '此筆'}」？此操作無法復原。`)) return;
    const ym = row.date.slice(0, 7);
    Sheets.deleteMonthlyRow(row.rowIndex, ym)
      .then(() => { _load(); window.Home?.reload(); })
      .catch(e => alert('刪除失敗：' + e.message));
  }

  // ── CC 月度帳本列刪除 Modal ──────────────────────────────────

  function _buildCCDeleteModal() {
    if (document.getElementById('del-cc-modal')) return;
    const el = document.createElement('div');
    el.id = 'del-cc-modal';
    el.className = 'modal-overlay hidden';
    el.innerHTML = `
      <div class="modal-sheet">
        <div class="modal-header">
          <span class="modal-title" id="del-cc-title">刪除</span>
          <button class="modal-close" id="del-cc-close">✕</button>
        </div>
        <div class="modal-body">
          <p style="font-size:13px;color:var(--text-sub);margin-bottom:12px;">以下關聯資料將一起處理，請確認後再刪除。</p>
          <div class="del-section">
            <div class="del-section-header">
              <input type="checkbox" id="del-cc-chk-monthly" checked disabled>
              <label for="del-cc-chk-monthly" class="del-section-label">月度帳本（此筆）</label>
            </div>
          </div>
          <div class="del-section">
            <div class="del-section-header">
              <input type="checkbox" id="del-cc-chk-reset" checked>
              <label for="del-cc-chk-reset" class="del-section-label">重設信用卡已匯入狀態</label>
            </div>
          </div>
          <p id="del-cc-error" class="add-error hidden" style="margin-top:12px;"></p>
        </div>
        <div class="modal-footer">
          <button class="btn-secondary" id="del-cc-cancel">取消</button>
          <button class="btn-primary" id="del-cc-confirm">確認刪除</button>
        </div>
      </div>`;
    document.body.appendChild(el);
    document.getElementById('del-cc-close').addEventListener('click',  _closeCCDeleteModal);
    document.getElementById('del-cc-cancel').addEventListener('click', _closeCCDeleteModal);
    el.addEventListener('click', e => { if (e.target === el) _closeCCDeleteModal(); });
    document.getElementById('del-cc-confirm').addEventListener('click', _confirmCCDelete);
  }

  function _openCCDeleteModal(row) {
    _buildCCDeleteModal();
    _deleteModalRow = row;
    document.getElementById('del-cc-title').textContent = `刪除 ${row.item || '此筆'}`;
    document.getElementById('del-cc-error').classList.add('hidden');
    document.getElementById('del-cc-confirm').disabled    = false;
    document.getElementById('del-cc-confirm').textContent = '確認刪除';
    document.getElementById('del-cc-modal').classList.remove('hidden');
  }

  function _closeCCDeleteModal() {
    document.getElementById('del-cc-modal')?.classList.add('hidden');
    _deleteModalRow = null;
  }

  async function _confirmCCDelete() {
    const row = _deleteModalRow;
    if (!row) return;
    const doReset = document.getElementById('del-cc-chk-reset').checked;
    const errEl   = document.getElementById('del-cc-error');
    const btn     = document.getElementById('del-cc-confirm');
    errEl.classList.add('hidden');
    btn.disabled    = true;
    btn.textContent = '刪除中…';
    try {
      if (doReset) {
        const ccRow = await Sheets.findCCRowByDateAmount(row.date, row.amount);
        if (ccRow) await Sheets.resetCCImported(ccRow.rowIndex);
      }
      await Sheets.deleteMonthlyRow(row.rowIndex, row.date.slice(0, 7));
      _closeCCDeleteModal();
      await _load();
      window.Home?.reload();
    } catch (e) {
      errEl.textContent = '刪除失敗：' + e.message;
      errEl.classList.remove('hidden');
      btn.disabled    = false;
      btn.textContent = '確認刪除';
    }
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

  function _resetFilters() {
    _memberFilter   = 'all';
    _sharedSelected = new Set();
    _catFilter      = '';
    _sourceFilter   = '';
    _sortMode       = 'date-desc';
    _searchQuery    = '';
    document.querySelectorAll('#tab-ledger .chip[data-member]')
      .forEach(b => b.classList.toggle('active', b.dataset.member === 'all'));
    document.querySelectorAll('#tab-ledger .chip[data-shared-filter]')
      .forEach(b => b.classList.toggle('active', b.dataset.sharedFilter === 'all'));
    const srcSel = document.getElementById('ledger-source');
    if (srcSel) srcSel.value = '';
    const sel = document.getElementById('ledger-cat');
    if (sel) sel.value = '';
    const sort = document.getElementById('ledger-sort');
    if (sort) sort.value = 'date-desc';
    const search = document.getElementById('ledger-search');
    if (search) search.value = '';
    const clearBtn = document.getElementById('ledger-search-clear');
    if (clearBtn) clearBtn.classList.add('hidden');
  }

  function _applyFilter(f) {
    if (f.member !== undefined) {
      _memberFilter = f.member;
      document.querySelectorAll('#tab-ledger .chip[data-member]').forEach(b => {
        b.classList.toggle('active', b.dataset.member === _memberFilter);
      });
    }
    if (f.shared !== undefined) {
      const STATS_MAP = { all: [], shared: ['是', '部分'], bear: ['否'], personal: ['-'] };
      const vals = STATS_MAP[f.shared] ?? [];
      _sharedSelected = new Set(vals);
      const chips = document.querySelectorAll('#tab-ledger .chip[data-shared-filter]');
      if (_sharedSelected.size === 0) {
        chips.forEach(b => b.classList.toggle('active', b.dataset.sharedFilter === 'all'));
      } else {
        chips.forEach(b => b.classList.toggle('active', _sharedSelected.has(b.dataset.sharedFilter)));
      }
    }
    if (f.category !== undefined) {
      _catFilter = f.category;
      const sel = document.getElementById('ledger-cat');
      if (sel) sel.value = _catFilter;
    }
  }

  function _hasPlatformKeyword(text = '') {
    const s = String(text || '').toLowerCase();
    return CONFIG.CC_PAY_KEYWORDS.some(kw => s.includes(String(kw).toLowerCase()));
  }

  async function _getCCLinkContext(row) {
    const invNum = row?.matched || '';
    if (!invNum) return { invNum: '', invoice: null, monthlyRows: [], platformRows: [], mode: 'none' };
    const [allInvoices, monthlyRows] = await Promise.all([
      _getInvoiceCache(),
      Sheets.getMonthlyData(_year, _month),
    ]);
    _allRows = monthlyRows;
    const invoice = allInvoices.find(inv => inv.invNum === invNum) || null;
    const linkedMonthly = monthlyRows.filter(r => r.sourceLink === invNum);
    const appMonthly = linkedMonthly.filter(r => r.source === '掃描發票' || r.source === '手查發票');
    const invoiceAmount = invoice?.amount || 0;
    const platformRows = appMonthly.filter(r =>
      Math.abs((r.amount || 0) - (row.amount || 0)) <= 1 &&
      (_hasPlatformKeyword(invoice?.note) || _hasPlatformKeyword(r.note)) &&
      (!(r.note || '').trim() || Math.abs(invoiceAmount - (row.amount || 0)) > 1)
    );
    return {
      invNum,
      invoice,
      monthlyRows: linkedMonthly,
      platformRows,
      mode: platformRows.length ? 'platform' : 'duplicate',
    };
  }

  function _highlightTarget(target) {
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const overlay = document.createElement('div');
    overlay.className = 'highlight-overlay';
    target.appendChild(overlay);
    overlay.addEventListener('animationend', () => { overlay.remove(); });
  }

  function _setSubTab(tab) {
    _activeSubTab = tab;
    document.querySelectorAll('.sub-tab-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.subtab === tab));
    document.getElementById('monthly-section')?.classList.toggle('hidden', tab !== 'monthly');
    document.getElementById('inv-section')?.classList.toggle('hidden', tab !== 'invoice');
    document.getElementById('cc-section')?.classList.toggle('hidden', tab !== 'cc');
  }

  async function _jumpToInvoice(invRowIndex) {
    if (!invRowIndex) return;
    _invoiceScrollRow = invRowIndex;
    _setSubTab('invoice');
    _invSearchQuery = '';
    _invSharedFilter = new Set();
    const search = document.getElementById('inv-search');
    if (search) search.value = '';
    document.getElementById('inv-search-clear')?.classList.add('hidden');
    document.querySelectorAll('#inv-shared-chips .chip')
      .forEach(b => b.classList.toggle('active', b.dataset.invShared === 'all'));
    await _loadInvoiceTab();
  }

  function _jumpToMonthly(rowIndex) {
    if (!rowIndex) return;
    _setSubTab('monthly');
    _resetFilters();
    _pendingScrollRow = rowIndex;
    _renderList();
  }

  // ── CC 配對 G/H 計算（cc-gh-logic.md）───────────────────────
  // items: 品項陣列（含 attribution、custom、itemAmount）；shared: 是/否/-/部分；ccAmount: CC 金額
  function _calcPlatformSplit(items, shared, ccAmount) {
    if (shared === '是') { const s = Math.floor(ccAmount / 2); return { sinShare: s, bearShare: ccAmount - s }; }
    if (shared === '否') return { sinShare: 0, bearShare: ccAmount };
    if (shared === '-')  return { sinShare: ccAmount, bearShare: 0 };
    // 部分：品項歸屬 + CC差額平分
    const invTotal = items.reduce((sum, it) => sum + (it.itemAmount || 0), 0);
    const bearFood = items.reduce((sum, it) => {
      if (it.attribution === '🐨 Bear') return sum + it.itemAmount;
      if (it.attribution === '共用') {
        const c = parseFloat(it.custom);
        return sum + (isNaN(c) ? Math.floor(it.itemAmount / 2) : c);
      }
      return sum;
    }, 0);
    const sinFood = invTotal - bearFood;
    const diff    = ccAmount - invTotal;
    const diffSin = Math.floor(diff / 2);
    return { sinShare: sinFood + diffSin, bearShare: bearFood + (diff - diffSin) };
  }

  // ── 展開品項（可編輯，F20）────────────────────────────────────

  async function _toggleItemDetail(row, btnEl) {
    const detailId = `item-detail-${row.rowIndex}`;
    const listItem = btnEl.closest('.list-item');
    const existing = document.getElementById(detailId);
    if (existing) { existing.remove(); btnEl.textContent = '▼'; _expandCCRow = null; return; }

    btnEl.textContent = '…';
    try {
      const invNum  = row.sourceLink;
      // 品項、發票與 CC 連結互不相依，平行抓可避免展開時累加 Sheets 延遲。
      const [allItems, allInvoices, ccRows] = await Promise.all([
        _getItemCache(),
        _getInvoiceCache(),
        Sheets.getCCForInvoice(invNum),
      ]);
      const invRow  = allInvoices.find(inv => inv.invNum === invNum);
      const invItems = allItems.filter(it => it.invNum === invNum);
      _expandCCRow = ccRows.length ? ccRows[0] : null;

      const detail = document.createElement('div');
      detail.id        = detailId;
      detail.className = 'item-detail-list';

      const isSin = _isSin();

      // ── 備註聚合（月度 / [R] 發票 / [1][2]... 品項）──────────
      const noteParts = [];
      if (row.note)     noteParts.push(row.note);
      if (invRow?.note) noteParts.push(`[R] ${invRow.note}`);
      invItems.forEach((it, idx) => { if (it.note) noteParts.push(`[${idx + 1}] ${it.note}`); });
      if (noteParts.length) {
        const noteAgg = document.createElement('div');
        noteAgg.className = 'note-aggregate';
        noteAgg.textContent = noteParts.join(' / ');
        detail.appendChild(noteAgg);
      }

      // ── 發票層欄位（可編輯，Sin only）────────────────────────
      const invSection = _buildInvoiceEditSection(row, invRow, isSin, _expandCCRow);
      detail.appendChild(invSection);

      // ── 品項層 ────────────────────────────────────────────────
      if (!invItems.length) {
        const empty = document.createElement('div');
        empty.className = 'item-detail-empty';
        empty.textContent = '無品項明細';
        detail.appendChild(empty);
      } else {
        invItems.forEach(it => {
          const itRow = _buildItemEditRow(it, isSin, _expandCCRow);
          detail.appendChild(itRow);
        });
      }

      (listItem.closest('.swipe-container') || listItem).insertAdjacentElement('afterend', detail);
      detail.querySelectorAll('input[data-notechips]').forEach(inp => {
        if (inp.id) NoteChips?.render(inp.id);
      });
      btnEl.textContent = '▲';
    } catch (e) {
      btnEl.textContent = '▼';
    }
  }

  // ── 非發票列 inline 展開編輯（手動記帳 / CC月度）────────────

  function _toggleNonInvoiceDetail(row, btnEl) {
    const detailId = `ne-detail-${row.rowIndex}`;
    const listItem = btnEl.closest('.list-item');
    const existing = document.getElementById(detailId);
    if (existing) { existing.remove(); btnEl.textContent = '✎'; return; }

    btnEl.textContent = '▲';

    const catOpts = ['', ...CATEGORIES].map(c =>
      `<option value="${c}" ${(row.category || '') === c ? 'selected' : ''}>${c || '（未分類）'}</option>`
    ).join('');

    const sharedChips = SHARED_OPTS.map(v =>
      `<button class="chip ne-shared-chip${(row.shared || '是') === v ? ' active' : ''}" data-val="${v}">${v}</button>`
    ).join('');

    const rowPayer = row.payer || _defaultPayer();
    const payerSin  = rowPayer === '🌟 Star' ? ' active' : '';
    const payerBear = rowPayer === '🐨 Bear' ? ' active' : '';

    const detail = document.createElement('div');
    detail.id = detailId;
    detail.className = 'item-detail-list';
    detail.innerHTML = `
      <div class="inv-edit-section">
        <div class="inv-edit-row">
          <span class="inv-edit-label">日期</span>
          <input type="date" class="ne-date field-input" style="height:36px;font-size:13px;padding:4px 8px;" value="${row.date}">
        </div>
        <div class="inv-edit-row">
          <span class="inv-edit-label">項目</span>
          <input type="text" class="ne-item field-input" style="height:36px;font-size:13px;padding:4px 8px;" value="${row.item || ''}">
        </div>
        <div class="inv-edit-row">
          <span class="inv-edit-label">金額</span>
          <input type="number" class="ne-amount field-input" style="height:36px;font-size:13px;padding:4px 8px;" value="${row.amount || ''}">
        </div>
        <div class="inv-edit-row">
          <span class="inv-edit-label">類別</span>
          <select class="ne-cat field-input cat-select" style="height:36px;font-size:13px;padding:4px 8px;">${catOpts}</select>
        </div>
        <div class="inv-edit-row">
          <span class="inv-edit-label">付款人</span>
          <div class="chip-row ne-payer-chips">
            <button class="chip ne-payer-chip${payerSin}"  data-payer="🌟 Star">🌟 Sin 付</button>
            <button class="chip ne-payer-chip${payerBear}" data-payer="🐨 Bear">🐨 Bear 付</button>
          </div>
        </div>
        <div class="inv-edit-row">
          <span class="inv-edit-label">共用</span>
          <div class="chip-row ne-shared-chips" style="margin-bottom:0;">${sharedChips}</div>
        </div>
        <div class="inv-edit-row">
          <span class="inv-edit-label">備註</span>
          <input type="text" id="ne-note-${row.rowIndex}" class="ne-note field-input" data-notechips="true" style="height:36px;font-size:13px;padding:4px 8px;" value="${row.note || ''}">
        </div>
        <div class="inv-edit-actions">
          <button class="ne-save btn-primary" style="padding:7px 18px;font-size:13px;">儲存</button>
          <span class="ne-save-msg" style="font-size:12px;color:var(--teal);display:none;">✓ 已儲存</span>
        </div>
        <p class="ne-edit-error hidden" style="font-size:12px;color:var(--salmon);"></p>
      </div>`;

    let currentPayer  = rowPayer;
    let currentShared = row.shared || '是';

    detail.querySelectorAll('.ne-payer-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        detail.querySelectorAll('.ne-payer-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        currentPayer = chip.dataset.payer;
      });
    });

    detail.querySelectorAll('.ne-shared-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        detail.querySelectorAll('.ne-shared-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        currentShared = chip.dataset.val;
      });
    });

    detail.querySelector('.ne-save').addEventListener('click', async () => {
      const date   = detail.querySelector('.ne-date').value;
      const item   = detail.querySelector('.ne-item').value.trim();
      const amount = parseFloat(detail.querySelector('.ne-amount').value);
      const cat    = detail.querySelector('.ne-cat').value;
      const note   = detail.querySelector('.ne-note').value.trim();
      const errEl  = detail.querySelector('.ne-edit-error');
      const btn    = detail.querySelector('.ne-save');

      if (!date || !item || isNaN(amount)) {
        errEl.textContent = '日期、項目、金額為必填';
        errEl.classList.remove('hidden');
        return;
      }

      btn.disabled = true;
      btn.textContent = '儲存中…';
      errEl.classList.add('hidden');

      try {
        await Sheets.updateMonthlyRow(row.rowIndex, [
          date, item, amount, currentPayer, currentShared, cat,
          row.sinShare  !== undefined && row.sinShare  !== '' ? row.sinShare  : '',
          row.bearShare !== undefined && row.bearShare !== '' ? row.bearShare : '',
          note,
          row.source     || '手動記帳',
          row.sourceLink || '',
          row.importedAt || '',
        ]);
        const ymOrig = row.date.slice(0, 7);
        const ymNew  = date.slice(0, 7);
        Sheets.invalidateMonth(ymOrig);
        if (ymNew !== ymOrig) Sheets.invalidateMonth(ymNew);
        await _load();
        window.Home?.reload();
      } catch (e) {
        errEl.textContent = '儲存失敗：' + e.message;
        errEl.classList.remove('hidden');
        btn.disabled = false;
        btn.textContent = '儲存';
      }
    });

    (listItem.closest('.swipe-container') || listItem).insertAdjacentElement('afterend', detail);
    NoteChips?.render(`ne-note-${row.rowIndex}`);
  }

  // ── 發票層編輯區（G 類別 / H 是否共用 / I 備註）─────────────

  function _buildInvoiceEditSection(monthlyRow, invRow, isSin, ccRow) {
    const wrap = document.createElement('div');
    wrap.className = 'inv-edit-section';

    if (!invRow) {
      const note = document.createElement('div');
      note.className = 'item-detail-empty';
      note.textContent = '找不到原始發票資料';
      wrap.appendChild(note);
      return wrap;
    }

    if (!isSin) {
      // 唯讀：只顯示類別/共用/備註
      wrap.innerHTML = `
        <div class="inv-edit-row">
          <span class="inv-edit-label">類別</span>
          <span class="inv-edit-val">${invRow.category || '—'}</span>
        </div>
        <div class="inv-edit-row">
          <span class="inv-edit-label">共用</span>
          <span class="inv-edit-val">${invRow.shared || '—'}</span>
        </div>
        <div class="inv-edit-row">
          <span class="inv-edit-label">備註</span>
          <span class="inv-edit-val">${invRow.note || '—'}</span>
        </div>`;
      return wrap;
    }

    // 可編輯版
    const catOpts = ['', ...CATEGORIES].map(c =>
      `<option value="${c}" ${invRow.category === c ? 'selected' : ''}>${c || '（未分類）'}</option>`
    ).join('');

    const sharedChips = SHARED_OPTS.map(v =>
      `<button class="chip inv-shared-chip${invRow.shared === v ? ' active' : ''}" data-val="${v}">${v}</button>`
    ).join('');

    wrap.innerHTML = `
      <div class="inv-edit-header">發票欄位</div>
      <div class="inv-edit-row">
        <span class="inv-edit-label">類別</span>
        <select class="inv-cat-select field-input" style="height:36px;font-size:13px;padding:4px 8px;">
          ${catOpts}
        </select>
      </div>
      <div class="inv-edit-row inv-shared-row">
        <span class="inv-edit-label">共用</span>
        <div class="chip-row inv-shared-chips" style="margin-bottom:0;">${sharedChips}</div>
      </div>
      <div class="inv-edit-row">
        <span class="inv-edit-label">備註</span>
        <input type="text" id="inv-note-${monthlyRow.rowIndex}" class="inv-note-input field-input" data-notechips="true" style="font-size:13px;padding:4px 8px;" value="${invRow.note || ''}">
      </div>
      <div class="inv-edit-actions">
        <button class="btn-inv-save btn-primary" style="padding:7px 18px;font-size:13px;">儲存發票欄位</button>
        <span class="inv-save-msg" style="font-size:12px;color:var(--teal);display:none;">✓ 已儲存</span>
      </div>
      <p class="inv-edit-error hidden" style="font-size:12px;color:var(--salmon);"></p>`;

    // 追蹤目前 shared 選擇
    let currentShared = invRow.shared || '';

    wrap.querySelectorAll('.inv-shared-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        wrap.querySelectorAll('.inv-shared-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        currentShared = chip.dataset.val;
      });
    });

    wrap.querySelector('.btn-inv-save').addEventListener('click', async () => {
      const newCat    = wrap.querySelector('.inv-cat-select').value;
      const newShared = currentShared;
      const newNote   = wrap.querySelector('.inv-note-input').value.trim();
      await _saveInvoiceFields(invRow, monthlyRow, newCat, newShared, newNote, wrap, ccRow);
    });

    return wrap;
  }

  // ── 通用確認 Modal（含取消按鈕，取代原生 alert/confirm）──────

  function _showConfirm(message) {
    return new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.innerHTML = `
        <div class="modal-sheet" style="max-height:50dvh;">
          <div class="modal-body" style="gap:16px;padding-top:24px;">
            <p style="font-size:14px;line-height:1.6;">${message}</p>
          </div>
          <div class="modal-footer">
            <button class="btn-secondary" id="sc-cancel">取消</button>
            <button class="btn-primary" id="sc-ok">確認</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      overlay.querySelector('#sc-cancel').addEventListener('click', () => { overlay.remove(); resolve(false); });
      overlay.querySelector('#sc-ok').addEventListener('click',     () => { overlay.remove(); resolve(true);  });
    });
  }

  // ── 儲存發票層欄位（含月度帳本同步與特殊情境）──────────────

  async function _saveInvoiceFields(invRow, monthlyRow, newCat, newShared, newNote, wrapEl, ccRow) {
    const errEl = wrapEl.querySelector('.inv-edit-error');
    const msgEl = wrapEl.querySelector('.inv-save-msg');
    const btn   = wrapEl.querySelector('.btn-inv-save');
    errEl.classList.add('hidden');
    btn.disabled = true;
    btn.textContent = '儲存中…';

    const oldShared = invRow.shared || '';
    const ym        = monthlyRow.date.slice(0, 7);

    try {
      // ── H 欄特殊情境 ──────────────────────────────────────────
      if (newShared === 'x' && oldShared !== 'x') {
        // 改成 x：警告並刪月度帳本
        if (!confirm(`此發票的月度帳本記錄將被刪除，確認繼續？`)) {
          btn.disabled = false;
          btn.textContent = '儲存發票欄位';
          return;
        }
        // 刪月度帳本該列
        await Sheets.deleteMonthlyRow(monthlyRow.rowIndex, ym);
        // 更新發票 H/G/I
        await Sheets.updateInvoiceFields(invRow.rowIndex, { category: newCat, shared: newShared, note: newNote });
        _clearInvoiceCache();
        // 重建 UI（月度列已消失）
        _itemsCache = null;
        await _load();
        window.Home?.reload();
        return;
      }

      if (newShared === '部分' && oldShared !== '部分') {
        // 改成部分：需先設定品項歸屬
        if (!_itemsCache || Date.now() - _itemsCacheTs >= ITEMS_CACHE_TTL) {
          _itemsCache   = await Sheets.getItemData();
          _itemsCacheTs = Date.now();
        }
        const invItems = _itemsCache.filter(it => it.invNum === invRow.invNum);

        if (invItems.length) {
          // 有品項 → 開品項歸屬 modal
          btn.disabled = false;
          btn.textContent = '儲存發票欄位';
          _openItemAttrModal(invRow, monthlyRow, invItems, newCat, newNote, wrapEl, ccRow);
          return;
        } else {
          // 無品項 → 讓使用者選擇
          const choice = await _promptNoItemsPartial();
          if (choice === null) {
            btn.disabled = false;
            btn.textContent = '儲存發票欄位';
            return; // 取消
          }
          // 在品項明細建一筆整體品項，讓公式鏈（發票明細 K + 月度帳本 G/H）自動計算
          await Sheets.appendSyntheticItemRow(
            { carrier: invRow.carrier, date: invRow.date, invNum: invRow.invNum, shop: invRow.shop },
            { itemName: invRow.shop || '（整體）', itemAmount: invRow.amount,
              attribution: '共用', customAmount: String(choice.bearShare),
              note: '新增此欄用以修改自訂Bear負擔金額' }
          );
          await Sheets.updateInvoiceFields(invRow.rowIndex, { category: newCat, shared: newShared, note: newNote });
          _clearInvoiceCache();
          // 月度帳本 E/F 更新；G/H 由公式自動重算，不直接寫入
          await Sheets.updateMonthlyFields(monthlyRow.rowIndex, { shared: '部分', category: newCat }, ym);
          // CC 連結：靜態 G/H 需手動重算
          if (ccRow) {
            const syntheticItem = { itemAmount: invRow.amount, attribution: '共用', custom: String(choice.bearShare) };
            const { sinShare, bearShare } = _calcPlatformSplit([syntheticItem], '部分', ccRow.amount);
            await Sheets.updateMonthlyGH(monthlyRow.rowIndex, sinShare, bearShare, ym);
          }
        }
      } else if (oldShared === '部分' && ['是', '否', '-'].includes(newShared)) {
        // 部分 → 其他：清掉所有品項 G 歸屬
        if (!_itemsCache || Date.now() - _itemsCacheTs >= ITEMS_CACHE_TTL) {
          _itemsCache   = await Sheets.getItemData();
          _itemsCacheTs = Date.now();
        }
        const invItems = _itemsCache.filter(it => it.invNum === invRow.invNum);
        if (invItems.length) {
          const ok = await _showConfirm('此發票有品項歸屬，品項歸屬將一起清除，請至品項重新確認。確認繼續？');
          if (!ok) {
            btn.disabled = false;
            btn.textContent = '儲存發票欄位';
            return;
          }
          for (const it of invItems) {
            await Sheets.updateItemFields(it.rowIndex, { attribution: '', customAmount: '' });
          }
          _itemsCache = null;
        }
        await Sheets.updateInvoiceFields(invRow.rowIndex, { category: newCat, shared: newShared, note: newNote });
        _clearInvoiceCache();
        await Sheets.updateMonthlyFields(monthlyRow.rowIndex, { shared: newShared, category: newCat }, ym);
        // CC 連結：靜態 G/H 需手動重算（品項歸屬已清除，items 傳 []）
        if (ccRow) {
          const { sinShare, bearShare } = _calcPlatformSplit([], newShared, ccRow.amount);
          await Sheets.updateMonthlyGH(monthlyRow.rowIndex, sinShare, bearShare, ym);
        }
      } else {
        // 一般情況
        await Sheets.updateInvoiceFields(invRow.rowIndex, { category: newCat, shared: newShared, note: newNote });
        _clearInvoiceCache();
        await Sheets.updateMonthlyFields(monthlyRow.rowIndex, { shared: newShared, category: newCat }, ym);
        // CC 連結：靜態 G/H 需手動重算
        if (ccRow) {
          const currentItems = (_itemsCache || []).filter(it => it.invNum === invRow.invNum);
          const { sinShare, bearShare } = _calcPlatformSplit(currentItems, newShared, ccRow.amount);
          await Sheets.updateMonthlyGH(monthlyRow.rowIndex, sinShare, bearShare, ym);
        }
      }

      msgEl.style.display = 'inline';
      setTimeout(() => { msgEl.style.display = 'none'; }, 2000);
      _itemsCache = null;
      await _load();
      window.Home?.reload();
    } catch (e) {
      errEl.textContent = '儲存失敗：' + e.message;
      errEl.classList.remove('hidden');
    } finally {
      btn.disabled = false;
      btn.textContent = '儲存發票欄位';
    }
  }

  // ── 無品項→部分：詢問使用者要取消或填自訂金額 ───────────────

  function _promptNoItemsPartial() {
    return new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.innerHTML = `
        <div class="modal-sheet" style="max-height:60dvh;">
          <div class="modal-header">
            <span class="modal-title">改為「部分共用」</span>
          </div>
          <div class="modal-body" style="gap:12px;">
            <p style="font-size:14px;color:var(--text-sub);">此發票無品項明細，請選擇處理方式：</p>
            <button class="btn-secondary" id="pnp-cancel">取消（按錯了）</button>
            <div style="display:flex;flex-direction:column;gap:8px;margin-top:4px;">
              <label class="field-label" style="margin:0;">Bear 負擔金額</label>
              <div class="amount-wrap">
                <span class="amount-prefix">$</span>
                <input type="number" id="pnp-bear" class="field-input amount-input" min="0" step="1" inputmode="decimal" placeholder="輸入 Bear 負擔金額">
              </div>
              <button class="btn-primary" id="pnp-confirm">確認自訂金額</button>
            </div>
          </div>
        </div>`;
      document.body.appendChild(overlay);

      overlay.querySelector('#pnp-cancel').addEventListener('click', () => {
        overlay.remove(); resolve(null);
      });
      overlay.querySelector('#pnp-confirm').addEventListener('click', () => {
        const bear = parseFloat(overlay.querySelector('#pnp-bear').value);
        if (isNaN(bear) || bear < 0) {
          let errEl = overlay.querySelector('#pnp-error');
          if (!errEl) {
            errEl = document.createElement('p');
            errEl.id = 'pnp-error';
            errEl.style.cssText = 'font-size:12px;color:var(--salmon);margin:4px 0 0;';
            overlay.querySelector('#pnp-confirm').insertAdjacentElement('afterend', errEl);
          }
          errEl.textContent = '請輸入有效的 Bear 負擔金額';
          return;
        }
        overlay.remove();
        resolve({ bearShare: bear });
      });
    });
  }

  // ── 品項歸屬 Modal（是/否/- → 部分，有品項時）──────────────

  function _openItemAttrModal(invRow, monthlyRow, invItems, newCat, newNote, wrapEl, ccRow) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';

    const attrChipsHTML = (it) => ITEM_ATTR_OPTS.map(opt => {
      let isActive = false;
      if (opt === '部分') isActive = (it.attribution === '共用' && it.custom !== '');
      else               isActive = (it.attribution === opt);
      return `<button class="chip item-attr-chip${isActive ? ' active' : ''}" data-opt="${opt}" style="font-size:12px;padding:4px 10px;">${opt}</button>`;
    }).join('');

    overlay.innerHTML = `
      <div class="modal-sheet">
        <div class="modal-header">
          <span class="modal-title">設定品項歸屬</span>
          <button class="modal-close" id="iattr-close">✕</button>
        </div>
        <div class="modal-body">
          <p style="font-size:13px;color:var(--text-sub);margin-bottom:12px;">請為每個品項設定歸屬後再儲存。</p>
          ${invItems.map((it, idx) => `
            <div class="item-attr-block" data-idx="${idx}" style="margin-bottom:12px;padding-bottom:10px;border-bottom:1px solid var(--divider);">
              <div style="font-size:14px;margin-bottom:6px;">${it.itemName || '（未命名）'} <span style="color:var(--text-sub);font-size:12px;">$${it.itemAmount.toLocaleString('zh-TW')}</span></div>
              <div class="chip-row" style="margin-bottom:4px;">${attrChipsHTML(it)}</div>
              <div class="bear-partial-wrap" style="display:${(it.attribution === '共用' && it.custom !== '') ? 'block' : 'none'};margin-top:4px;">
                <div class="amount-wrap">
                  <span class="amount-prefix">$</span>
                  <input type="number" class="field-input amount-input bear-amt-input" style="font-size:13px;padding:6px 6px 6px 24px;" min="0" step="1" inputmode="decimal" placeholder="Bear 負擔金額" value="${it.custom || ''}">
                </div>
              </div>
            </div>`).join('')}
          <p class="iattr-error hidden" style="font-size:12px;color:var(--salmon);"></p>
        </div>
        <div class="modal-footer">
          <button class="btn-secondary" id="iattr-cancel">取消</button>
          <button class="btn-primary" id="iattr-confirm">確認並儲存</button>
        </div>
      </div>`;

    document.body.appendChild(overlay);

    // chip 互動
    overlay.querySelectorAll('.item-attr-block').forEach(block => {
      block.querySelectorAll('.item-attr-chip').forEach(chip => {
        chip.addEventListener('click', () => {
          block.querySelectorAll('.item-attr-chip').forEach(c => c.classList.remove('active'));
          chip.classList.add('active');
          const partialWrap = block.querySelector('.bear-partial-wrap');
          partialWrap.style.display = chip.dataset.opt === '部分' ? 'block' : 'none';
        });
      });
    });

    overlay.querySelector('#iattr-close').addEventListener('click', () => overlay.remove());
    overlay.querySelector('#iattr-cancel').addEventListener('click', () => overlay.remove());

    overlay.querySelector('#iattr-confirm').addEventListener('click', async () => {
      const errEl = overlay.querySelector('.iattr-error');
      errEl.classList.add('hidden');
      const btn = overlay.querySelector('#iattr-confirm');
      btn.disabled = true;
      btn.textContent = '儲存中…';

      try {
        const blocks = overlay.querySelectorAll('.item-attr-block');
        for (let i = 0; i < blocks.length; i++) {
          const block = blocks[i];
          const it    = invItems[i];
          const activeChip = block.querySelector('.item-attr-chip.active');
          if (!activeChip) {
            errEl.textContent = `請為「${it.itemName || '品項' + (i+1)}」設定歸屬`;
            errEl.classList.remove('hidden');
            btn.disabled = false;
            btn.textContent = '確認並儲存';
            return;
          }
          const opt = activeChip.dataset.opt;
          let attribution = opt;
          let customAmount = '';
          if (opt === '部分') {
            attribution = '共用';
            customAmount = block.querySelector('.bear-amt-input').value;
          }
          await Sheets.updateItemFields(it.rowIndex, { attribution, customAmount });
        }
        // 更新發票 H
        await Sheets.updateInvoiceFields(invRow.rowIndex, { category: newCat, shared: '部分', note: newNote });
        _clearInvoiceCache();
        const ym = monthlyRow.date.slice(0, 7);
        await Sheets.updateMonthlyFields(monthlyRow.rowIndex, { shared: '部分', category: newCat }, ym);
        // CC 連結：靜態 G/H 需手動重算（從 modal DOM 讀取剛設定的歸屬）
        if (ccRow) {
          const modalItems = Array.from(overlay.querySelectorAll('.item-attr-block')).map((block, i) => {
            const it = invItems[i];
            const activeChip = block.querySelector('.item-attr-chip.active');
            const opt = activeChip ? activeChip.dataset.opt : (it.attribution || '');
            let attribution = opt === '部分' ? '共用' : opt;
            let custom = opt === '部分' ? (block.querySelector('.bear-amt-input')?.value || '') : '';
            return { itemAmount: it.itemAmount, attribution, custom };
          });
          const { sinShare, bearShare } = _calcPlatformSplit(modalItems, '部分', ccRow.amount);
          await Sheets.updateMonthlyGH(monthlyRow.rowIndex, sinShare, bearShare, ym);
        }
        _itemsCache = null;
        overlay.remove();
        await _load();
        window.Home?.reload();
      } catch (e) {
        errEl.textContent = '儲存失敗：' + e.message;
        errEl.classList.remove('hidden');
        btn.disabled = false;
        btn.textContent = '確認並儲存';
      }
    });
  }

  // ── 品項列（可編輯，Sin only）────────────────────────────────

  function _buildItemEditRow(it, isSin, ccRow) {
    const wrap = document.createElement('div');
    wrap.className = 'item-detail-row item-edit-row';

    if (!isSin) {
      wrap.innerHTML = `
        <span class="item-detail-name">${it.itemName || '（未命名）'}</span>
        <span class="item-detail-attr">${it.attribution || '—'}</span>
        <span class="item-detail-amt">$${it.itemAmount.toLocaleString('zh-TW')}</span>`;
      return wrap;
    }

    // 判斷目前歸屬
    let currentAttr   = it.attribution || '';
    let isPartial     = (currentAttr === '共用' && it.custom !== '');
    let displayAttr   = isPartial ? '部分' : currentAttr;
    let currentCustom = it.custom  || '';
    let currentNote   = it.note    || '';

    const attrChips = ITEM_ATTR_OPTS.map(opt =>
      `<button class="chip item-attr-chip${displayAttr === opt ? ' active' : ''}" data-opt="${opt}" style="font-size:11px;padding:3px 8px;">${opt}</button>`
    ).join('');

    wrap.innerHTML = `
      <div class="item-edit-name">${it.itemName || '（未命名）'} <span style="color:var(--text-sub);font-size:11px;">$${it.itemAmount.toLocaleString('zh-TW')}</span></div>
      <div class="chip-row item-attr-chips" style="margin-bottom:4px;gap:5px;">${attrChips}</div>
      <div class="bear-partial-wrap" style="display:${isPartial ? 'block' : 'none'};margin-bottom:4px;">
        <div class="amount-wrap">
          <span class="amount-prefix">$</span>
          <input type="number" class="field-input amount-input bear-amt-input" style="font-size:12px;padding:5px 5px 5px 22px;" min="0" step="1" inputmode="decimal" placeholder="Bear 負擔金額" value="${currentCustom}">
        </div>
      </div>
      <div>
        <input type="text" id="item-note-${it.rowIndex}" class="field-input item-note-input" data-notechips="true" style="font-size:12px;padding:5px 8px;" placeholder="備註（J欄）" value="${currentNote}">
      </div>
      <div style="margin-top:6px;display:flex;align-items:center;gap:8px;">
        <button class="btn-item-save btn-primary" style="padding:5px 12px;font-size:12px;">儲存</button>
        <span class="item-save-msg" style="font-size:11px;color:var(--teal);display:none;">✓ 已儲存</span>
      </div>
      <p class="item-edit-error hidden" style="font-size:11px;color:var(--salmon);margin-top:4px;"></p>`;

    // chip 互動
    let selectedOpt = displayAttr;
    wrap.querySelectorAll('.item-attr-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        wrap.querySelectorAll('.item-attr-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        selectedOpt = chip.dataset.opt;
        wrap.querySelector('.bear-partial-wrap').style.display = selectedOpt === '部分' ? 'block' : 'none';
      });
    });

    wrap.querySelector('.btn-item-save').addEventListener('click', async () => {
      const btn   = wrap.querySelector('.btn-item-save');
      const errEl = wrap.querySelector('.item-edit-error');
      const msgEl = wrap.querySelector('.item-save-msg');
      errEl.classList.add('hidden');
      btn.disabled = true;
      btn.textContent = '儲存中…';

      try {
        let attribution  = selectedOpt;
        let customAmount = '';
        if (selectedOpt === '部分') {
          attribution  = '共用';
          customAmount = wrap.querySelector('.bear-amt-input').value;
        }
        const note = wrap.querySelector('.item-note-input').value.trim();
        await Sheets.updateItemFields(it.rowIndex, { attribution, customAmount, note });
        it.attribution = attribution;
        it.custom      = customAmount;
        it.note        = note;
        msgEl.style.display = 'inline';
        setTimeout(() => { msgEl.style.display = 'none'; }, 2000);
        const ym = (it.date || '').slice(0, 7);
        // CC 連結：月度 G/H 為靜態值，需手動重算
        if (ccRow) {
          const allItems = (_itemsCache || []).filter(ii => ii.invNum === it.invNum);
          const monthlyRow = _allRows.find(r => r.sourceLink === it.invNum);
          if (monthlyRow) {
            const { sinShare, bearShare } = _calcPlatformSplit(allItems, monthlyRow.shared, ccRow.amount);
            await Sheets.updateMonthlyGH(monthlyRow.rowIndex, sinShare, bearShare, ym);
          }
        } else if (ym) {
          Sheets.invalidateMonth(ym);
        }
        window.Home?.reload();
      } catch (e) {
        errEl.textContent = '儲存失敗：' + e.message;
        errEl.classList.remove('hidden');
      } finally {
        btn.disabled = false;
        btn.textContent = '儲存';
      }
    });

    return wrap;
  }

  // ── 刪除 Modal ────────────────────────────────────────────────

  let _deleteModalRow = null;

  function _buildDeleteModal() {
    if (document.getElementById('delete-inv-modal')) return;
    const el = document.createElement('div');
    el.id = 'delete-inv-modal';
    el.className = 'modal-overlay hidden';
    el.innerHTML = `
      <div class="modal-sheet">
        <div class="modal-header">
          <span class="modal-title" id="del-modal-title">刪除發票</span>
          <button class="modal-close" id="del-close">✕</button>
        </div>
        <div class="modal-body">
          <p style="font-size:13px;color:var(--text-sub);margin-bottom:12px;">以下關聯資料將一起處理，請確認後再刪除。</p>
          <div id="del-items-section" class="del-section">
            <div class="del-section-header">
              <input type="checkbox" id="del-chk-items" checked disabled>
              <label for="del-chk-items" class="del-section-label">品項明細</label>
              <span id="del-items-count" class="del-section-count"></span>
            </div>
          </div>
          <div id="del-monthly-section" class="del-section hidden">
            <div class="del-section-header">
              <input type="checkbox" id="del-chk-monthly" checked>
              <label for="del-chk-monthly" class="del-section-label">月度帳本</label>
              <span id="del-monthly-count" class="del-section-count"></span>
            </div>
          </div>
          <div id="del-cc-section" class="del-section hidden">
            <div class="del-section-header">
              <input type="checkbox" id="del-chk-cc" checked>
              <label for="del-chk-cc" class="del-section-label">解除信用卡配對</label>
              <span id="del-cc-info" class="del-section-count"></span>
            </div>
          </div>
          <p id="del-error" class="add-error hidden" style="margin-top:12px;"></p>
        </div>
        <div class="modal-footer">
          <button class="btn-secondary" id="del-cancel">取消</button>
          <button class="btn-primary del-confirm-btn" id="del-confirm">確認刪除</button>
        </div>
      </div>`;
    document.body.appendChild(el);

    document.getElementById('del-close').addEventListener('click',  _closeDeleteModal);
    document.getElementById('del-cancel').addEventListener('click', _closeDeleteModal);
    el.addEventListener('click', e => { if (e.target === el) _closeDeleteModal(); });
    document.getElementById('del-confirm').addEventListener('click', _confirmDelete);
  }

  async function _openDeleteModal(row) {
    _buildDeleteModal();
    _deleteModalRow = row;
    const invNum = row.sourceLink;

    document.getElementById('del-modal-title').textContent = `刪除發票 ${invNum}`;
    document.getElementById('del-error').classList.add('hidden');
    document.getElementById('del-confirm').disabled   = false;
    document.getElementById('del-confirm').textContent = '確認刪除';

    // spinner 等待中
    document.getElementById('del-items-count').textContent  = '載入中…';
    document.getElementById('del-monthly-count').textContent = '';
    document.getElementById('del-cc-info').textContent       = '';
    document.getElementById('del-monthly-section').classList.add('hidden');
    document.getElementById('del-cc-section').classList.add('hidden');
    document.getElementById('delete-inv-modal').classList.remove('hidden');

    try {
      // 品項明細
      if (!_itemsCache || Date.now() - _itemsCacheTs >= ITEMS_CACHE_TTL) {
        _itemsCache   = await Sheets.getItemData();
        _itemsCacheTs = Date.now();
      }
      const invItems = _itemsCache.filter(it => it.invNum === invNum);
      document.getElementById('del-items-count').textContent = `${invItems.length} 筆`;

      // 月度帳本（當前月份有這列）
      const monthlyRows = _allRows.filter(r => r.sourceLink === invNum);
      if (monthlyRows.length) {
        const ym = monthlyRows[0].date.slice(0, 7);
        document.getElementById('del-monthly-count').textContent = `${ym}，${monthlyRows.length} 筆`;
        document.getElementById('del-monthly-section').classList.remove('hidden');
      }

      // CC 配對
      const ccRows = await Sheets.getCCForInvoice(invNum);
      if (ccRows.length) {
        const cc = ccRows[0];
        document.getElementById('del-cc-info').textContent = `${cc.bank} $${cc.amount.toLocaleString('zh-TW')}`;
        document.getElementById('del-cc-section').classList.remove('hidden');
      }
    } catch (e) {
      document.getElementById('del-items-count').textContent = '載入失敗';
      document.getElementById('del-error').textContent = e.message;
      document.getElementById('del-error').classList.remove('hidden');
    }
  }

  function _closeDeleteModal() {
    const el = document.getElementById('delete-inv-modal');
    if (el) el.classList.add('hidden');
    _deleteModalRow = null;
  }

  async function _confirmDelete() {
    const row    = _deleteModalRow;
    if (!row) return;
    const invNum = row.sourceLink;
    const errEl  = document.getElementById('del-error');
    const btn    = document.getElementById('del-confirm');
    errEl.classList.add('hidden');
    btn.disabled    = true;
    btn.textContent = '刪除中…';

    const doMonthly = document.getElementById('del-chk-monthly').checked
      && !document.getElementById('del-monthly-section').classList.contains('hidden');
    const doCC = document.getElementById('del-chk-cc').checked
      && !document.getElementById('del-cc-section').classList.contains('hidden');

    try {
      // 1. 取得發票 rowIndex（在 発票明細 tab）
      const allInvoices = await Sheets.getInvoiceData();
      const invRow = allInvoices.find(inv => inv.invNum === invNum);

      // 2. 取得品項 rowIndices
      if (!_itemsCache || Date.now() - _itemsCacheTs >= ITEMS_CACHE_TTL) {
        _itemsCache   = await Sheets.getItemData();
        _itemsCacheTs = Date.now();
      }
      const invItems = _itemsCache.filter(it => it.invNum === invNum);

      // 3. 解除 CC 配對（先做，避免月度刪了但 CC 殘留）
      if (doCC) {
        const ccRows = await Sheets.getCCForInvoice(invNum);
        for (const cc of ccRows) {
          await Sheets.unlinkCC(cc.rowIndex);  // 清 H/I/K
        }
      }

      // 4. 刪除月度帳本列（降序）
      if (doMonthly) {
        const monthlyRows = _allRows.filter(r => r.sourceLink === invNum);
        const sortedMonthly = [...monthlyRows].sort((a, b) => b.rowIndex - a.rowIndex);
        for (const mr of sortedMonthly) {
          await Sheets.deleteMonthlyRow(mr.rowIndex, mr.date.slice(0, 7));
        }
      }

      // 5. 刪除品項明細（批次降序）
      await Sheets.deleteItemRows(invItems.map(it => it.rowIndex));

      // 6. 刪除發票明細
      if (invRow) await Sheets.deleteInvoiceRow(invRow.rowIndex);
      _clearInvoiceCache();

      // 7. 清快取並重整
      _itemsCache = null;
      _closeDeleteModal();
      await _load();
      window.Home?.reload();
    } catch (e) {
      errEl.textContent = '刪除失敗：' + e.message;
      errEl.classList.remove('hidden');
      btn.disabled    = false;
      btn.textContent = '確認刪除';
    }
  }

  // ── Edit Modal（非發票列用）──────────────────────────────────

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

    _editPayer  = row.payer  || _defaultPayer();
    _editShared = row.shared || '是';

    document.querySelectorAll('#edit-payer-chips .chip')
      .forEach(b => b.classList.toggle('active', b.dataset.payer === _editPayer));
    document.querySelectorAll('#edit-shared-chips .chip')
      .forEach(b => b.classList.toggle('active', b.dataset.shared === _editShared));

    document.getElementById('edit-modal').classList.remove('hidden');
    NoteChips.render('edit-note');
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

  // ── 發票明細 Sub-tab Edit Modal ──────────────────────────────

  function _buildInvSubEditModal() {
    if (document.getElementById('inv-sub-edit-modal')) return;
    const el = document.createElement('div');
    el.id = 'inv-sub-edit-modal';
    el.className = 'modal-overlay hidden';
    el.innerHTML = `
      <div class="modal-sheet">
        <div class="modal-header">
          <span class="modal-title">編輯發票明細</span>
          <button class="modal-close" id="inv-sub-close">✕</button>
        </div>
        <div class="modal-body">
          <div id="inv-sub-info" style="font-size:13px;color:var(--text-sub);margin-bottom:12px;line-height:1.6;"></div>
          <label class="field-label">類別</label>
          <select id="inv-sub-cat" class="field-input cat-select">
            <option value="">（未分類）</option>
            ${CATEGORIES.map(c => `<option value="${c}">${c}</option>`).join('')}
          </select>
          <label class="field-label">是否共用</label>
          <div class="chip-row" id="inv-sub-shared-chips">
            ${SHARED_OPTS.map(v => `<button class="chip" data-val="${v}">${v}</button>`).join('')}
          </div>
          <label class="field-label">備註</label>
          <input type="text" id="inv-sub-note" class="field-input">
          <p id="inv-sub-error" class="add-error hidden"></p>
        </div>
        <div class="modal-footer">
          <button class="btn-secondary" id="inv-sub-cancel">取消</button>
          <button class="btn-primary" id="inv-sub-save">儲存</button>
        </div>
      </div>`;
    document.body.appendChild(el);
    document.getElementById('inv-sub-close').addEventListener('click', _closeInvSubModal);
    document.getElementById('inv-sub-cancel').addEventListener('click', _closeInvSubModal);
    el.addEventListener('click', e => { if (e.target === el) _closeInvSubModal(); });
    el.querySelectorAll('#inv-sub-shared-chips .chip').forEach(btn => {
      btn.addEventListener('click', () => {
        el.querySelectorAll('#inv-sub-shared-chips .chip').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        _invSubEditShared = btn.dataset.val;
      });
    });
    document.getElementById('inv-sub-save').addEventListener('click', async () => {
      const row = _invSubEditRow;
      if (!row) return;
      const btn   = document.getElementById('inv-sub-save');
      const errEl = document.getElementById('inv-sub-error');
      const cat   = document.getElementById('inv-sub-cat').value;
      const note  = document.getElementById('inv-sub-note').value.trim();
      errEl.classList.add('hidden');
      btn.disabled = true; btn.textContent = '儲存中…';
      try {
        await Sheets.updateInvoiceFields(row.rowIndex, { category: cat, shared: _invSubEditShared, note });
        _clearInvoiceCache();
        _closeInvSubModal();
        _invRows = [];
        await _loadInvoiceTab();
      } catch (e) {
        errEl.textContent = '儲存失敗：' + e.message;
        errEl.classList.remove('hidden');
      } finally {
        btn.disabled = false; btn.textContent = '儲存';
      }
    });
  }

  function _openInvSubModal(row) {
    _buildInvSubEditModal();
    _invSubEditRow   = row;
    _invSubEditShared = row.shared || '';
    document.getElementById('inv-sub-info').innerHTML =
      `${row.shop || '（未知）'}　${row.date}　${row.invNum}<br>金額 $${row.amount.toLocaleString('zh-TW')}`;
    document.getElementById('inv-sub-cat').value  = row.category || '';
    document.getElementById('inv-sub-note').value = row.note     || '';
    document.getElementById('inv-sub-error').classList.add('hidden');
    document.querySelectorAll('#inv-sub-shared-chips .chip')
      .forEach(b => b.classList.toggle('active', b.dataset.val === _invSubEditShared));
    document.getElementById('inv-sub-edit-modal').classList.remove('hidden');
  }

  function _closeInvSubModal() {
    document.getElementById('inv-sub-edit-modal')?.classList.add('hidden');
    _invSubEditRow = null;
  }

  // ── CC明細 Sub-tab Edit Modal ────────────────────────────────

  function _buildCCSubEditModal() {
    if (document.getElementById('cc-sub-edit-modal')) return;
    const CC_SHARED = ['是', '否', '部分', '-', 'x'];
    const el = document.createElement('div');
    el.id = 'cc-sub-edit-modal';
    el.className = 'modal-overlay hidden';
    el.innerHTML = `
      <div class="modal-sheet">
        <div class="modal-header">
          <span class="modal-title">編輯CC明細</span>
          <button class="modal-close" id="cc-sub-close">✕</button>
        </div>
        <div class="modal-body">
          <div id="cc-sub-info" style="font-size:13px;color:var(--text-sub);margin-bottom:12px;line-height:1.6;"></div>
          <label class="field-label">類別</label>
          <select id="cc-sub-cat" class="field-input cat-select">
            <option value="">（未分類）</option>
            ${CATEGORIES.map(c => `<option value="${c}">${c}</option>`).join('')}
          </select>
          <label class="field-label">是否共用</label>
          <div class="chip-row" id="cc-sub-shared-chips">
            ${CC_SHARED.map(v => `<button class="chip" data-val="${v}">${v}</button>`).join('')}
          </div>
          <label class="field-label">備註</label>
          <input type="text" id="cc-sub-note" class="field-input">
          <p id="cc-sub-error" class="add-error hidden"></p>
        </div>
        <div class="modal-footer">
          <button class="btn-secondary" id="cc-sub-cancel">取消</button>
          <button class="btn-primary" id="cc-sub-save">儲存</button>
        </div>
      </div>`;
    document.body.appendChild(el);
    document.getElementById('cc-sub-close').addEventListener('click', _closeCCSubModal);
    document.getElementById('cc-sub-cancel').addEventListener('click', _closeCCSubModal);
    el.addEventListener('click', e => { if (e.target === el) _closeCCSubModal(); });
    el.querySelectorAll('#cc-sub-shared-chips .chip').forEach(btn => {
      btn.addEventListener('click', () => {
        el.querySelectorAll('#cc-sub-shared-chips .chip').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        _ccSubEditShared = btn.dataset.val;
      });
    });
    document.getElementById('cc-sub-save').addEventListener('click', async () => {
      const row = _ccSubEditRow;
      if (!row) return;
      const btn   = document.getElementById('cc-sub-save');
      const errEl = document.getElementById('cc-sub-error');
      const cat   = document.getElementById('cc-sub-cat').value;
      const note  = document.getElementById('cc-sub-note').value.trim();
      errEl.classList.add('hidden');
      btn.disabled = true; btn.textContent = '儲存中…';
      try {
        await Sheets.updateCCFields(row.rowIndex, { category: cat, shared: _ccSubEditShared, note });
        _closeCCSubModal();
        _ccRows = [];
        await _loadCCTab();
      } catch (e) {
        errEl.textContent = '儲存失敗：' + e.message;
        errEl.classList.remove('hidden');
      } finally {
        btn.disabled = false; btn.textContent = '儲存';
      }
    });
  }

  function _openCCSubModal(row) {
    _buildCCSubEditModal();
    _ccSubEditRow    = row;
    _ccSubEditShared = row.shared || '';
    document.getElementById('cc-sub-info').innerHTML =
      `${row.bank}　${row.shop || '（未知）'}　${row.txDate}<br>金額 $${row.amount.toLocaleString('zh-TW')}`;
    document.getElementById('cc-sub-cat').value  = row.category || '';
    document.getElementById('cc-sub-note').value = row.note     || '';
    document.getElementById('cc-sub-error').classList.add('hidden');
    document.querySelectorAll('#cc-sub-shared-chips .chip')
      .forEach(b => b.classList.toggle('active', b.dataset.val === _ccSubEditShared));
    document.getElementById('cc-sub-edit-modal').classList.remove('hidden');
  }

  function _closeCCSubModal() {
    document.getElementById('cc-sub-edit-modal')?.classList.add('hidden');
    _ccSubEditRow = null;
  }

  async function _toggleCCLinkCard(row, triggerEl) {
    const existing = document.getElementById(`cc-link-card-${row.rowIndex}`);
    if (existing) {
      existing.remove();
      return;
    }

    document.querySelectorAll('.cc-link-card').forEach(el => el.remove());
    const host = triggerEl.closest('.swipe-container') || triggerEl.closest('.list-item');
    if (!host) return;
    const card = document.createElement('div');
    card.id = `cc-link-card-${row.rowIndex}`;
    card.className = 'cc-link-card';
    card.innerHTML = '<div class="spinner"></div>';
    host.insertAdjacentElement('afterend', card);

    try {
      const ctx = await _getCCLinkContext(row);
      const inv = ctx.invoice;
      const monthly = ctx.monthlyRows[0] || null;
      const modeLabel = ctx.mode === 'platform' ? '平台配對' : '重複防護';
      const modeText = ctx.mode === 'platform'
        ? '解除後會刪除配對產生的月度帳本，並讓發票回待處理。'
        : '解除後只恢復 CC，不刪除月度帳本。';
      card.innerHTML = `
        <div class="cc-link-card-head">
          <span class="badge-linked">${modeLabel}</span>
          <span class="cc-link-card-sub">${modeText}</span>
        </div>
        <div class="cc-link-grid">
          <span>發票</span>
          <strong>${inv ? `${inv.invNum} · ${inv.shop || '（未知）'} · $${inv.amount.toLocaleString('zh-TW')}` : '找不到發票'}</strong>
          ${inv ? '<button class="cc-link-jump" data-jump="invoice" title="看發票">🧾</button>' : '<span></span>'}
          <span>月度</span>
          <strong>${monthly ? `${monthly.date} · ${monthly.item || monthly.source} · $${monthly.amount.toLocaleString('zh-TW')}` : '找不到月度帳本'}</strong>
          ${monthly ? '<button class="cc-link-jump" data-jump="monthly" title="看月度帳本">📒</button>' : '<span></span>'}
        </div>
      `;
      card.querySelector('[data-jump="invoice"]')?.addEventListener('click', e => {
        e.stopPropagation();
        _jumpToInvoice(inv.rowIndex);
      });
      card.querySelector('[data-jump="monthly"]')?.addEventListener('click', e => {
        e.stopPropagation();
        _jumpToMonthly(monthly.rowIndex);
      });
    } catch (e) {
      card.innerHTML = `<p class="add-error">連結資料讀取失敗：${e.message}</p>`;
    }
  }

  function _buildCCUnlinkModal() {
    if (document.getElementById('cc-unlink-modal')) return;
    const el = document.createElement('div');
    el.id = 'cc-unlink-modal';
    el.className = 'modal-overlay hidden';
    el.innerHTML = `
      <div class="modal-sheet">
        <div class="modal-header">
          <span class="modal-title" id="cc-unlink-title">解除 CC 配對</span>
          <button class="modal-close" id="cc-unlink-close">✕</button>
        </div>
        <div class="modal-body">
          <div id="cc-unlink-info" class="cc-unlink-info"></div>
          <p id="cc-unlink-error" class="add-error hidden" style="margin-top:12px;"></p>
        </div>
        <div class="modal-footer">
          <button class="btn-secondary" id="cc-unlink-cancel">取消</button>
          <button class="btn-primary cc-unlink-confirm" id="cc-unlink-confirm">確認解除</button>
        </div>
      </div>`;
    document.body.appendChild(el);
    document.getElementById('cc-unlink-close').addEventListener('click', _closeCCUnlinkModal);
    document.getElementById('cc-unlink-cancel').addEventListener('click', _closeCCUnlinkModal);
    el.addEventListener('click', e => { if (e.target === el) _closeCCUnlinkModal(); });
    document.getElementById('cc-unlink-confirm').addEventListener('click', _confirmCCUnlink);
  }

  async function _openCCUnlinkModal(row) {
    _buildCCUnlinkModal();
    _ccUnlinkRow = row;
    _ccUnlinkContext = null;
    const info = document.getElementById('cc-unlink-info');
    const errEl = document.getElementById('cc-unlink-error');
    const btn = document.getElementById('cc-unlink-confirm');
    errEl.classList.add('hidden');
    btn.disabled = true;
    btn.textContent = '載入中...';
    info.innerHTML = '<div class="spinner"></div>';
    document.getElementById('cc-unlink-modal').classList.remove('hidden');
    try {
      const ctx = await _getCCLinkContext(row);
      _ccUnlinkContext = ctx;
      const inv = ctx.invoice;
      const modeLabel = ctx.mode === 'platform' ? '平台配對' : '重複防護';
      const impact = ctx.mode === 'platform'
        ? `將清除 CC 連結、刪除 ${ctx.platformRows.length} 筆配對產生的月度帳本，並把發票改回未匯入。`
        : '將清除 CC 連結，不刪除月度帳本，發票已匯入狀態維持不變。';
      info.innerHTML = `
        <div class="cc-unlink-summary">
          <div><span class="badge-linked">${modeLabel}</span></div>
          <div>${row.bank}　${row.txDate}　$${row.amount.toLocaleString('zh-TW')}</div>
          <div>${inv ? `${inv.invNum}　${inv.shop || '（未知）'}` : row.matched}</div>
          <p>${impact}</p>
        </div>
      `;
      btn.disabled = false;
      btn.textContent = '確認解除';
    } catch (e) {
      info.innerHTML = '';
      errEl.textContent = '載入失敗：' + e.message;
      errEl.classList.remove('hidden');
      btn.textContent = '確認解除';
    }
  }

  function _closeCCUnlinkModal() {
    document.getElementById('cc-unlink-modal')?.classList.add('hidden');
    _ccUnlinkRow = null;
    _ccUnlinkContext = null;
  }

  async function _confirmCCUnlink() {
    const row = _ccUnlinkRow;
    const ctx = _ccUnlinkContext;
    if (!row || !ctx) return;
    const errEl = document.getElementById('cc-unlink-error');
    const btn = document.getElementById('cc-unlink-confirm');
    errEl.classList.add('hidden');
    btn.disabled = true;
    btn.textContent = '解除中...';
    try {
      await Sheets.unlinkCC(row.rowIndex);
      if (ctx.mode === 'platform') {
        const rows = [...ctx.platformRows].sort((a, b) => b.rowIndex - a.rowIndex);
        for (const mr of rows) {
          await Sheets.deleteMonthlyRow(mr.rowIndex, mr.date.slice(0, 7));
        }
        if (ctx.invoice) {
          await Sheets.setInvoiceImported(ctx.invoice.rowIndex, false);
          _clearInvoiceCache();
        }
      }
      _closeCCUnlinkModal();
      _allRows = await Sheets.getMonthlyData(_year, _month);
      _ccRows = [];
      await _loadCCTab();
      window.Home?.reload();
      window.Pending?.reload?.();
      window.Stats?.reload?.();
    } catch (e) {
      errEl.textContent = '解除失敗：' + e.message;
      errEl.classList.remove('hidden');
      btn.disabled = false;
      btn.textContent = '確認解除';
    }
  }

  // ── Sub-tab 輔助 ──────────────────────────────────────────────

  function _reloadActiveTab() {
    if (_activeSubTab === 'invoice') { _invRows = []; _loadInvoiceTab(); }
    else if (_activeSubTab === 'cc') { _ccRows  = []; _loadCCTab(); }
    else _load();
  }

  async function _loadInvoiceTab() {
    const el = document.getElementById('inv-list');
    if (!el) return;
    el.innerHTML = '<div class="spinner"></div>';
    document.getElementById('inv-count').textContent = '';
    try {
      _invRows = await Sheets.getInvoiceSheetData(_year, _month);
      _renderInvoiceList();
    } catch (e) {
      el.innerHTML = `<div class="empty-state"><span>⚠️</span><p>${e.message}</p></div>`;
    }
  }

  function _renderInvoiceList() {
    const el = document.getElementById('inv-list');
    if (!el) return;
    const q = _invSearchQuery.toLowerCase();
    let rows = _invRows;
    if (_invSharedFilter.size > 0) rows = rows.filter(r => _invSharedFilter.has(r.shared));
    if (q) rows = rows.filter(r =>
      (r.shop || '').toLowerCase().includes(q) || (r.note || '').toLowerCase().includes(q)
    );
    document.getElementById('inv-count').textContent = `${rows.length} 筆`;
    if (!rows.length) {
      el.innerHTML = '<div class="empty-state"><span>📭</span><p>沒有符合條件的記錄</p></div>';
      return;
    }
    const isSin = _isSin();
    el.innerHTML = rows.map(r => {
      const mm = r.date.slice(5, 7), dd = r.date.slice(8, 10);
      const sharedLabel    = r.shared  ? `<span class="tag-shared">${r.shared}</span>` : '';
      const voidStyle      = r.status === '作廢' ? 'style="color:var(--salmon)"' : '';
      const voidBadge      = r.status === '作廢' ? '<span class="raw-badge">作廢</span>' : '';
      const importedBadge  = r.imported ? '<span class="badge-imported">已匯入</span>' : '';
      return `
        <div class="list-item${isSin ? ' list-item-editable' : ''}" data-row="${r.rowIndex}">
          <span class="list-item-icon">${r.category || '🧾'}</span>
          <div class="list-item-body">
            <div class="list-item-title" ${voidStyle}>${r.shop || '（未知）'} ${sharedLabel}</div>
            <div class="list-item-sub">${mm}/${dd}　${r.invNum}${r.note ? '　' + r.note : ''}</div>
          </div>
          <div class="list-item-right">
            <div class="amount-expense">$${r.amount.toLocaleString('zh-TW')}</div>
            ${importedBadge}${voidBadge}
          </div>
        </div>`;
    }).join('');
    if (isSin) {
      el.querySelectorAll('.list-item[data-row]').forEach(item => {
        item.addEventListener('click', () => {
          const row = _invRows.find(r => r.rowIndex === parseInt(item.dataset.row, 10));
          if (row) _openInvSubModal(row);
        });
      });
    }
    if (_invoiceScrollRow !== null) {
      const rowIndex = _invoiceScrollRow;
      _invoiceScrollRow = null;
      requestAnimationFrame(() => _highlightTarget(el.querySelector(`.list-item[data-row="${rowIndex}"]`)));
    }
  }

  async function _loadCCTab() {
    const el = document.getElementById('cc-list');
    if (!el) return;
    el.innerHTML = '<div class="spinner"></div>';
    document.getElementById('cc-count').textContent = '';
    try {
      _ccRows = await Sheets.getCCSheetData(_year, _month);
      _renderCCList();
    } catch (e) {
      el.innerHTML = `<div class="empty-state"><span>⚠️</span><p>${e.message}</p></div>`;
    }
  }

  function _renderCCList() {
    _swipeActiveWrap = null;
    _sharedDeleteBg  = null;
    const el = document.getElementById('cc-list');
    if (!el) return;
    const q = _ccSearchQuery.toLowerCase();
    let rows = _ccRows;
    if (_ccSharedFilter.size > 0) rows = rows.filter(r => _ccSharedFilter.has(r.shared));
    if (q) rows = rows.filter(r =>
      (r.shop || '').toLowerCase().includes(q) || (r.note || '').toLowerCase().includes(q)
    );
    document.getElementById('cc-count').textContent = `${rows.length} 筆`;
    if (!rows.length) {
      el.innerHTML = '<div class="empty-state"><span>📭</span><p>沒有符合條件的記錄</p></div>';
      return;
    }
    const isSin = _isSin();
    el.innerHTML = rows.map(r => {
      const mmdd = r.txDate.slice(5).replace('-', '/');
      const sharedLabel   = r.shared ? `<span class="tag-shared">${r.shared}</span>` : '';
      const importedBadge = r.posted ? '<span class="badge-imported">已匯入</span>' : '';
      const linkedBadge   = r.matched ? `<button type="button" class="badge-linked cc-link-toggle" data-row="${r.rowIndex}" title="顯示連結">已連結</button>` : '';
      const rowHtml = `
        <div class="list-item${isSin ? ' list-item-editable' : ''}" data-row="${r.rowIndex}">
          <span class="list-item-icon">${r.category || '💳'}</span>
          <div class="list-item-body">
            <div class="list-item-title">${r.shop || '（未知）'} ${sharedLabel}</div>
            <div class="list-item-sub">${mmdd}　${r.bank}${r.note ? '　' + r.note : ''}</div>
          </div>
          <div class="list-item-right">
            <div class="amount-expense">$${r.amount.toLocaleString('zh-TW')}</div>
            <div class="cc-badge-row">${linkedBadge}${importedBadge}</div>
          </div>
        </div>`;
      return r.matched ? `<div class="swipe-container cc-link-wrap" data-row="${r.rowIndex}">${rowHtml}</div>` : rowHtml;
    }).join('');
    if (isSin) {
      el.querySelectorAll('.list-item[data-row]').forEach(item => {
        item.addEventListener('click', () => {
          const row = _ccRows.find(r => r.rowIndex === parseInt(item.dataset.row, 10));
          if (row) _openCCSubModal(row);
        });
      });
      _setupCCUnlinkSwipe(el);
    }
    el.querySelectorAll('.cc-link-toggle').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const row = _ccRows.find(r => r.rowIndex === parseInt(btn.dataset.row, 10));
        if (row) _toggleCCLinkCard(row, btn);
      });
    });
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

      <div class="sub-tab-bar">
        <button class="sub-tab-btn active" data-subtab="monthly">月度帳本</button>
        <button class="sub-tab-btn" data-subtab="invoice">發票明細</button>
        <button class="sub-tab-btn" data-subtab="cc">CC明細</button>
      </div>

      <!-- 月度帳本 -->
      <div id="monthly-section">
        <div class="ledger-filters card">
          <div class="search-row">
            <div class="search-wrap">
              <input type="text" id="ledger-search" class="field-input" placeholder="搜尋項目或備註…">
              <button class="search-clear hidden" id="ledger-search-clear">✕</button>
            </div>
          </div>
          <div class="chip-row">
            <button class="chip active" data-member="all">全部</button>
            <button class="chip" data-member="sin">🌟 Sin</button>
            <button class="chip" data-member="bear">🐨 Bear</button>
          </div>
          <div class="chip-row" id="ledger-shared-chips">
            <button class="chip active" data-shared-filter="all">全部</button>
            <button class="chip" data-shared-filter="是">是</button>
            <button class="chip" data-shared-filter="部分">部分</button>
            <button class="chip" data-shared-filter="否">否</button>
            <button class="chip" data-shared-filter="-">-</button>
          </div>
          <div class="filter-row">
            <select id="ledger-source" class="cat-select">
              <option value="">全部來源</option>
              <option value="信用卡">💳 信用卡</option>
              <option value="發票">🧾 發票</option>
              <option value="掃描發票">📷 掃描</option>
              <option value="手查發票">📷 手查</option>
              <option value="手動記帳">✏️ 手動</option>
            </select>
            <select id="ledger-cat" class="cat-select">
              <option value="">全部類別</option>
            </select>
            <select id="ledger-sort" class="cat-select">
              <option value="date-desc">交易時間 ↓</option>
              <option value="date-asc">交易時間 ↑</option>
              <option value="import-desc">匯入時間 ↓</option>
              <option value="import-asc">匯入時間 ↑</option>
              <option value="amount-desc">金額高→低</option>
              <option value="amount-asc">金額低→高</option>
            </select>
            <span id="ledger-count" class="ledger-count"></span>
          </div>
          <div id="ledger-summary" class="ledger-summary hidden"></div>
        </div>
        <div class="card" id="ledger-list"></div>
      </div>

      <!-- 發票明細 -->
      <div id="inv-section" class="hidden">
        <div class="ledger-filters card">
          <div class="search-row">
            <div class="search-wrap">
              <input type="text" id="inv-search" class="field-input" placeholder="搜尋商店或備註…">
              <button class="search-clear hidden" id="inv-search-clear">✕</button>
            </div>
          </div>
          <div class="chip-row" id="inv-shared-chips">
            <button class="chip active" data-inv-shared="all">全部</button>
            <button class="chip" data-inv-shared="是">是</button>
            <button class="chip" data-inv-shared="部分">部分</button>
            <button class="chip" data-inv-shared="否">否</button>
            <button class="chip" data-inv-shared="-">-</button>
            <button class="chip" data-inv-shared="x">x</button>
          </div>
          <span id="inv-count" class="ledger-count"></span>
        </div>
        <div class="card" id="inv-list"></div>
      </div>

      <!-- CC明細 -->
      <div id="cc-section" class="hidden">
        <div class="ledger-filters card">
          <div class="search-row">
            <div class="search-wrap">
              <input type="text" id="cc-search" class="field-input" placeholder="搜尋商店或備註…">
              <button class="search-clear hidden" id="cc-search-clear">✕</button>
            </div>
          </div>
          <div class="chip-row" id="cc-shared-chips">
            <button class="chip active" data-cc-shared="all">全部</button>
            <button class="chip" data-cc-shared="是">是</button>
            <button class="chip" data-cc-shared="部分">部分</button>
            <button class="chip" data-cc-shared="否">否</button>
            <button class="chip" data-cc-shared="-">-</button>
            <button class="chip" data-cc-shared="x">x</button>
          </div>
          <span id="cc-count" class="ledger-count"></span>
        </div>
        <div class="card" id="cc-list"></div>
      </div>
    `;

    document.getElementById('ledger-prev').addEventListener('click', () => {
      _month--;
      if (_month < 1) { _month = 12; _year--; }
      window.AppMonth.set(_year, _month);
      _updateMonthLabel();
      _reloadActiveTab();
    });
    document.getElementById('ledger-next').addEventListener('click', () => {
      _month++;
      if (_month > 12) { _month = 1; _year++; }
      window.AppMonth.set(_year, _month);
      _updateMonthLabel();
      _reloadActiveTab();
    });
    document.getElementById('ledger-refresh').addEventListener('click', () => {
      if (_activeSubTab === 'invoice') { _invRows = []; _loadInvoiceTab(); return; }
      if (_activeSubTab === 'cc')      { _ccRows  = []; _loadCCTab();      return; }
      Object.keys(sessionStorage)
        .filter(k => k.startsWith('ba_monthly_'))
        .forEach(k => sessionStorage.removeItem(k));
      _load();
      window.Home?.reload();
      window.Stats?.reload?.();
      window.Pending?.reload?.();
    });

    // Sub-tab 切換
    document.querySelectorAll('.sub-tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        _setSubTab(btn.dataset.subtab);
        if (_activeSubTab === 'invoice') _loadInvoiceTab();
        else if (_activeSubTab === 'cc') _loadCCTab();
      });
    });

    // 發票明細篩選（複選）
    document.querySelectorAll('#inv-shared-chips .chip').forEach(btn => {
      btn.addEventListener('click', () => {
        const val = btn.dataset.invShared;
        if (val === 'all') {
          _invSharedFilter = new Set();
        } else {
          if (_invSharedFilter.has(val)) _invSharedFilter.delete(val);
          else _invSharedFilter.add(val);
        }
        const chips = document.querySelectorAll('#inv-shared-chips .chip');
        if (_invSharedFilter.size === 0) {
          chips.forEach(b => b.classList.toggle('active', b.dataset.invShared === 'all'));
        } else {
          chips.forEach(b => b.classList.toggle('active',
            b.dataset.invShared !== 'all' && _invSharedFilter.has(b.dataset.invShared)));
        }
        _renderInvoiceList();
      });
    });
    document.getElementById('inv-search').addEventListener('input', e => {
      _invSearchQuery = e.target.value.trim();
      document.getElementById('inv-search-clear').classList.toggle('hidden', !_invSearchQuery);
      _renderInvoiceList();
    });
    document.getElementById('inv-search-clear').addEventListener('click', () => {
      _invSearchQuery = '';
      document.getElementById('inv-search').value = '';
      document.getElementById('inv-search-clear').classList.add('hidden');
      _renderInvoiceList();
    });

    // CC明細篩選（複選）
    document.querySelectorAll('#cc-shared-chips .chip').forEach(btn => {
      btn.addEventListener('click', () => {
        const val = btn.dataset.ccShared;
        if (val === 'all') {
          _ccSharedFilter = new Set();
        } else {
          if (_ccSharedFilter.has(val)) _ccSharedFilter.delete(val);
          else _ccSharedFilter.add(val);
        }
        const chips = document.querySelectorAll('#cc-shared-chips .chip');
        if (_ccSharedFilter.size === 0) {
          chips.forEach(b => b.classList.toggle('active', b.dataset.ccShared === 'all'));
        } else {
          chips.forEach(b => b.classList.toggle('active',
            b.dataset.ccShared !== 'all' && _ccSharedFilter.has(b.dataset.ccShared)));
        }
        _renderCCList();
      });
    });
    document.getElementById('cc-search').addEventListener('input', e => {
      _ccSearchQuery = e.target.value.trim();
      document.getElementById('cc-search-clear').classList.toggle('hidden', !_ccSearchQuery);
      _renderCCList();
    });
    document.getElementById('cc-search-clear').addEventListener('click', () => {
      _ccSearchQuery = '';
      document.getElementById('cc-search').value = '';
      document.getElementById('cc-search-clear').classList.add('hidden');
      _renderCCList();
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
        const val   = btn.dataset.sharedFilter;
        const chips = document.querySelectorAll('#tab-ledger .chip[data-shared-filter]');
        if (val === 'all') {
          _sharedSelected.clear();
          chips.forEach(b => b.classList.toggle('active', b.dataset.sharedFilter === 'all'));
        } else {
          if (_sharedSelected.has(val)) {
            _sharedSelected.delete(val);
          } else {
            _sharedSelected.add(val);
          }
          if (_sharedSelected.size === 0) {
            chips.forEach(b => b.classList.toggle('active', b.dataset.sharedFilter === 'all'));
          } else {
            chips.forEach(b => b.classList.toggle('active', _sharedSelected.has(b.dataset.sharedFilter)));
          }
        }
        _renderList();
      });
    });

    document.getElementById('ledger-source').addEventListener('change', e => {
      _sourceFilter = e.target.value;
      _renderList();
    });

    document.getElementById('ledger-cat').addEventListener('change', e => {
      _catFilter = e.target.value;
      _renderList();
    });

    document.getElementById('ledger-sort').addEventListener('change', e => {
      _sortMode = e.target.value;
      _renderList();
    });

    document.getElementById('ledger-search').addEventListener('input', e => {
      _searchQuery = e.target.value.trim();
      document.getElementById('ledger-search-clear').classList.toggle('hidden', !_searchQuery);
      _renderList();
    });

    document.getElementById('ledger-search-clear').addEventListener('click', () => {
      _searchQuery = '';
      document.getElementById('ledger-search').value = '';
      document.getElementById('ledger-search-clear').classList.add('hidden');
      _renderList();
    });
  }

  function activate({ year, month }) {
    let searchCleared = false;
    if (_searchQuery) {
      _searchQuery = '';
      searchCleared = true;
      const searchEl = document.getElementById('ledger-search');
      const clearBtn = document.getElementById('ledger-search-clear');
      if (searchEl) searchEl.value = '';
      if (clearBtn) clearBtn.classList.add('hidden');
    }

    const pending = _pendingFilter;
    _pendingFilter = null;
    const ym = `${year}-${String(month).padStart(2, '0')}`;
    const cacheExists = !!sessionStorage.getItem(`ba_monthly_${ym}`);

    if (year !== _year || month !== _month) {
      _year = year; _month = month;
      if (pending) { _resetFilters(); _applyFilter(pending); }
      _updateMonthLabel();
      _load();
    } else if (!cacheExists) {
      // 其他 tab 操作（如 CC 配對）清除了快取，強制重新讀取
      if (pending) { _resetFilters(); _applyFilter(pending); }
      _load();
    } else if (pending) {
      _resetFilters();
      _applyFilter(pending);
      _renderList();
    } else if (_pendingScrollRow !== null) {
      _renderList();
    } else if (searchCleared) {
      _renderList();
    }
  }

  function jumpTo({ member, category, shared, rowIndex } = {}) {
    // 確保切回月度帳本 sub-tab
    _activeSubTab = 'monthly';
    document.querySelectorAll('.sub-tab-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.subtab === 'monthly'));
    document.getElementById('monthly-section')?.classList.remove('hidden');
    document.getElementById('inv-section')?.classList.add('hidden');
    document.getElementById('cc-section')?.classList.add('hidden');

    _pendingFilter = {};
    if (member   !== undefined) _pendingFilter.member   = member;
    if (shared   !== undefined) _pendingFilter.shared   = shared;
    if (category !== undefined) _pendingFilter.category = category;
    if (rowIndex !== undefined) _pendingScrollRow = rowIndex;
    Router.navigate('ledger');
  }

  function init() {
    _buildShell();
    _updateMonthLabel();
    _load();
  }

  return { init, reload: _load, activate, jumpTo };
})();

window.Ledger = Ledger;
