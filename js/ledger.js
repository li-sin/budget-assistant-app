const Ledger = (() => {
  const CATEGORIES = ['🍴', '🛒', '⛽', '📦', '🎬', '👗', '🏠', '💊'];
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

    const srcIcon = s => s === '發票' ? '🧾' : s === '信用卡' ? '💳' : s === '掃描發票' ? '📷' : '✏️';
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
      // 非發票列才加 list-item-editable（讓 click-to-edit 生效）
      const editableClass = isSin && !isInvoice ? ' list-item-editable' : '';
      return `
        <div class="list-item${editableClass}" data-row="${r.rowIndex}" data-is-invoice="${isInvoice ? '1' : ''}">
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
            ${isInvoice && isSin ? `<button class="delete-inv-btn" data-row="${r.rowIndex}" title="刪除此發票">🗑</button>` : ''}
          </div>
        </div>`;
    }).join('');

    // 非發票列：click-to-edit
    if (isSin) {
      el.querySelectorAll('.list-item:not([data-is-invoice="1"])').forEach(item => {
        item.addEventListener('click', () => {
          const rowIndex = parseInt(item.dataset.row, 10);
          const row = _allRows.find(r => r.rowIndex === rowIndex);
          if (row) _openEdit(row);
        });
      });
    }

    // expand 按鈕
    el.querySelectorAll('.expand-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const rowIndex = parseInt(btn.dataset.row, 10);
        const row = _allRows.find(r => r.rowIndex === rowIndex);
        if (row) _toggleItemDetail(row, btn);
      });
    });

    // 刪除按鈕
    el.querySelectorAll('.delete-inv-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const rowIndex = parseInt(btn.dataset.row, 10);
        const row = _allRows.find(r => r.rowIndex === rowIndex);
        if (row) _openDeleteModal(row);
      });
    });

    if (_pendingScrollRow !== null) {
      const rowIndex = _pendingScrollRow;
      _pendingScrollRow = null;
      requestAnimationFrame(() => {
        const target = el.querySelector(`[data-row="${rowIndex}"]`);
        if (target) {
          target.scrollIntoView({ behavior: 'smooth', block: 'center' });
          target.classList.add('list-item-highlight');
          setTimeout(() => target.classList.remove('list-item-highlight'), 1500);
        }
      });
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

  // ── 展開品項（可編輯，F20）────────────────────────────────────

  async function _toggleItemDetail(row, btnEl) {
    const detailId = `item-detail-${row.rowIndex}`;
    const listItem = btnEl.closest('.list-item');
    const existing = document.getElementById(detailId);
    if (existing) { existing.remove(); btnEl.textContent = '▼'; return; }

    btnEl.textContent = '…';
    try {
      // 載入品項快取
      if (!_itemsCache || Date.now() - _itemsCacheTs >= ITEMS_CACHE_TTL) {
        _itemsCache   = await Sheets.getItemData();
        _itemsCacheTs = Date.now();
      }
      // 載入發票資料（取得 invoice rowIndex 和原始欄位值）
      const allInvoices = await Sheets.getInvoiceData();
      const invNum  = row.sourceLink;
      const invRow  = allInvoices.find(inv => inv.invNum === invNum);
      const invItems = _itemsCache.filter(it => it.invNum === invNum);

      const detail = document.createElement('div');
      detail.id        = detailId;
      detail.className = 'item-detail-list';

      const isSin = _isSin();

      // ── 發票層欄位（可編輯，Sin only）────────────────────────
      const invSection = _buildInvoiceEditSection(row, invRow, isSin);
      detail.appendChild(invSection);

      // ── 品項層 ────────────────────────────────────────────────
      if (!invItems.length) {
        const empty = document.createElement('div');
        empty.className = 'item-detail-empty';
        empty.textContent = '無品項明細';
        detail.appendChild(empty);
      } else {
        invItems.forEach(it => {
          const itRow = _buildItemEditRow(it, isSin);
          detail.appendChild(itRow);
        });
      }

      listItem.insertAdjacentElement('afterend', detail);
      detail.querySelectorAll('input[data-notechips]').forEach(inp => {
        if (inp.id) NoteChips?.render(inp.id);
      });
      btnEl.textContent = '▲';
    } catch (e) {
      btnEl.textContent = '▼';
    }
  }

  // ── 發票層編輯區（G 類別 / H 是否共用 / I 備註）─────────────

  function _buildInvoiceEditSection(monthlyRow, invRow, isSin) {
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
      await _saveInvoiceFields(invRow, monthlyRow, newCat, newShared, newNote, wrap);
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

  async function _saveInvoiceFields(invRow, monthlyRow, newCat, newShared, newNote, wrapEl) {
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
          _openItemAttrModal(invRow, monthlyRow, invItems, newCat, newNote, wrapEl);
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
              attribution: '共用', customAmount: String(choice.bearShare) }
          );
          await Sheets.updateInvoiceFields(invRow.rowIndex, { category: newCat, shared: newShared, note: newNote });
          // 月度帳本 E/F 更新；G/H 由公式自動重算，不直接寫入
          await Sheets.updateMonthlyFields(monthlyRow.rowIndex, { shared: '部分', category: newCat }, ym);
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
        await Sheets.updateMonthlyFields(monthlyRow.rowIndex, { shared: newShared, category: newCat }, ym);
      } else {
        // 一般情況
        await Sheets.updateInvoiceFields(invRow.rowIndex, { category: newCat, shared: newShared, note: newNote });
        const monthlyShared = newShared; // mapping 1:1（是/否/部分/-/x 已在上方處理）
        await Sheets.updateMonthlyFields(monthlyRow.rowIndex, { shared: monthlyShared, category: newCat }, ym);
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

  function _openItemAttrModal(invRow, monthlyRow, invItems, newCat, newNote, wrapEl) {
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
        await Sheets.updateMonthlyFields(monthlyRow.rowIndex, { shared: '部分', category: newCat }, monthlyRow.date.slice(0, 7));
        _itemsCache = null;
        overlay.remove();

        const r = _allRows.find(r => r.rowIndex === monthlyRow.rowIndex);
        if (r) { r.category = newCat; r.shared = '部分'; r.note = newNote; }
        _renderList();
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

  function _buildItemEditRow(it, isSin) {
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
        // 月度帳本 G/H 是公式欄，自動重算，只需清快取
        const ym = (it.date || '').slice(0, 7);
        if (ym) Sheets.invalidateMonth(ym);
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

    _editPayer  = row.payer  || '🌟 Star';
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
      Object.keys(sessionStorage)
        .filter(k => k.startsWith('ba_monthly_'))
        .forEach(k => sessionStorage.removeItem(k));
      _load();
      window.Home?.reload();
      window.Stats?.reload?.();
      window.Pending?.reload?.();
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
    if (year !== _year || month !== _month) {
      _year = year; _month = month;
      if (pending) { _resetFilters(); _applyFilter(pending); }
      _updateMonthLabel();
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
