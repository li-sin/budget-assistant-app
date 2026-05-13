const Pending = (() => {
  let _items     = [];  // { type, label, color, row/invoice/... }
  let _bankFilter = '';  // '' = 全部；有值時只顯示 cc_pending 且 cc.bank === _bankFilter
  let _jumpBank   = null; // jumpTo 暫存，等 activate/init 時套用

  function _fmt(n) {
    return '$' + Math.abs(n).toLocaleString('zh-TW');
  }

  // ── 資料收集 ──────────────────────────────────────────────────

  async function _collect() {
    const [monthlyRaw, invoices, items, ccPendingRows] = await Promise.all([
      _getAllMonthly(),
      Sheets.getInvoiceData(),
      Sheets.getItemData(),
      Sheets.getCCPendingData(),
    ]);

    const result = [];

    // 🟡 未標記：發票明細 is_shared=部分共用，且品項明細有空白歸屬
    const partialInvNums = new Set(
      invoices
        .filter(inv => inv.shared === '部分共用' && inv.status !== '作廢')
        .map(inv => inv.invNum)
    );
    partialInvNums.forEach(invNum => {
      const invRow  = invoices.find(inv => inv.invNum === invNum);
      const invItems = items.filter(it => it.invNum === invNum);
      const hasBlank = invItems.some(it => !it.attribution);
      if (!hasBlank) return;
      result.push({
        type: 'untagged',
        label: '未標記',
        color: '#FFD166',
        invNum,
        shop: invRow?.shop || invNum,
        date: invRow?.date || '',
        amount: invRow?.amount || 0,
        invRowIndex: invRow?.rowIndex,
        invItems,
      });
    });

    // 🔴 負擔異常：月度帳本 is_shared 非空非 -/x 但 sinShare/bearShare 都空
    monthlyRaw.forEach(r => {
      if (!r.shared || r.shared === '-' || r.shared === 'x') return;
      if (r.sinShare !== null || r.bearShare !== null) return;
      // 判斷為空字串（parseFloat 回傳 0，但原始資料若為空才算異常）
      result.push({
        type: 'anomaly',
        label: '負擔異常',
        color: '#FF6B6B',
        row: r,
      });
    });

    // 🟠 疑似重複：來源=手動記帳 且 K 欄 sourceLink 含 →發票 或 →信用卡
    monthlyRaw.forEach(r => {
      if (r.source !== '手動記帳') return;
      if (!r.sourceLink || (!r.sourceLink.includes('→發票') && !r.sourceLink.includes('→信用卡'))) return;
      result.push({
        type: 'duplicate',
        label: '疑似重複',
        color: '#FF9F43',
        row: r,
      });
    });

    // 🔵 信用卡待填：H欄空 + K欄非✓
    ccPendingRows.forEach(cc => {
      result.push({
        type: 'cc_pending',
        label: '信用卡待填',
        color: '#4B9FE1',
        cc,
      });
    });

    // 🟣 發票待填：是否共用空 + status≠作廢 + 非空行
    invoices
      .filter(inv => inv.shared === '' && inv.status !== '作廢' && inv.invNum !== '')
      .forEach(inv => {
        result.push({
          type: 'inv_pending',
          label: '發票待填',
          color: '#9B59B6',
          inv,
          invItems: items.filter(it => it.invNum === inv.invNum),
        });
      });

    // 排序：🔴 > 🟠 > 🟡 > 🔵 > 🟣
    const order = { anomaly: 0, duplicate: 1, untagged: 2, cc_pending: 3, inv_pending: 4 };
    result.sort((a, b) => order[a.type] - order[b.type]);
    _items = result;
  }

  async function _getAllMonthly() {
    // 讀完整月度帳本（不限月份）
    const BASE = `https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.SHEET_ID}`;
    const url  = `${BASE}/values/${encodeURIComponent(CONFIG.TABS.MONTHLY + '!A:L')}`;
    const res  = await fetch(url, {
      headers: { Authorization: `Bearer ${Auth.getToken()}` },
    });
    if (res.status === 401) { Auth.logout(); throw new Error('auth_expired'); }
    if (!res.ok) throw new Error(`Sheets API ${res.status}`);
    const data = await res.json();
    return (data.values || []).slice(1).map((r, i) => ({
      rowIndex:   i + 2,
      date:       r[0]  || '',
      item:       r[1]  || '',
      amount:     parseFloat(r[2])  || 0,
      payer:      r[3]  || '',
      shared:     r[4]  || '',
      category:   r[5]  || '',
      sinShare:   r[6] !== undefined && r[6] !== '' ? parseFloat(r[6]) : null,
      bearShare:  r[7] !== undefined && r[7] !== '' ? parseFloat(r[7]) : null,
      note:       r[8]  || '',
      source:     r[9]  || '',
      sourceLink: r[10] || '',
      importedAt: r[11] || '',
    }));
  }

  // ── 渲染列表 ──────────────────────────────────────────────────

  function _renderList() {
    const el = document.getElementById('pending-list');
    const items = _bankFilter
      ? _items.filter(it => it.type === 'cc_pending' && it.cc.bank === _bankFilter)
      : _items;

    document.getElementById('pending-count').textContent = `${items.length} 項`;

    let html = '';
    if (_bankFilter) {
      html += `<div class="list-item" style="gap:8px;padding:8px 12px;align-items:center">
        <span class="pending-badge" style="background:#4B9FE122;color:#4B9FE1">🔵 ${_bankFilter}</span>
        <span class="list-item-sub" style="flex:1">信用卡待填</span>
        <button id="pending-clear-filter" class="month-btn" style="font-size:12px;padding:2px 8px">✕</button>
      </div>`;
    }

    if (!items.length) {
      html += '<div class="empty-state"><span>✅</span><p>沒有待處理項目</p></div>';
    } else {
      html += items.map((it, idx) => {
        let title, sub, amount;
        if (it.type === 'untagged') {
          title  = it.shop;
          sub    = it.date;
          amount = it.amount;
        } else if (it.type === 'cc_pending') {
          title  = it.cc.shop;
          sub    = `${it.cc.bank}　${it.cc.txDate}`;
          amount = it.cc.amount;
        } else if (it.type === 'inv_pending') {
          title  = it.inv.shop;
          sub    = it.inv.date;
          amount = it.inv.amount;
        } else {
          title  = it.row.item || '（未命名）';
          sub    = it.row.date;
          amount = it.row.amount;
        }
        return `
          <div class="list-item pending-item" data-idx="${idx}" style="cursor:pointer">
            <span class="pending-badge" style="background:${it.color}22;color:${it.color}">${it.label}</span>
            <div class="list-item-body">
              <div class="list-item-title">${title}</div>
              <div class="list-item-sub">${sub}</div>
            </div>
            <div class="list-item-right amount-expense">${_fmt(amount)}</div>
          </div>`;
      }).join('');
    }
    el.innerHTML = html;

    document.getElementById('pending-clear-filter')?.addEventListener('click', () => {
      _bankFilter = '';
      _renderList();
    });

    el.querySelectorAll('.pending-item').forEach(row => {
      row.addEventListener('click', () => {
        const idx = parseInt(row.dataset.idx, 10);
        _openDetail(items[idx]);
      });
    });
  }

  // ── 詳情 Modal ────────────────────────────────────────────────

  function _buildDetailModal() {
    if (document.getElementById('pending-modal')) return;
    const el = document.createElement('div');
    el.id = 'pending-modal';
    el.className = 'modal-overlay hidden';
    el.innerHTML = `
      <div class="modal-sheet">
        <div class="modal-header">
          <span class="modal-title" id="pending-modal-title"></span>
          <button class="modal-close" id="pending-modal-close">✕</button>
        </div>
        <div class="modal-body" id="pending-modal-body"></div>
        <div class="modal-footer" id="pending-modal-footer"></div>
      </div>
    `;
    document.body.appendChild(el);
    document.getElementById('pending-modal-close').addEventListener('click', _closeDetail);
    el.addEventListener('click', e => { if (e.target === el) _closeDetail(); });
  }

  function _closeDetail() {
    document.getElementById('pending-modal')?.classList.add('hidden');
  }

  function _openDetail(item) {
    _buildDetailModal();
    document.getElementById('pending-modal').classList.remove('hidden');

    if (item.type === 'untagged')       _renderUntagged(item);
    else if (item.type === 'anomaly')   _renderAnomaly(item);
    else if (item.type === 'duplicate') _renderDuplicate(item);
    else if (item.type === 'cc_pending')  _renderCCPending(item);
    else if (item.type === 'inv_pending') _renderInvoicePending(item);
  }

  // ── 🟡 未標記：品項歸屬標記 ──────────────────────────────────

  function _renderUntagged(item) {
    document.getElementById('pending-modal-title').textContent = `📋 ${item.shop}`;
    const ATTR_OPTS = ['Sin', 'Bear', '共用'];

    document.getElementById('pending-modal-body').innerHTML = `
      <p class="list-item-sub" style="margin-bottom:12px">${item.date}　${_fmt(item.amount)}</p>
      <div id="item-attr-list">
        ${item.invItems.map((it, i) => `
          <div class="pending-item-row" data-i="${i}">
            <div class="pending-item-name">${it.itemName}</div>
            <div class="pending-item-amount">${_fmt(it.itemAmount)}</div>
            <div class="chip-row" style="flex-wrap:wrap;gap:6px;margin-top:6px">
              ${ATTR_OPTS.map(opt => `
                <button class="chip${it.attribution === opt ? ' active' : ''}" data-attr="${opt}" data-i="${i}">${opt}</button>
              `).join('')}
            </div>
          </div>
        `).join('')}
      </div>
      <p id="pending-untagged-error" class="add-error hidden"></p>
    `;

    document.getElementById('pending-modal-footer').innerHTML = `
      <button class="btn-secondary" id="pending-untagged-cancel">取消</button>
      <button class="btn-primary" id="pending-untagged-save">儲存並匯入帳本</button>
    `;

    // 歸屬 chips
    const attrMap = {};
    item.invItems.forEach((it, i) => { attrMap[i] = it.attribution || ''; });

    document.querySelectorAll('#item-attr-list .chip[data-attr]').forEach(btn => {
      btn.addEventListener('click', () => {
        const i = parseInt(btn.dataset.i, 10);
        attrMap[i] = btn.dataset.attr;
        document.querySelectorAll(`#item-attr-list .chip[data-i="${i}"]`)
          .forEach(b => b.classList.toggle('active', b.dataset.attr === attrMap[i]));
      });
    });

    document.getElementById('pending-untagged-cancel').addEventListener('click', _closeDetail);
    document.getElementById('pending-untagged-save').addEventListener('click', async () => {
      const errEl = document.getElementById('pending-untagged-error');
      if (item.invItems.some((_, i) => !attrMap[i])) {
        errEl.textContent = '請為每個品項選擇歸屬';
        errEl.classList.remove('hidden');
        return;
      }
      const btn = document.getElementById('pending-untagged-save');
      btn.disabled = true;
      btn.textContent = '儲存中…';
      try {
        // 1. 更新品項明細歸屬
        for (let i = 0; i < item.invItems.length; i++) {
          await Sheets.updateItemRow(item.invItems[i].rowIndex, attrMap[i]);
        }
        // 2. 計算 sinShare / bearShare
        const totalAmount = item.amount;
        let bearTotal = 0;
        item.invItems.forEach((it, i) => {
          if (attrMap[i] === 'Bear') bearTotal += it.itemAmount;
          else if (attrMap[i] === '共用') bearTotal += Math.floor(it.itemAmount / 2);
        });
        const sinTotal = totalAmount - bearTotal;

        // 3. 寫入月度帳本
        const today = new Date().toISOString().slice(0, 16).replace('T', ' ');
        const row = [
          item.date, item.shop, totalAmount,
          '🌟 Star', '部分', item.invItems[0]?.category || '',
          sinTotal, bearTotal, '',
          '發票', item.invNum, today,
        ];
        await Sheets.appendMonthlyRow(row);

        Sheets.invalidateMonth(item.date.slice(0, 7));
        _closeDetail();
        await _reload();
        window.Home?.reload();
      } catch (e) {
        errEl.textContent = '儲存失敗：' + e.message;
        errEl.classList.remove('hidden');
        btn.disabled = false;
        btn.textContent = '儲存並匯入帳本';
      }
    });
  }

  // ── 🔴 負擔異常：修改 Sin/Bear 負擔 ─────────────────────────

  function _renderAnomaly(item) {
    const r = item.row;
    document.getElementById('pending-modal-title').textContent = `⚠️ ${r.item || '（未命名）'}`;

    document.getElementById('pending-modal-body').innerHTML = `
      <p class="list-item-sub" style="margin-bottom:12px">${r.date}　總金額 ${_fmt(r.amount)}　是否共用：${r.shared}</p>
      <label class="field-label">Sin 負擔</label>
      <div class="amount-wrap">
        <span class="amount-prefix">$</span>
        <input type="number" id="anomaly-sin" class="field-input amount-input" value="${r.sinShare ?? ''}" min="0" step="1" inputmode="decimal">
      </div>
      <label class="field-label">Bear 負擔</label>
      <div class="amount-wrap">
        <span class="amount-prefix">$</span>
        <input type="number" id="anomaly-bear" class="field-input amount-input" value="${r.bearShare ?? ''}" min="0" step="1" inputmode="decimal">
      </div>
      <p id="anomaly-error" class="add-error hidden"></p>
    `;

    document.getElementById('pending-modal-footer').innerHTML = `
      <button class="btn-secondary" id="anomaly-cancel">取消</button>
      <button class="btn-primary" id="anomaly-save">儲存</button>
    `;

    document.getElementById('anomaly-cancel').addEventListener('click', _closeDetail);
    document.getElementById('anomaly-save').addEventListener('click', async () => {
      const sin  = document.getElementById('anomaly-sin').value;
      const bear = document.getElementById('anomaly-bear').value;
      const errEl = document.getElementById('anomaly-error');
      if (sin === '' || bear === '') {
        errEl.textContent = '請填入 Sin 和 Bear 負擔金額';
        errEl.classList.remove('hidden');
        return;
      }
      const btn = document.getElementById('anomaly-save');
      btn.disabled = true;
      btn.textContent = '儲存中…';
      try {
        const row = [
          r.date, r.item, r.amount, r.payer, r.shared, r.category,
          parseFloat(sin), parseFloat(bear), r.note,
          r.source, r.sourceLink, r.importedAt,
        ];
        await Sheets.updateMonthlyRow(r.rowIndex, row);
        Sheets.invalidateMonth(r.date.slice(0, 7));
        _closeDetail();
        await _reload();
        window.Home?.reload();
      } catch (e) {
        errEl.textContent = '儲存失敗：' + e.message;
        errEl.classList.remove('hidden');
        btn.disabled = false;
        btn.textContent = '儲存';
      }
    });
  }

  // ── 🟠 疑似重複：確認刪除 ────────────────────────────────────

  function _renderDuplicate(item) {
    const r = item.row;
    const linkType = r.sourceLink.includes('→發票') ? '發票' : '信用卡';
    document.getElementById('pending-modal-title').textContent = `🔍 ${r.item || '（未命名）'}`;

    document.getElementById('pending-modal-body').innerHTML = `
      <p class="list-item-sub" style="margin-bottom:8px">此筆手動記帳可能與已匯入的${linkType}重複：</p>
      <div class="card" style="margin-bottom:8px">
        <div class="settings-row">
          <span class="settings-label">手動記帳</span>
        </div>
        <div class="list-item-title">${r.item}</div>
        <div class="list-item-sub">${r.date}　${_fmt(r.amount)}</div>
      </div>
      <div class="card">
        <div class="settings-row">
          <span class="settings-label">對應 ${linkType}</span>
        </div>
        <div class="list-item-sub">${r.sourceLink.replace(/=HYPERLINK\("[^"]*","([^"]*)"\)/i, '$1') || r.sourceLink}</div>
      </div>
      <p id="dup-error" class="add-error hidden"></p>
    `;

    document.getElementById('pending-modal-footer').innerHTML = `
      <button class="btn-secondary" id="dup-keep">保留（非重複）</button>
      <button class="btn-primary" id="dup-delete" style="background:var(--salmon)">刪除手動記帳</button>
    `;

    document.getElementById('dup-keep').addEventListener('click', _closeDetail);
    document.getElementById('dup-delete').addEventListener('click', async () => {
      if (!confirm('確定刪除這筆手動記帳？此操作無法復原')) return;
      const btn = document.getElementById('dup-delete');
      btn.disabled = true;
      btn.textContent = '刪除中…';
      try {
        await Sheets.deleteMonthlyRow(r.rowIndex, r.date.slice(0, 7));
        _closeDetail();
        await _reload();
        window.Home?.reload();
      } catch (e) {
        document.getElementById('dup-error').textContent = '刪除失敗：' + e.message;
        document.getElementById('dup-error').classList.remove('hidden');
        btn.disabled = false;
        btn.textContent = '刪除手動記帳';
      }
    });
  }

  // ── 🔵 信用卡待填：填是否共用 + 備注 ─────────────────────────

  function _renderCCPending(item) {
    const cc = item.cc;
    const SHARED_OPTS = ['是', '否', '部分', '-', 'x'];
    let selectedShared = '';
    document.getElementById('pending-modal-title').textContent = `🔵 ${cc.shop}`;

    document.getElementById('pending-modal-body').innerHTML = `
      <p class="list-item-sub" style="margin-bottom:12px">${cc.bank}　${cc.txDate}　${_fmt(cc.amount)}</p>
      <label class="field-label">是否共用</label>
      <div class="chip-row" id="cc-shared-chips" style="margin-bottom:12px">
        ${SHARED_OPTS.map(opt => `<button class="chip" data-opt="${opt}">${opt}</button>`).join('')}
      </div>
      <label class="field-label">備注</label>
      <input type="text" id="cc-note" class="field-input" value="${cc.note}" placeholder="選填">
      <p id="cc-error" class="add-error hidden"></p>
    `;
    document.getElementById('pending-modal-footer').innerHTML = `
      <button class="btn-secondary" id="cc-cancel">取消</button>
      <button class="btn-primary" id="cc-save">儲存</button>
    `;

    NoteChips.render('cc-note');

    document.querySelectorAll('#cc-shared-chips .chip').forEach(btn => {
      btn.addEventListener('click', () => {
        selectedShared = btn.dataset.opt;
        document.querySelectorAll('#cc-shared-chips .chip')
          .forEach(b => b.classList.toggle('active', b.dataset.opt === selectedShared));
      });
    });

    document.getElementById('cc-cancel').addEventListener('click', _closeDetail);
    document.getElementById('cc-save').addEventListener('click', async () => {
      const errEl = document.getElementById('cc-error');
      if (!selectedShared) {
        errEl.textContent = '請選擇是否共用';
        errEl.classList.remove('hidden');
        return;
      }
      const btn = document.getElementById('cc-save');
      btn.disabled = true;
      btn.textContent = '儲存中…';
      try {
        const note = document.getElementById('cc-note').value;
        await Sheets.updateCCShared(cc.rowIndex, selectedShared, note);
        _closeDetail();
        await _reload();
      } catch (e) {
        errEl.textContent = '儲存失敗：' + e.message;
        errEl.classList.remove('hidden');
        btn.disabled = false;
        btn.textContent = '儲存';
      }
    });
  }

  // ── 🟣 發票待填：填是否共用（部分 → 品項歸屬流程）──────────────

  function _renderInvoicePending(item) {
    const inv = item.inv;
    const SHARED_OPTS = ['是', '否', '部分', '-', 'x'];
    let selectedShared = '';
    document.getElementById('pending-modal-title').textContent = `🟣 ${inv.shop}`;

    function _showStep1() {
      document.getElementById('pending-modal-body').innerHTML = `
        <p class="list-item-sub" style="margin-bottom:12px">${inv.date}　${_fmt(inv.amount)}</p>
        <label class="field-label">是否共用</label>
        <div class="chip-row" id="inv-shared-chips" style="margin-bottom:12px">
          ${SHARED_OPTS.map(opt => `<button class="chip${selectedShared === opt ? ' active' : ''}" data-opt="${opt}">${opt}</button>`).join('')}
        </div>
        <p id="inv-error" class="add-error hidden"></p>
      `;
      document.getElementById('pending-modal-footer').innerHTML = `
        <button class="btn-secondary" id="inv-cancel">取消</button>
        <button class="btn-primary" id="inv-save">儲存</button>
      `;

      document.querySelectorAll('#inv-shared-chips .chip').forEach(btn => {
        btn.addEventListener('click', () => {
          selectedShared = btn.dataset.opt;
          document.querySelectorAll('#inv-shared-chips .chip')
            .forEach(b => b.classList.toggle('active', b.dataset.opt === selectedShared));
        });
      });

      document.getElementById('inv-cancel').addEventListener('click', _closeDetail);
      document.getElementById('inv-save').addEventListener('click', async () => {
        const errEl = document.getElementById('inv-error');
        if (!selectedShared) {
          errEl.textContent = '請選擇是否共用';
          errEl.classList.remove('hidden');
          return;
        }
        if (selectedShared === '部分') {
          _showStep2();
          return;
        }
        const btn = document.getElementById('inv-save');
        btn.disabled = true;
        btn.textContent = '儲存中…';
        try {
          await Sheets.updateInvoiceShared(inv.rowIndex, selectedShared);
          _closeDetail();
          await _reload();
        } catch (e) {
          errEl.textContent = '儲存失敗：' + e.message;
          errEl.classList.remove('hidden');
          btn.disabled = false;
          btn.textContent = '儲存';
        }
      });
    }

    function _showStep2() {
      const ATTR_OPTS = ['Sin', 'Bear', '共用'];
      document.getElementById('pending-modal-body').innerHTML = `
        <p class="list-item-sub" style="margin-bottom:12px">${inv.date}　${_fmt(inv.amount)}</p>
        <div id="item-attr-list">
          ${item.invItems.map((it, i) => `
            <div class="pending-item-row" data-i="${i}">
              <div class="pending-item-name">${it.itemName}</div>
              <div class="pending-item-amount">${_fmt(it.itemAmount)}</div>
              <div class="chip-row" style="flex-wrap:wrap;gap:6px;margin-top:6px">
                ${ATTR_OPTS.map(opt => `
                  <button class="chip${it.attribution === opt ? ' active' : ''}" data-attr="${opt}" data-i="${i}">${opt}</button>
                `).join('')}
              </div>
            </div>
          `).join('')}
        </div>
        <p id="inv-attr-error" class="add-error hidden"></p>
      `;
      document.getElementById('pending-modal-footer').innerHTML = `
        <button class="btn-secondary" id="inv-back">← 上一步</button>
        <button class="btn-primary" id="inv-attr-save">儲存並匯入帳本</button>
      `;

      const attrMap = {};
      item.invItems.forEach((it, i) => { attrMap[i] = it.attribution || ''; });

      document.querySelectorAll('#item-attr-list .chip[data-attr]').forEach(btn => {
        btn.addEventListener('click', () => {
          const i = parseInt(btn.dataset.i, 10);
          attrMap[i] = btn.dataset.attr;
          document.querySelectorAll(`#item-attr-list .chip[data-i="${i}"]`)
            .forEach(b => b.classList.toggle('active', b.dataset.attr === attrMap[i]));
        });
      });

      document.getElementById('inv-back').addEventListener('click', _showStep1);
      document.getElementById('inv-attr-save').addEventListener('click', async () => {
        const errEl = document.getElementById('inv-attr-error');
        if (item.invItems.some((_, i) => !attrMap[i])) {
          errEl.textContent = '請為每個品項選擇歸屬';
          errEl.classList.remove('hidden');
          return;
        }
        const btn = document.getElementById('inv-attr-save');
        btn.disabled = true;
        btn.textContent = '儲存中…';
        try {
          for (let i = 0; i < item.invItems.length; i++) {
            await Sheets.updateItemRow(item.invItems[i].rowIndex, attrMap[i]);
          }
          await Sheets.updateInvoiceShared(inv.rowIndex, '部分共用');
          const totalAmount = inv.amount;
          let bearTotal = 0;
          item.invItems.forEach((it, i) => {
            if (attrMap[i] === 'Bear') bearTotal += it.itemAmount;
            else if (attrMap[i] === '共用') bearTotal += Math.floor(it.itemAmount / 2);
          });
          const today = new Date().toISOString().slice(0, 16).replace('T', ' ');
          await Sheets.appendMonthlyRow([
            inv.date, inv.shop, totalAmount,
            '🌟 Star', '部分', item.invItems[0]?.category || '',
            totalAmount - bearTotal, bearTotal, '',
            '發票', inv.invNum, today,
          ]);
          Sheets.invalidateMonth(inv.date.slice(0, 7));
          _closeDetail();
          await _reload();
          window.Home?.reload();
        } catch (e) {
          errEl.textContent = '儲存失敗：' + e.message;
          errEl.classList.remove('hidden');
          btn.disabled = false;
          btn.textContent = '儲存並匯入帳本';
        }
      });
    }

    _showStep1();
  }

  // ── 載入 ─────────────────────────────────────────────────────

  async function _reload() {
    const el = document.getElementById('pending-list');
    if (el) el.innerHTML = '<div class="spinner"></div>';
    document.getElementById('pending-count').textContent = '';
    try {
      await _collect();
      _renderList();
    } catch (e) {
      if (e.message !== 'auth_expired' && el) {
        el.innerHTML = `<div class="empty-state"><span>⚠️</span><p>${e.message}</p></div>`;
      }
    }
  }

  function _buildShell() {
    document.getElementById('tab-pending').innerHTML = `
      <div class="home-nav" style="margin-bottom:16px">
        <span style="flex:1;font-size:16px;font-weight:600">待處理</span>
        <span id="pending-count" class="ledger-count"></span>
        <button class="month-btn refresh-btn" id="pending-refresh" title="重新載入">↺</button>
      </div>
      <div class="card" id="pending-list"></div>
    `;
    document.getElementById('pending-refresh').addEventListener('click', _reload);
  }

  function jumpTo({ bank } = {}) {
    _jumpBank = bank || '';
    Router.navigate('pending');
  }

  function activate() {
    if (_jumpBank !== null) {
      _bankFilter = _jumpBank;
      _jumpBank   = null;
      _reload();
    }
  }

  function init() {
    _buildShell();
    if (_jumpBank !== null) {
      _bankFilter = _jumpBank;
      _jumpBank   = null;
    }
    _reload();
  }

  return { init, reload: _reload, activate, jumpTo };
})();

window.Pending = Pending;
