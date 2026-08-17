const Pending = (() => {
  let _items      = [];  // { type, label, color, row/invoice/... }
  let _bankFilter  = '';  // '' = 全部；有值時只顯示 cc_pending 且 cc.bank === _bankFilter
  let _jumpBank    = null; // jumpTo 暫存，等 activate/init 時套用
  let _currentItem = null; // 目前 modal 中的 item（用於 auto-advance）
  let _advanceIdx  = -1;   // reload 後自動開啟的清單索引（-1 = 不自動開啟）
  let _pendingMonth = null; // {year, month} 月份切換器選的月份；null = 尚未初始化（首次取最新有項目的月）

  const CATEGORIES = ['🍴', '🛒', '🧋', '⛽', '📦', '🎬', '👗', '🏠', '💊', '📚', '🎁'];
  const APP_INVOICE_CARRIERS = new Set(['掃描發票', '手查發票']);
  const _isAppInvoiceCarrier = carrier => APP_INVOICE_CARRIERS.has(carrier);
  const _sourceFromCarrier = carrier => _isAppInvoiceCarrier(carrier) ? carrier : '發票';
  const _carrierLabel = carrier => carrier === '手查發票' ? '手查發票' : carrier === '掃描發票' ? '掃描發票' : '發票';

  // 日期 → 天序號（UTC），供單向日期比較；支援 YYYYMMDD / YYYY-MM-DD / YYYY/MM/DD
  function _dayNum(dateStr) {
    const s = String(dateStr || '').replace(/^'/, '').trim();
    let m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (!m) m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
    if (!m) return null;
    return Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000;
  }

  // 平台判定（_invCandidatesForCC 與 scan_cc_dup 共用，避免兩套規則各自漂移）
  //   備註「或」商店名任一命中即算平台訂單。原本只看備註，但「新加坡商蝦皮娛樂電商」
  //   那類發票備註是空的、只有商店名帶「蝦皮」，會被誤判成一般消費而套錯規則。
  //   商店名也比對 merchants（優食／優步 同時是 CC 商店字串與發票商店名）。
  function _platformKeyOf(inv, platformMap) {
    const hay = `${inv.note || ''} ${inv.shop || ''}`.toLowerCase();
    for (const [p, merchants] of Object.entries(platformMap)) {
      if (hay.includes(p.toLowerCase())) return p;
      if ((merchants || []).some(m => hay.includes(m.toLowerCase()))) return p;
    }
    return CONFIG.CC_PAY_KEYWORDS.find(kw => hay.includes(kw.toLowerCase())) || '';
  }

  // 平台的日期容差：蝦皮出貨慢，沿用既有決策「蝦皮發票日期容許範圍 10 天」
  const _platformDayRange = key => key.includes('蝦皮') ? 10 : 3;

  // 🔵 信用卡待填 → 可連結的現有發票候選（CC 驅動，與 scan_cc_dup 反向）
  //   發票須已匯入月度帳本、未被其他 CC 連走（linkedInvNums 去重，一張發票只能連一次）
  //   日期分兩種：
  //     · 實體店（非平台）＝單向 0~+3 天，發票在消費當下開立，帳單不會比發票早到
  //     · 電商平台＝雙向 ±3（蝦皮 ±10），下單就扣款、出貨才開票，發票常晚於刷卡
  //       （實例：CC 07/21 樂購蝦皮 $215 對應發票 07-27 開立，晚 6 天）
  //   金額：平台不比（CC 含運費/服務費）改比平台商家名；非平台要求完全一致
  //   載具來源不限，財政部彙整發票也可連
  function _invCandidatesForCC(cc, invoices, linkedInvNums, platformMap) {
    const ccDay = _dayNum(cc.txDate);
    if (ccDay === null) return [];

    const out = invoices.filter(inv => {
      if (inv.imported !== 'TRUE' || !inv.invNum) return false;
      if (inv.status === '作廢') return false;
      if (!inv.shared || inv.shared === 'x') return false;
      if (linkedInvNums.has(inv.invNum)) return false;

      const invDay = _dayNum(inv.date);
      if (invDay === null) return false;
      const diff = ccDay - invDay;

      const platformKey = _platformKeyOf(inv, platformMap);
      if (platformKey) {
        if (Math.abs(diff) > _platformDayRange(platformKey)) return false;
        const merchants = platformMap[platformKey] || [];
        return merchants.some(m => cc.shop.includes(m));
      }
      if (diff < 0 || diff > 3) return false;
      return cc.amount === inv.amount;
    });

    // 日期最接近排前（平台可能為負，取絕對值）→ 金額接近排前
    return out.sort((a, b) => {
      const da = Math.abs(ccDay - _dayNum(a.date));
      const db = Math.abs(ccDay - _dayNum(b.date));
      if (da !== db) return da - db;
      return Math.abs(cc.amount - a.amount) - Math.abs(cc.amount - b.amount);
    });
  }

  function _fmt(n) {
    return '$' + Math.abs(n).toLocaleString('zh-TW');
  }
  // 刷退是負數，_fmt 取絕對值會把負號吃掉；不動 _fmt（其他呼叫端都靠它去號）
  function _fmtSigned(n) { return (n < 0 ? '−' : '') + _fmt(n); }

  function _normalizeItemAttribution(value) {
    if (value === 'Sin') return '🌟 Sin';
    if (value === 'Bear') return '🐨 Bear';
    return value || '';
  }

  function _defaultPayer() {
    const email = (Auth.getEmail() || '').toLowerCase();
    const bearEmail = (CONFIG.EMAIL_WHITELIST?.[1] || '').toLowerCase();
    return email === bearEmail ? '🐨 Bear' : '🌟 Star';
  }

  // ── 資料收集 ──────────────────────────────────────────────────

  async function _collect() {
    const [monthlyRaw, invoices, items, ccPendingRows, ccAllRows, platformMap, refundPairs] = await Promise.all([
      _getAllMonthly(),
      Sheets.getInvoiceData(),
      Sheets.getItemData(),
      Sheets.getCCPendingData(),
      Sheets.getCCAllData(),
      Sheets.getRulesData(),
      Sheets.getRefundPairs(),
    ]);

    const result = [];

    // CC I 欄已連結的發票號碼；cc_pending 候選與 scan_cc_dup 共用同一份，
    //   確保一張發票不會被兩筆 CC 連走（2026-06-16 誤配事故的根治條件之一）
    const linkedInvNums = new Set(ccAllRows.map(cc => cc.matched).filter(Boolean));

    // 🟡 未標記：發票明細 is_shared=部分共用，且品項明細有空白歸屬
    const partialInvNums = new Set(
      invoices
        .filter(inv => inv.shared === '部分' && inv.status !== '作廢' && inv.imported !== 'TRUE')
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
        category: invRow?.category || '',
        note: invRow?.note || '',
        carrier: invRow?.carrier || '',
        invRowIndex: invRow?.rowIndex,
        invItems,
      });
    });

    // 🔴 負擔異常：月度帳本 is_shared 非空非 -/x 但 sinShare/bearShare 都空
    monthlyRaw.forEach(r => {
      if (!r.shared || r.shared === 'x') return;
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

    // 🔄 刷退待確認：F32。能自動處理的已由 matchCCRefunds 在下載時標掉，
    //    留在這裡的都是「系統不該替使用者決定」的——已匯入、超過 20 天、多候選、已有共用值。
    refundPairs.needConfirm.forEach(p => {
      result.push({
        type: 'cc_refund',
        label: '刷退待確認',
        color: '#C77DFF',
        refund: p.refund,
        buy: p.buy || null,
        cands: p.cands || null,
        days: p.days,
        reason: p.reason,
        invRowIndex: p.invRowIndex || null,
        invDate: p.invDate || '',
        monthlyRow: p.monthlyRow || null,
        monthlyDate: p.monthlyDate || '',
      });
    });

    // 🔵 信用卡待填：H欄空 + K欄非✓
    ccPendingRows.forEach(cc => {
      result.push({
        type: 'cc_pending',
        label: '信用卡待填',
        color: '#4B9FE1',
        cc,
        invCandidates: _invCandidatesForCC(cc, invoices, linkedInvNums, platformMap),
      });
    });

    // 🟣 發票待填：shared 空，或 shared 已填但類別仍空（無法匯入月度帳本）
    invoices
      .filter(inv => (inv.shared === '' || (!inv.category && inv.imported !== 'TRUE' && inv.shared !== 'x'))
                    && inv.status !== '作廢' && inv.invNum !== '')
      .forEach(inv => {
        result.push({
          type: 'inv_pending',
          label: '發票待填',
          color: '#9B59B6',
          inv,
          invItems: items.filter(it => it.invNum === inv.invNum),
        });
      });

    // 🟤 平台待配對：App 發票備註含平台關鍵字 + 尚未匯入月度帳本（等待 CC 配對）
    invoices
      .filter(inv =>
        _isAppInvoiceCarrier(inv.carrier) &&
        inv.imported !== 'TRUE' &&
        inv.shared !== 'x' && inv.shared !== '' &&
        CONFIG.CC_PAY_KEYWORDS.some(kw => inv.note.toLowerCase().includes(kw.toLowerCase()))
      )
      .forEach(inv => {
        const platformKey = Object.keys(platformMap).find(
          p => inv.note.toLowerCase().includes(p.toLowerCase())
        ) || CONFIG.CC_PAY_KEYWORDS.find(
          kw => inv.note.toLowerCase().includes(kw.toLowerCase())
        ) || '';

        const merchants = platformMap[platformKey] || [];
        const invDate   = new Date(inv.date);
        const candidates = ccAllRows
          .filter(cc => {
            if (cc.shared === 'x' || cc.matched) return false;
            const diff = Math.abs((invDate - new Date(cc.txDate)) / 86400000);
            return diff <= 3 && merchants.some(m => cc.shop.includes(m));
          })
          .sort((a, b) =>
            Math.abs(new Date(a.txDate) - invDate) - Math.abs(new Date(b.txDate) - invDate)
          );

        result.push({
          type: 'platform_unlinked',
          label: '平台待配對',
          color: '#E17055',
          inv,
          invItems: items.filter(it => it.invNum === inv.invNum),
          platformKey,
          candidates,
        });
      });

    // 🔗 掃描/CC配對：已匯入發票尚未連結 CC → 列候選讓使用者選（發票驅動）
    //   發票已被某 CC 連結（已配對完成）→ 排除，不再偵測
    //   平台發票（備註含平台關鍵字）：平台商店 mapping + 日期範圍（金額不等，不用金額）
    //   非平台發票：金額完全一致 + 日期 ±3
    //   （linkedInvNums 已於本函式開頭建立，與 cc_pending 候選共用）
    invoices
      .filter(inv =>
        _isAppInvoiceCarrier(inv.carrier) &&
        inv.imported === 'TRUE' &&
        inv.shared !== 'x' && inv.shared !== '' && inv.invNum !== '' &&
        !linkedInvNums.has(inv.invNum)
      )
      .forEach(inv => {
        const invDate     = new Date(inv.date);
        const platformKey = _platformKeyOf(inv, platformMap);   // 與 cc_pending 候選共用同一套判定

        let candidates;
        if (platformKey) {
          const merchants = platformMap[platformKey] || [];
          const dayRange  = _platformDayRange(platformKey);
          candidates = ccAllRows.filter(cc => {
            if (cc.shared === 'x' || cc.matched) return false;
            const diff = Math.abs((invDate - new Date(cc.txDate)) / 86400000);
            return diff <= dayRange && merchants.some(m => cc.shop.includes(m));
          });
        } else {
          candidates = ccAllRows.filter(cc => {
            if (cc.shared === 'x' || cc.matched) return false;
            const diff = Math.abs((invDate - new Date(cc.txDate)) / 86400000);
            return diff <= 3 && cc.amount === inv.amount;   // 非平台：金額完全一致
          });
        }
        if (!candidates.length) return;

        // 排序：日期最近排前 → 金額接近排前
        candidates = candidates.slice().sort((a, b) => {
          const da = Math.abs(new Date(a.txDate) - invDate);
          const db = Math.abs(new Date(b.txDate) - invDate);
          if (da !== db) return da - db;
          return Math.abs(a.amount - inv.amount) - Math.abs(b.amount - inv.amount);
        });

        result.push({
          type: 'scan_cc_dup',
          label: '掃描/CC配對',
          color: '#17B897',
          inv,
          candidates,
          invItems: items.filter(it => it.invNum === inv.invNum),
        });
      });

    // 🟠 CC 疑似與發票重複：shared 已填、未匯入、未連結，但有日期±5天+金額相同的發票
    ccAllRows
      .filter(cc =>
        ['是','否','部分','-'].includes(cc.shared) &&
        cc.imported !== 'TRUE' && cc.imported !== 'True' &&
        !cc.matched &&
        cc.amount > 0 && cc.shop
      )
      .forEach(cc => {
        const ccDate = new Date(cc.txDate);
        const suspects = invoices.filter(inv => {
          if (inv.status === '作廢' || (inv.shared || '') === 'x') return false;
          const diff = Math.abs((ccDate - new Date(inv.date)) / 86400000);
          const isPlatform = CONFIG.CC_PAY_KEYWORDS.some(kw => (inv.note || '').toLowerCase().includes(kw.toLowerCase()));
          return diff <= (isPlatform ? 5 : 1) && cc.amount === inv.amount;
        });
        if (!suspects.length) return;
        result.push({
          type: 'cc_inv_suspect',
          label: '疑似重複',
          color: '#FF9F43',
          cc,
          suspects: suspects.map(inv => ({
            ...inv,
            invItems: items.filter(it => it.invNum === inv.invNum),
          })),
        });
      });

    // 排序：🔴 > 🟠 > 🟡 > 🔵 > 🟤 > 🔗 > 🟣 > ⚠
    const order = { anomaly: 0, duplicate: 1, cc_inv_suspect: 2, untagged: 3, cc_pending: 4, platform_unlinked: 5, scan_cc_dup: 6, inv_pending: 7, cc_refund: 8 };
    result.sort((a, b) => (order[a.type] ?? 99) - (order[b.type] ?? 99));
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

  // ── 月份篩選 helper ──────────────────────────────────────────
  function _ymOf(dateStr) {
    const s = String(dateStr || '').replace(/^'/, '').trim();
    let m = s.match(/^(\d{4})(\d{2})(\d{2})$/);            // YYYYMMDD
    if (m) return `${m[1]}-${m[2]}`;
    m = s.match(/^(\d{4})[-/](\d{1,2})/);                  // YYYY-MM-DD / YYYY/MM/DD
    if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}`;
    return '';
  }
  function _itemDate(it) {
    // cc_refund 以刷退日歸月（帳單上看到退費的那個月才是使用者會來找的月份）
    return it.cc?.txDate || it.inv?.date || it.row?.date || it.refund?.txDate || it.date || '';
  }
  function _defaultMonth(items) {
    let best = '';
    items.forEach(it => { const ym = _ymOf(_itemDate(it)); if (ym && ym > best) best = ym; });
    if (best) { const [y, mo] = best.split('-'); return { year: +y, month: +mo }; }
    const d = new Date(); return { year: d.getFullYear(), month: d.getMonth() + 1 };
  }
  function _allItems() {
    return _bankFilter
      ? _items.filter(it => it.type === 'cc_pending' && it.cc.bank === _bankFilter)
      : _items;
  }
  function _visibleItems() {
    const all = _allItems();
    if (_bankFilter) return all;
    if (!_pendingMonth) _pendingMonth = _defaultMonth(all);
    const ymSel = `${_pendingMonth.year}-${String(_pendingMonth.month).padStart(2, '0')}`;
    return all.filter(it => { const ym = _ymOf(_itemDate(it)); return ym === ymSel || ym === ''; });
  }
  function _shiftMonth(delta) {
    if (!_pendingMonth) _pendingMonth = _defaultMonth(_allItems());
    let { year, month } = _pendingMonth;
    month += delta;
    if (month < 1)  { month = 12; year--; }
    if (month > 12) { month = 1;  year++; }
    _pendingMonth = { year, month };
    _renderList();
  }

  // ── 渲染列表 ──────────────────────────────────────────────────

  function _renderList() {
    const el = document.getElementById('pending-list');
    const all   = _allItems();
    const items = _visibleItems();

    const monthNav  = document.getElementById('pending-month-nav');
    const summaryEl = document.getElementById('pending-summary');
    if (_bankFilter) {
      monthNav?.classList.add('hidden');
      if (summaryEl) summaryEl.textContent = `${items.length} 項`;
    } else {
      monthNav?.classList.remove('hidden');
      const lbl = document.getElementById('pending-month-lbl');
      if (lbl) lbl.textContent = `${_pendingMonth.year}年${_pendingMonth.month}月`;
      if (summaryEl) summaryEl.textContent = `${_pendingMonth.month}月共 ${items.length} 張　待處理共 ${all.length} 張`;
    }

    let html = '';
    if (_bankFilter) {
      html += `<div class="list-item" style="gap:8px;padding:8px 12px;align-items:center">
        <span class="pending-badge" style="background:#4B9FE122;color:#4B9FE1">🔵 ${_bankFilter}</span>
        <span class="list-item-sub" style="flex:1">信用卡待填</span>
        <button id="pending-clear-filter" class="month-btn" style="font-size:12px;padding:2px 8px">✕</button>
      </div>`;
    }

    if (!items.length) {
      const msg = (!_bankFilter && all.length > 0)
        ? `本月無待處理（其他月份還有 ${all.length} 張，用 ◀ ▶ 切換）`
        : '沒有待處理項目';
      html += `<div class="empty-state"><span>✅</span><p>${msg}</p></div>`;
    } else {
      html += items.map((it, idx) => {
        let title, sub, amount;
        let catIcon = '';
        let amtClass = 'amount-expense';
        let amtFmt = _fmt;
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
          catIcon = `<span class="inv-cat-pickable list-item-icon cat-pickable" data-idx="${idx}">${it.inv.category || '✘'}</span>`;
        } else if (it.type === 'platform_unlinked') {
          title  = it.inv.shop || it.inv.invNum;
          sub    = `${it.inv.date}　[${it.platformKey}]　${it.candidates.length ? `${it.candidates.length} 筆候選 CC` : '等待 CC 到達'}`;
          amount = it.inv.amount;
        } else if (it.type === 'scan_cc_dup') {
          title  = it.inv.shop || it.inv.invNum;
          sub    = `${it.inv.date}　${it.candidates.length} 筆候選 CC`;
          amount = it.inv.amount;
        } else if (it.type === 'cc_inv_suspect') {
          title  = it.cc.shop;
          sub    = `${it.cc.bank}　${it.cc.txDate}　${it.suspects.length} 筆候選發票`;
          amount = it.cc.amount;
        } else if (it.type === 'cc_refund') {
          title  = it.refund.shop;
          sub    = it.buy
            ? `刷退 ${it.refund.txDate}　消費 ${it.buy.txDate}（間隔 ${it.days} 天）`
            : `刷退 ${it.refund.txDate}　${it.cands.length} 筆候選消費`;
          amount = it.refund.amount;
          amtClass = 'amount-income';   // 退費是負數，用紅色顯示會誤導
          amtFmt = _fmtSigned;
        } else {
          title  = it.row.item || '（未命名）';
          sub    = it.row.date;
          amount = it.row.amount;
        }
        return `
          <div class="list-item pending-item" data-idx="${idx}" style="cursor:pointer">
            ${catIcon}
            <span class="pending-badge" style="background:${it.color}22;color:${it.color}">${it.label}</span>
            <div class="list-item-body">
              <div class="list-item-title">${title}</div>
              <div class="list-item-sub">${sub}</div>
            </div>
            <div class="list-item-right ${amtClass}">${amtFmt(amount)}</div>
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

    el.querySelectorAll('.inv-cat-pickable').forEach(icon => {
      icon.addEventListener('click', e => {
        e.stopPropagation();
        const idx = parseInt(icon.dataset.idx, 10);
        _invCatPicker(items[idx]);
      });
    });
  }

  // ── 發票類別快速選盤（點列表 emoji → 直接改發票明細 G 欄）────────

  function _invCatPicker(item) {
    const inv = item.inv;
    const cur = inv.category || '';
    const grid = CATEGORIES.map(c =>
      `<button class="cat-pick-btn${cur === c ? ' active' : ''}" data-cat="${c}">${c}</button>`
    ).join('');
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal-sheet" style="max-height:50dvh;">
        <div class="modal-header">
          <span class="modal-title">選擇類別</span>
          <button class="modal-close" id="inv-cat-pick-close">✕</button>
        </div>
        <div class="modal-body">
          <p style="font-size:13px;color:var(--text-sub);margin-bottom:4px;">${inv.shop || inv.invNum}</p>
          <div class="cat-pick-grid">${grid}</div>
          <p class="cat-pick-error add-error hidden"></p>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.querySelector('#inv-cat-pick-close').addEventListener('click', close);
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
    overlay.querySelectorAll('.cat-pick-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const newCat = btn.dataset.cat;
        if (newCat === cur) { close(); return; }
        overlay.querySelectorAll('.cat-pick-btn').forEach(b => { b.disabled = true; });
        try {
          await Sheets.updateInvoiceFields(inv.rowIndex, { category: newCat });
          close();
          await _reload();
        } catch (err) {
          const errEl = overlay.querySelector('.cat-pick-error');
          errEl.textContent = '儲存失敗：' + err.message;
          errEl.classList.remove('hidden');
          overlay.querySelectorAll('.cat-pick-btn').forEach(b => { b.disabled = false; });
        }
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
    _currentItem = null;
    document.getElementById('pending-modal')?.classList.add('hidden');
  }

  // 存入後關閉：捕捉當前 index，reload 後自動開下一筆
  // 用 _visibleItems()（與 _reload 自動跳轉同一份清單，含月份篩選）確保 index 一致
  function _saveClose() {
    if (_currentItem) {
      _advanceIdx = _visibleItems().findIndex(it => it === _currentItem);
    }
    _closeDetail();
  }

  function _openDetail(item) {
    _currentItem = item;
    _buildDetailModal();
    document.getElementById('pending-modal').classList.remove('hidden');

    if (item.type === 'untagged')              _renderUntagged(item);
    else if (item.type === 'anomaly')          _renderAnomaly(item);
    else if (item.type === 'duplicate')        _renderDuplicate(item);
    else if (item.type === 'cc_pending')       _renderCCPending(item);
    else if (item.type === 'platform_unlinked') _renderPlatformUnlinked(item);
    else if (item.type === 'inv_pending')      _renderInvoicePending(item);
    else if (item.type === 'scan_cc_dup')      _renderScanCCDup(item);
    else if (item.type === 'cc_inv_suspect')  _renderCCInvSuspect(item);
    else if (item.type === 'cc_refund')        _renderCCRefund(item);
  }

  // ── 🟠 CC 疑似與發票重複 ────────────────────────────────────────

  function _renderCCInvSuspect(item) {
    const { cc, suspects } = item;
    let selectedInv = suspects.length === 1 ? suspects[0] : null;
    document.getElementById('pending-modal-title').textContent = `⚠ ${cc.shop}`;

    const _invItemsHtml = (inv) => {
      if (!inv.invItems || !inv.invItems.length) return '';
      return `<div class="suspect-items" style="padding:4px 0 0 12px;font-size:12px;color:var(--text-sub,#888)">
        ${inv.invItems.map(it => `<div>${it.itemName}　${_fmt(it.itemAmount)}</div>`).join('')}
      </div>`;
    };

    document.getElementById('pending-modal-body').innerHTML = `
      <p class="list-item-sub" style="margin-bottom:4px">${cc.bank}　${cc.txDate}　${_fmt(cc.amount)}</p>
      <p class="list-item-sub" style="margin-bottom:12px;font-size:12px;opacity:.7">
        這筆 CC 的日期（±5天）和金額與下列發票相同，可能是同一筆消費。
      </p>
      <label class="field-label">對應的發票</label>
      <div id="suspect-inv-list">
        ${suspects.map((inv, i) => `
          <div class="list-item cc-inv-item${suspects.length === 1 ? ' active' : ''}" data-i="${i}" style="cursor:pointer;border-radius:8px;margin-bottom:4px">
            <div class="list-item-body">
              <div class="list-item-title">${inv.shop || inv.invNum}${
                inv.shared ? ` <span class="tag-shared">${inv.shared}</span>` : ''}</div>
              <div class="list-item-sub">${inv.date}　${inv.invNum}</div>
              ${_invItemsHtml(inv)}
            </div>
            <div class="list-item-right amount-expense">${_fmt(inv.amount)}</div>
          </div>`).join('')}
      </div>
      <p id="suspect-error" class="add-error hidden"></p>
    `;

    document.getElementById('pending-modal-footer').innerHTML = `
      <button class="btn-secondary" id="suspect-cancel">取消</button>
      <button class="btn-primary" id="suspect-is-dup"${selectedInv ? '' : ' disabled'}>是重複（連結發票）</button>
      <button class="btn-secondary" id="suspect-not-dup">不是重複（直接匯入）</button>
    `;

    document.querySelectorAll('#suspect-inv-list .cc-inv-item').forEach(row => {
      row.addEventListener('click', () => {
        document.querySelectorAll('#suspect-inv-list .cc-inv-item').forEach(r => r.classList.remove('active'));
        row.classList.add('active');
        selectedInv = suspects[parseInt(row.dataset.i)];
        document.getElementById('suspect-is-dup').disabled = false;
      });
    });

    document.getElementById('suspect-cancel').addEventListener('click', _closeDetail);

    document.getElementById('suspect-is-dup').addEventListener('click', async () => {
      if (!selectedInv) return;
      const btn = document.getElementById('suspect-is-dup');
      btn.disabled = true;
      btn.textContent = '連結中…';
      try {
        await Sheets.linkCCToInvoice(cc.rowIndex, selectedInv.invNum, selectedInv.rowIndex);
        _saveClose();
        await _reload();
      } catch (e) {
        const errEl = document.getElementById('suspect-error');
        errEl.textContent = '連結失敗：' + e.message;
        errEl.classList.remove('hidden');
        btn.disabled = false;
        btn.textContent = '是重複（連結發票）';
      }
    });

    document.getElementById('suspect-not-dup').addEventListener('click', async () => {
      const btn = document.getElementById('suspect-not-dup');
      btn.disabled = true;
      btn.textContent = '匯入中…';
      try {
        await Sheets.importSingleCC(cc.rowIndex);
        _saveClose();
        await _reload();
      } catch (e) {
        const errEl = document.getElementById('suspect-error');
        errEl.textContent = '匯入失敗：' + e.message;
        errEl.classList.remove('hidden');
        btn.disabled = false;
        btn.textContent = '不是重複（直接匯入）';
      }
    });
  }

  // ── 🔄 刷退待確認：F32 ────────────────────────────────────────
  //  自動處理不了的刷退。重點是把「為什麼不自動」講清楚，並在對應消費已經
  //  進了月度帳本時給跳轉入口——那種情況標 x 是無效的，得去帳本自己改。

  function _renderCCRefund(item) {
    const { refund, buy, cands, days, reason, invRowIndex, invDate, monthlyRow, monthlyDate } = item;
    document.getElementById('pending-modal-title').textContent = `🔄 ${refund.shop}`;

    // 已匯入的兩種情形都無法靠標 x 解決，要醒目提示
    const imported = buy && (buy.imported === 'TRUE' || buy.invImported);
    const warnHtml = imported
      ? `<div class="refund-warn">
           <strong>⚠ 標 x 解決不了這筆</strong>
           <p>這筆消費${buy.invImported ? '的發票' : ''}已經匯入月度帳本，帳本裡那筆
              ${buy.invImported ? '是發票端寫進去的' : '是 CC 端寫進去的'}，
              把信用卡明細標 x <b>不會</b>把它扣回。請直接到帳本處理。</p>
         </div>`
      : `<p class="refund-reason">${reason}</p>`;

    const rowHtml = (r, tag) => `
      <div class="list-item" style="border-radius:8px;margin-bottom:4px">
        <div class="list-item-body">
          <div class="list-item-title">${tag}　${r.shop}</div>
          <div class="list-item-sub">${r.bank}　${r.txDate}${r.shared ? `　共用=${r.shared}` : ''}</div>
        </div>
        <div class="list-item-right ${r.amount < 0 ? 'amount-income' : 'amount-expense'}">${_fmtSigned(r.amount)}</div>
      </div>`;

    const pairHtml = buy
      ? `${rowHtml(buy, '消費')}${rowHtml(refund, '刷退')}
         <p class="list-item-sub" style="margin:4px 0 0">間隔 ${days} 天</p>`
      : `${rowHtml(refund, '刷退')}
         <div class="section-title" style="margin-top:12px">同名同額的消費（${cands.length} 筆）</div>
         ${cands.map(c => rowHtml(c, '候選')).join('')}
         <p class="list-item-sub" style="margin:4px 0 0">候選超過一筆，請直接到明細頁確認要沖銷哪一筆</p>`;

    const jumpHtml = imported
      ? `<div class="chip-row" style="margin-top:12px">
           ${invRowIndex ? '<button class="chip" id="refund-goto-inv">🧾 查看發票</button>' : ''}
           <button class="chip" id="refund-goto-ledger">📒 查看帳本列</button>
         </div>`
      : '';

    document.getElementById('pending-modal-body').innerHTML = warnHtml + pairHtml + jumpHtml;

    // 只有「單一候選 + 未匯入」才給一鍵沖銷；其餘一律不提供，避免做出無效動作
    const canApply = buy && !imported;
    document.getElementById('pending-modal-footer').innerHTML = `
      <button class="btn-secondary" id="refund-cancel">關閉</button>
      ${canApply ? '<button class="btn-primary" id="refund-confirm">確認沖銷（兩筆標 x）</button>' : ''}
    `;

    document.getElementById('refund-cancel').onclick = _closeDetail;
    document.getElementById('refund-goto-inv')?.addEventListener('click', () => {
      _closeDetail(); Ledger.jumpTo({ invoiceRow: invRowIndex, invoiceDate: invDate });
    });
    document.getElementById('refund-goto-ledger')?.addEventListener('click', () => {
      _closeDetail();
      // 帶上 rowIndex + 月份才定位得到；找不到目標列時退回單純切到月度帳本
      Ledger.jumpTo(monthlyRow ? { rowIndex: monthlyRow, monthlyDate } : {});
    });
    if (canApply) {
      document.getElementById('refund-confirm').onclick = async () => {
        const btn = document.getElementById('refund-confirm');
        btn.disabled = true; btn.textContent = '處理中…';
        try {
          await Sheets.applyRefundPair(refund, buy);
          _closeDetail();
          await _reload();
        } catch (e) {
          btn.disabled = false; btn.textContent = '確認沖銷（兩筆標 x）';
          alert(`沖銷失敗：${e.message}`);
        }
      };
    }
  }

  // ── 🟡 未標記：品項歸屬標記 ──────────────────────────────────

  function _renderUntagged(item) {
    document.getElementById('pending-modal-title').textContent = `📋 ${item.shop}`;
    const ATTR_OPTS = ['🌟 Sin', '🐨 Bear', '共用', '部分'];

    // 預先建立 attrMap（偵測既有「部分」：G=共用 且 I 欄有自訂金額）
    const attrMap = {};
    const customAmountMap = {};
    item.invItems.forEach((it, i) => {
      if (it.attribution === '共用' && it.custom !== '') {
        attrMap[i] = '部分';
        customAmountMap[i] = parseFloat(it.custom);
      } else {
        attrMap[i] = _normalizeItemAttribution(it.attribution);
      }
    });

    document.getElementById('pending-modal-body').innerHTML = `
      <p class="list-item-sub" style="margin-bottom:12px">${item.date}　${_fmt(item.amount)}</p>
      <div id="item-attr-list">
        ${item.invItems.map((it, i) => {
          const curAttr = attrMap[i];
          return `
          <div class="pending-item-row" data-i="${i}">
            <div class="pending-item-name">${it.itemName}</div>
            <div class="pending-item-amount">${_fmt(it.itemAmount)}</div>
            <div class="chip-row" style="flex-wrap:wrap;gap:6px;margin-top:6px">
              ${ATTR_OPTS.map(opt => `
                <button class="chip${curAttr === opt ? ' active' : ''}" data-attr="${opt}" data-i="${i}">${opt}</button>
              `).join('')}
            </div>
            <div class="partial-bear-wrap${curAttr === '部分' ? '' : ' hidden'}" id="partial-wrap-${i}">
              <div class="amount-wrap" style="margin-top:6px">
                <span class="amount-prefix">$</span>
                <input type="number" id="partial-input-${i}" class="field-input amount-input partial-bear-input"
                       data-i="${i}" value="${customAmountMap[i] ?? ''}" min="0" step="1" inputmode="decimal"
                       placeholder="Bear 負擔">
              </div>
            </div>
          </div>`;
        }).join('')}
      </div>
      <p id="pending-untagged-error" class="add-error hidden"></p>
    `;

    document.getElementById('pending-modal-footer').innerHTML = `
      <button class="btn-secondary" id="pending-untagged-cancel">取消</button>
      <button class="btn-primary" id="pending-untagged-save">儲存並匯入帳本</button>
    `;

    // 歸屬 chips
    document.querySelectorAll('#item-attr-list .chip[data-attr]').forEach(btn => {
      btn.addEventListener('click', () => {
        const i = parseInt(btn.dataset.i, 10);
        attrMap[i] = btn.dataset.attr;
        document.querySelectorAll(`#item-attr-list .chip[data-i="${i}"]`)
          .forEach(b => b.classList.toggle('active', b.dataset.attr === attrMap[i]));
        const wrapEl = document.getElementById(`partial-wrap-${i}`);
        if (wrapEl) wrapEl.classList.toggle('hidden', attrMap[i] !== '部分');
        if (attrMap[i] !== '部分') delete customAmountMap[i];
      });
    });

    // 部分金額輸入
    document.querySelectorAll('.partial-bear-input').forEach(input => {
      input.addEventListener('input', () => {
        customAmountMap[parseInt(input.dataset.i, 10)] = parseFloat(input.value);
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
      if (item.invItems.some((_, i) => attrMap[i] === '部分' && !(customAmountMap[i] >= 0))) {
        errEl.textContent = '請填入「部分」品項的 Bear 負擔金額';
        errEl.classList.remove('hidden');
        return;
      }
      const btn = document.getElementById('pending-untagged-save');
      btn.disabled = true;
      btn.textContent = '儲存中…';
      try {
        // 1. 更新品項明細歸屬（部分 → G=共用, I=customBearAmount）
        for (let i = 0; i < item.invItems.length; i++) {
          const isPartial = attrMap[i] === '部分';
          await Sheets.updateItemRow(
            item.invItems[i].rowIndex,
            isPartial ? '共用' : attrMap[i],
            isPartial ? (customAmountMap[i] || 0) : ''
          );
        }
        // 2. 寫入月度帳本：保留 G/H 公式，K 欄連回發票明細
        await Sheets.appendMonthlyFromInvoice({
          date: item.date,
          shop: item.shop,
          amount: item.amount,
          shared: '部分',
          category: item.category || item.invItems[0]?.category || '',
          note: item.note || '',
          invNum: item.invNum,
          invRowIndex: item.invRowIndex,
          source: _sourceFromCarrier(item.carrier),
        });
        Sheets.invalidateMonth(item.date.slice(0, 7));
        _saveClose();
        await _reload();
        window.Home?.reload();
        window.Ledger?.reload();
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
        _saveClose();
        await _reload();
        window.Home?.reload();
        window.Ledger?.reload();
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
        _saveClose();
        await _reload();
        window.Home?.reload();
        window.Ledger?.reload();
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
    const cands = item.invCandidates || [];   // 可連結的現有發票（CC 驅動）
    let selectedInv = null;
    const SHARED_OPTS = ['是', '否', '部分', '-', 'x'];
    let selectedShared = cc.shared || '';          // CC 下載時若已自動填，預選供 double check
    let selectedCat    = cc.category || '';        // 類別：下載時 _lookupCategory 可能已自動填
    document.getElementById('pending-modal-title').textContent = `🔵 ${cc.shop}`;

    // 下載時已自動帶入的欄位，提示使用者確認
    const prefillHint = (cc.category || cc.shared)
      ? `<p class="list-item-sub" style="margin:0 0 12px;font-size:11px;opacity:.7">已自動帶入${cc.category ? `類別 ${cc.category}` : ''}${cc.category && cc.shared ? '、' : ''}${cc.shared ? `是否共用 ${cc.shared}` : ''}，請確認</p>`
      : '';

    document.getElementById('pending-modal-body').innerHTML = `
      <p class="list-item-sub" style="margin-bottom:8px">${cc.bank}　${cc.txDate}　${_fmt(cc.amount)}</p>
      ${cands.length ? `
      <div class="chip-row" id="cc-mode-chips" style="margin-bottom:12px">
        <button class="chip active" data-mode="fill">✍️ 自己填</button>
        <button class="chip" data-mode="link">🔗 連結發票 (${cands.length})</button>
      </div>` : ''}
      <div id="cc-fill-pane">
        ${prefillHint}
        <label class="field-label">類別</label>
        <div class="chip-row" id="cc-cat-chips" style="margin-bottom:12px">
          ${CATEGORIES.map(c => `<button class="chip${selectedCat === c ? ' active' : ''}" data-cat="${c}">${c}</button>`).join('')}
        </div>
        <label class="field-label">是否共用</label>
        <div class="chip-row" id="cc-shared-chips" style="margin-bottom:12px">
          ${SHARED_OPTS.map(opt => `<button class="chip${selectedShared === opt ? ' active' : ''}" data-opt="${opt}">${opt}</button>`).join('')}
        </div>
        <div id="cc-note-row">
          <label class="field-label">備注</label>
          <input type="text" id="cc-note" class="field-input" value="${cc.note}" placeholder="選填">
        </div>
        <div id="cc-bear-row" class="hidden">
          <label class="field-label">Bear 負擔金額</label>
          <input type="number" id="cc-bear" class="field-input" inputmode="decimal" placeholder="Bear 負擔多少（總額 ${cc.amount}）">
        </div>
      </div>
      <div id="cc-link-pane" class="hidden">
        <p class="list-item-sub" style="margin:0 0 8px;font-size:12px;opacity:.75">
          這筆刷卡對應下面哪張發票？外送／蝦皮的金額本來就會差運費，照商家與日期認即可。
        </p>
        <div id="cc-inv-list">
          ${cands.map((inv, i) => `
            <div class="list-item cc-inv-item" data-i="${i}" style="cursor:pointer;border-radius:8px;margin-bottom:4px">
              <div class="list-item-body">
                <div class="list-item-title">${inv.shop || inv.invNum}${
                  inv.shared ? ` <span class="tag-shared">${inv.shared}</span>` : ''}</div>
                <div class="list-item-sub">${inv.date}　${inv.invNum}　${_carrierLabel(inv.carrier)}</div>
              </div>
              <div class="list-item-right amount-expense">${_fmt(inv.amount)}</div>
            </div>`).join('')}
        </div>
        <p style="color:#8E8E93;font-size:13px;margin-top:8px">
          連結後這筆刷卡標為「x 跳過」並記下發票號碼，月度帳本不會多一列。
        </p>
      </div>
      <p id="cc-error" class="add-error hidden"></p>
    `;
    document.getElementById('pending-modal-footer').innerHTML = `
      <button class="btn-secondary" id="cc-cancel">取消</button>
      <button class="btn-primary" id="cc-save">儲存</button>
      <button class="btn-primary hidden" id="cc-link-confirm" disabled>確認連結</button>
    `;

    NoteChips.render('cc-note');

    // 模式切換：✍️ 自己填 ↔ 🔗 連結發票（無候選時整組不渲染）
    document.querySelectorAll('#cc-mode-chips .chip').forEach(btn => {
      btn.addEventListener('click', () => {
        const isLink = btn.dataset.mode === 'link';
        document.querySelectorAll('#cc-mode-chips .chip')
          .forEach(b => b.classList.toggle('active', b === btn));
        document.getElementById('cc-fill-pane').classList.toggle('hidden', isLink);
        document.getElementById('cc-link-pane').classList.toggle('hidden', !isLink);
        document.getElementById('cc-save').classList.toggle('hidden', isLink);
        document.getElementById('cc-link-confirm').classList.toggle('hidden', !isLink);
        document.getElementById('cc-error').classList.add('hidden');
      });
    });

    document.querySelectorAll('.cc-inv-item').forEach(row => {
      row.addEventListener('click', () => {
        document.querySelectorAll('.cc-inv-item').forEach(r => r.classList.remove('active'));
        row.classList.add('active');
        selectedInv = cands[parseInt(row.dataset.i)];
        document.getElementById('cc-link-confirm').disabled = false;
      });
    });

    document.getElementById('cc-link-confirm').addEventListener('click', async () => {
      const errEl = document.getElementById('cc-error');
      if (!selectedInv) {
        errEl.textContent = '請先選擇對應的發票';
        errEl.classList.remove('hidden');
        return;
      }
      const btn = document.getElementById('cc-link-confirm');
      btn.disabled = true;
      btn.textContent = '連結中…';
      try {
        await Sheets.linkCCToInvoice(cc.rowIndex, selectedInv.invNum, selectedInv.rowIndex);
        _saveClose();
        await _reload();
      } catch (e) {
        errEl.textContent = '連結失敗：' + e.message;
        errEl.classList.remove('hidden');
        btn.disabled = false;
        btn.textContent = '確認連結';
      }
    });

    document.querySelectorAll('#cc-cat-chips .chip').forEach(btn => {
      btn.addEventListener('click', () => {
        selectedCat = selectedCat === btn.dataset.cat ? '' : btn.dataset.cat;  // 再按一次取消
        document.querySelectorAll('#cc-cat-chips .chip')
          .forEach(b => b.classList.toggle('active', b.dataset.cat === selectedCat));
      });
    });

    const _updatePartialUI = () => {
      const isPartial = selectedShared === '部分';
      document.getElementById('cc-bear-row').classList.toggle('hidden', !isPartial);
      document.getElementById('cc-note-row').classList.toggle('hidden', isPartial);
    };
    _updatePartialUI();

    document.querySelectorAll('#cc-shared-chips .chip').forEach(btn => {
      btn.addEventListener('click', () => {
        selectedShared = btn.dataset.opt;
        document.querySelectorAll('#cc-shared-chips .chip')
          .forEach(b => b.classList.toggle('active', b.dataset.opt === selectedShared));
        _updatePartialUI();
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
      let note;
      if (selectedShared === '部分') {
        const bearAmt = parseFloat(document.getElementById('cc-bear').value);
        if (isNaN(bearAmt) || bearAmt < 0 || bearAmt > cc.amount) {
          errEl.textContent = `請輸入 Bear 負擔金額（0 ~ ${cc.amount}）`;
          errEl.classList.remove('hidden');
          return;
        }
        note = String(Math.round(bearAmt));   // 寫入備註(J欄)，importToMonthly 讀此值算 Bear 負擔
      } else {
        note = document.getElementById('cc-note').value;
      }
      const btn = document.getElementById('cc-save');
      btn.disabled = true;
      btn.textContent = '儲存中…';
      try {
        await Sheets.updateCCFields(cc.rowIndex, { category: selectedCat, shared: selectedShared, note });
        _saveClose();
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
    let selectedShared = inv.shared || '';
    let selectedCat = inv.category || '';
    const needCat = !inv.category;
    document.getElementById('pending-modal-title').textContent = `🟣 ${inv.shop}`;

    function _showStep1() {
      const itemsHtml = item.invItems.length ? `
        <div style="margin:0 0 12px;border:1px solid var(--divider);border-radius:6px;overflow:hidden;font-size:12px">
          ${item.invItems.map(it => `
            <div style="display:flex;justify-content:space-between;padding:4px 10px;border-bottom:1px solid var(--divider)">
              <span style="color:var(--text-main)">${it.itemName}</span>
              <span style="color:var(--text-sub);white-space:nowrap;margin-left:8px">${_fmt(parseFloat(it.itemAmount)||0)}</span>
            </div>`).join('')}
        </div>` : '';
      const catHtml = `
        <label class="field-label">類別</label>
        <div class="chip-row" id="inv-cat-chips" style="margin-bottom:12px">
          ${CATEGORIES.map(c => `<button class="chip${selectedCat === c ? ' active' : ''}" data-cat="${c}">${c}</button>`).join('')}
        </div>`;
      document.getElementById('pending-modal-body').innerHTML = `
        <p class="list-item-sub" style="margin-bottom:4px">${inv.date}　${_fmt(inv.amount)}</p>
        <p class="list-item-sub" style="margin-bottom:10px;font-size:11px;opacity:.7">${inv.carrier}　${inv.invNum}</p>
        ${itemsHtml}
        ${catHtml}
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

      document.querySelectorAll('#inv-cat-chips .chip').forEach(btn => {
        btn.addEventListener('click', () => {
          selectedCat = btn.dataset.cat;
          document.querySelectorAll('#inv-cat-chips .chip')
            .forEach(b => b.classList.toggle('active', b.dataset.cat === selectedCat));
        });
      });

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
        if (needCat && !selectedCat) {
          errEl.textContent = '請選擇類別';
          errEl.classList.remove('hidden');
          return;
        }
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
          await Sheets.updateInvoiceFields(inv.rowIndex, { category: selectedCat, shared: selectedShared });
          _saveClose();
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
      const ATTR_OPTS = ['🌟 Sin', '🐨 Bear', '共用', '部分'];

      // 預先建立 attrMap（偵測既有「部分」：G=共用 且 I 欄有自訂金額）
      const attrMap = {};
      const customAmountMap = {};
      item.invItems.forEach((it, i) => {
        if (it.attribution === '共用' && it.custom !== '') {
          attrMap[i] = '部分';
          customAmountMap[i] = parseFloat(it.custom);
        } else {
          attrMap[i] = _normalizeItemAttribution(it.attribution);
        }
      });

      document.getElementById('pending-modal-body').innerHTML = `
        <p class="list-item-sub" style="margin-bottom:12px">${inv.date}　${_fmt(inv.amount)}</p>
        <div id="item-attr-list">
          ${item.invItems.map((it, i) => {
            const curAttr = attrMap[i];
            return `
            <div class="pending-item-row" data-i="${i}">
              <div class="pending-item-name">${it.itemName}</div>
              <div class="pending-item-amount">${_fmt(it.itemAmount)}</div>
              <div class="chip-row" style="flex-wrap:wrap;gap:6px;margin-top:6px">
                ${ATTR_OPTS.map(opt => `
                  <button class="chip${curAttr === opt ? ' active' : ''}" data-attr="${opt}" data-i="${i}">${opt}</button>
                `).join('')}
              </div>
              <div class="partial-bear-wrap${curAttr === '部分' ? '' : ' hidden'}" id="partial-wrap-${i}">
                <div class="amount-wrap" style="margin-top:6px">
                  <span class="amount-prefix">$</span>
                  <input type="number" id="partial-input-${i}" class="field-input amount-input partial-bear-input"
                         data-i="${i}" value="${customAmountMap[i] ?? ''}" min="0" step="1" inputmode="decimal"
                         placeholder="Bear 負擔">
                </div>
              </div>
            </div>`;
          }).join('')}
        </div>
        <p id="inv-attr-error" class="add-error hidden"></p>
      `;
      document.getElementById('pending-modal-footer').innerHTML = `
        <button class="btn-secondary" id="inv-back">← 上一步</button>
        <button class="btn-primary" id="inv-attr-save">儲存並匯入帳本</button>
      `;

      document.querySelectorAll('#item-attr-list .chip[data-attr]').forEach(btn => {
        btn.addEventListener('click', () => {
          const i = parseInt(btn.dataset.i, 10);
          attrMap[i] = btn.dataset.attr;
          document.querySelectorAll(`#item-attr-list .chip[data-i="${i}"]`)
            .forEach(b => b.classList.toggle('active', b.dataset.attr === attrMap[i]));
          const wrapEl = document.getElementById(`partial-wrap-${i}`);
          if (wrapEl) wrapEl.classList.toggle('hidden', attrMap[i] !== '部分');
          if (attrMap[i] !== '部分') delete customAmountMap[i];
        });
      });

      document.querySelectorAll('.partial-bear-input').forEach(input => {
        input.addEventListener('input', () => {
          customAmountMap[parseInt(input.dataset.i, 10)] = parseFloat(input.value);
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
        if (item.invItems.some((_, i) => attrMap[i] === '部分' && !(customAmountMap[i] >= 0))) {
          errEl.textContent = '請填入「部分」品項的 Bear 負擔金額';
          errEl.classList.remove('hidden');
          return;
        }
        const btn = document.getElementById('inv-attr-save');
        btn.disabled = true;
        btn.textContent = '儲存中…';
        try {
          for (let i = 0; i < item.invItems.length; i++) {
            const isPartial = attrMap[i] === '部分';
            await Sheets.updateItemRow(
              item.invItems[i].rowIndex,
              isPartial ? '共用' : attrMap[i],
              isPartial ? (customAmountMap[i] || 0) : ''
            );
          }
          const _finalCat = selectedCat || item.invItems[0]?.category || inv.category || '';
          await Sheets.updateInvoiceFields(inv.rowIndex, { ...(_finalCat ? { category: _finalCat } : {}), shared: '部分' });
          await Sheets.appendMonthlyFromInvoice({
            date: inv.date,
            shop: inv.shop,
            amount: inv.amount,
            shared: '部分',
            category: _finalCat,
            note: inv.note || '',
            invNum: inv.invNum,
            invRowIndex: inv.rowIndex,
            source: _sourceFromCarrier(inv.carrier),
          });
          Sheets.invalidateMonth(inv.date.slice(0, 7));
          _saveClose();
          await _reload();
          window.Home?.reload();
          window.Ledger?.reload();
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

  function _renderPlatformUnlinked(item) {
    const { inv, invItems, platformKey, candidates } = item;
    document.getElementById('pending-modal-title').textContent = `📦 ${inv.shop || inv.invNum}`;

    let selectedCC = null;
    let selectedPayer = _defaultPayer();

    const payerHtml = `
      <div class="section-title" style="margin-top:12px">負責人</div>
      <div class="chip-row" id="platform-payer-chips" style="margin-bottom:4px">
        <button class="chip${selectedPayer === '🌟 Star' ? ' active' : ''}" data-payer="🌟 Star">🌟 Sin</button>
        <button class="chip${selectedPayer === '🐨 Bear' ? ' active' : ''}" data-payer="🐨 Bear">🐨 Bear</button>
      </div>`;

    const itemsHtml = invItems.length && inv.shared === '部分'
      ? `<div class="section-title" style="margin-top:12px">品項歸屬</div>
         <div class="sconf-items">
           ${invItems.map(it => `
             <div class="sconf-item-row">
               <span class="sconf-item-name">${it.itemName}</span>
               <span style="color:#8E8E93;font-size:12px;margin:0 6px">${it.attribution || '—'}</span>
               <span class="sconf-item-amount">$${it.itemAmount.toLocaleString('zh-TW')}</span>
             </div>`).join('')}
         </div>`
      : `<p style="color:#8E8E93;font-size:14px;margin:8px 0">
           ${inv.shared === '是' ? 'Sin & Bear 各半' :
             inv.shared === '否' ? 'Sin 代墊，Bear 全欠' : `個人（${inv.shared}）`}
         </p>`;

    const ccHtml = candidates.length
      ? `<div class="section-title" style="margin-top:12px">選擇對應 CC 明細</div>
         <div id="platform-cc-list">
           ${candidates.map((cc, i) => `
             <div class="list-item platform-cc-item" data-i="${i}" style="cursor:pointer;border-radius:8px;margin-bottom:4px">
               <div class="list-item-body">
                 <div class="list-item-title">${cc.shop}</div>
                 <div class="list-item-sub">${cc.bank}　${cc.txDate}</div>
               </div>
               <div class="list-item-right amount-expense">${_fmt(cc.amount)}</div>
             </div>`).join('')}
         </div>`
      : `<p style="color:#FF6B6B;font-size:14px;margin:12px 0">
           ⚠ 找不到對應的 [${platformKey}] CC 明細。<br>
           CC 帳單可能尚未到達，請月初執行 run_monthly.py 後再回來查看。
         </p>`;

    document.getElementById('pending-modal-body').innerHTML = `
      <p class="list-item-sub" style="margin-bottom:4px">
        ${inv.date}　[${platformKey}]　發票 ${_fmt(inv.amount)}
      </p>
      ${itemsHtml}
      ${payerHtml}
      ${ccHtml}
      <p id="platform-error" class="add-error hidden"></p>
    `;

    document.getElementById('pending-modal-footer').innerHTML = `
      <button class="btn-secondary" id="platform-cancel">取消</button>
      <button class="btn-primary" id="platform-confirm"${candidates.length ? '' : ' disabled'}>確認配對</button>
    `;

    document.querySelectorAll('#platform-payer-chips .chip').forEach(btn => {
      btn.addEventListener('click', () => {
        selectedPayer = btn.dataset.payer;
        document.querySelectorAll('#platform-payer-chips .chip')
          .forEach(b => b.classList.toggle('active', b.dataset.payer === selectedPayer));
      });
    });

    document.querySelectorAll('.platform-cc-item').forEach(row => {
      row.addEventListener('click', () => {
        document.querySelectorAll('.platform-cc-item').forEach(r => r.classList.remove('active'));
        row.classList.add('active');
        selectedCC = candidates[parseInt(row.dataset.i)];
      });
    });

    document.getElementById('platform-cancel').addEventListener('click', _closeDetail);
    document.getElementById('platform-confirm').addEventListener('click', async () => {
      const errEl = document.getElementById('platform-error');
      if (!selectedCC) {
        errEl.textContent = '請先選擇對應的 CC 明細';
        errEl.classList.remove('hidden');
        return;
      }
      const btn = document.getElementById('platform-confirm');
      btn.disabled    = true;
      btn.textContent = '處理中…';
      try {
        await Sheets.linkPlatformToCC({ inv, cc: selectedCC, payer: selectedPayer });
        Sheets.invalidateMonth(inv.date.slice(0, 7));
        _saveClose();
        await _reload();
        window.Home?.reload();
        window.Ledger?.reload();
      } catch (e) {
        errEl.textContent = '儲存失敗：' + e.message;
        errEl.classList.remove('hidden');
        btn.disabled    = false;
        btn.textContent = '確認配對';
      }
    });
  }

  // ── 🔗 掃描/CC配對：確認配對或標記非重複 ─────────────────────

  function _renderScanCCDup(item) {
    const { inv, candidates } = item;
    const carrierLabel = _carrierLabel(inv.carrier);
    document.getElementById('pending-modal-title').textContent = `🔗 ${inv.shop || inv.invNum}`;

    let selectedCC = null;

    const ccHtml = `
      <div class="section-title" style="margin-top:12px">選擇對應 CC 明細</div>
      <div id="scd-cc-list">
        ${candidates.map((cc, i) => `
          <div class="list-item scd-cc-item" data-i="${i}" style="cursor:pointer;border-radius:8px;margin-bottom:4px">
            <div class="list-item-body">
              <div class="list-item-title">${cc.shop}</div>
              <div class="list-item-sub">${cc.bank}　${cc.txDate}</div>
            </div>
            <div class="list-item-right amount-expense">${_fmt(cc.amount)}</div>
          </div>`).join('')}
      </div>`;

    document.getElementById('pending-modal-body').innerHTML = `
      <p class="list-item-sub" style="margin-bottom:4px">
        ${carrierLabel}已記入月度帳本　${inv.date}　發票 ${_fmt(inv.amount)}　備註：${inv.note}
      </p>
      ${ccHtml}
      <p style="color:#8E8E93;font-size:13px;margin-top:8px">
        選擇後該信用卡交易將標為「x 跳過」並連結此發票，不會被重複匯入月度帳本。<br>
        若都不對應，按「無對應」略過。
      </p>
      <p id="scd-error" class="add-error hidden"></p>
    `;

    document.getElementById('pending-modal-footer').innerHTML = `
      <button class="btn-secondary" id="scd-none">無對應</button>
      <button class="btn-primary" id="scd-confirm" disabled>確認配對</button>
    `;

    document.querySelectorAll('.scd-cc-item').forEach(row => {
      row.addEventListener('click', () => {
        document.querySelectorAll('.scd-cc-item').forEach(r => r.classList.remove('active'));
        row.classList.add('active');
        selectedCC = candidates[parseInt(row.dataset.i)];
        document.getElementById('scd-confirm').disabled = false;
      });
    });

    document.getElementById('scd-none').addEventListener('click', _closeDetail);
    document.getElementById('scd-confirm').addEventListener('click', async () => {
      const errEl = document.getElementById('scd-error');
      if (!selectedCC) {
        errEl.textContent = '請先選擇對應的 CC 明細';
        errEl.classList.remove('hidden');
        return;
      }
      const btn = document.getElementById('scd-confirm');
      btn.disabled = true;
      btn.textContent = '儲存中…';
      try {
        await Sheets.linkCCToInvoice(selectedCC.rowIndex, inv.invNum, inv.rowIndex);
        _saveClose();
        await _reload();
      } catch (e) {
        errEl.textContent = '儲存失敗：' + e.message;
        errEl.classList.remove('hidden');
        btn.disabled = false;
        btn.textContent = '確認配對';
      }
    });
  }

  // ── 載入 ─────────────────────────────────────────────────────

  async function _reload() {
    const savedAdvanceIdx = _advanceIdx;
    _advanceIdx = -1;
    const el = document.getElementById('pending-list');
    if (el) el.innerHTML = '<div class="spinner"></div>';
    const sEl = document.getElementById('pending-summary');
    if (sEl) sEl.textContent = '';
    try {
      await _collect();
      _renderList();
      if (savedAdvanceIdx >= 0) {
        const next = _visibleItems();
        if (next.length > 0) _openDetail(next[Math.min(savedAdvanceIdx, next.length - 1)]);
      }
    } catch (e) {
      if (e.message !== 'auth_expired' && el) {
        el.innerHTML = `<div class="empty-state"><span>⚠️</span><p>${e.message}</p></div>`;
      }
    }
  }

  function _buildShell() {
    document.getElementById('tab-pending').innerHTML = `
      <div class="home-nav" style="margin-bottom:8px">
        <span style="flex:1;font-size:16px;font-weight:600">待處理</span>
        <button class="month-btn refresh-btn" id="pending-refresh" title="重新載入">↺</button>
      </div>
      <div class="home-nav" id="pending-month-nav" style="margin-bottom:6px">
        <button class="month-btn" id="pending-prev-m">◀</button>
        <span id="pending-month-lbl" style="flex:1;text-align:center;font-weight:600"></span>
        <button class="month-btn" id="pending-next-m">▶</button>
      </div>
      <div id="pending-summary" class="ledger-count" style="display:block;margin-bottom:8px"></div>
      <div class="card" id="pending-list"></div>
    `;
    document.getElementById('pending-refresh').addEventListener('click', _reload);
    document.getElementById('pending-prev-m').addEventListener('click', () => _shiftMonth(-1));
    document.getElementById('pending-next-m').addEventListener('click', () => _shiftMonth(1));
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
