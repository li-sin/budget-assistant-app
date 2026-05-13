const Sheets = (() => {
  const BASE = `https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.SHEET_ID}`;

  function _authHeader() {
    return { Authorization: `Bearer ${Auth.getToken()}` };
  }

  async function _get(range) {
    const url = `${BASE}/values/${encodeURIComponent(range)}`;
    const res = await fetch(url, { headers: _authHeader() });
    if (res.status === 401) { Auth.logout(); throw new Error('auth_expired'); }
    if (!res.ok) throw new Error(`Sheets API ${res.status}`);
    return res.json();
  }

  async function _append(range, values) {
    const url = `${BASE}/values/${encodeURIComponent(range)}:append`
      + '?valueInputOption=USER_ENTERED&insertDataOption=OVERWRITE';
    const res = await fetch(url, {
      method: 'POST',
      headers: { ..._authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ values }),
    });
    if (res.status === 401) { Auth.logout(); throw new Error('auth_expired'); }
    if (!res.ok) throw new Error(`Sheets API ${res.status}`);
    return res.json();
  }

  async function _update(range, values) {
    const url = `${BASE}/values/${encodeURIComponent(range)}`
      + '?valueInputOption=USER_ENTERED';
    const res = await fetch(url, {
      method: 'PUT',
      headers: { ..._authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ range, values }),
    });
    if (res.status === 401) { Auth.logout(); throw new Error('auth_expired'); }
    if (!res.ok) throw new Error(`Sheets API ${res.status}`);
    return res.json();
  }

  async function _batchUpdate(dataArr) {
    // dataArr: [{ range, values }, ...]，一次寫多個不連續範圍
    const url = `${BASE}/values:batchUpdate`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { ..._authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data: dataArr }),
    });
    if (res.status === 401) { Auth.logout(); throw new Error('auth_expired'); }
    if (!res.ok) throw new Error(`Sheets API ${res.status}`);
    return res.json();
  }

  // ── 月度帳本 ──────────────────────────────────────────────────

  function _parseRow(r, rowIndex) {
    return {
      rowIndex,
      date:       r[0]  || '',
      item:       r[1]  || '',
      amount:     parseFloat(r[2])  || 0,
      payer:      r[3]  || '',
      shared:     r[4]  || '',
      category:   r[5]  || '',
      sinShare:   parseFloat(r[6])  || 0,
      bearShare:  parseFloat(r[7])  || 0,
      note:       r[8]  || '',
      source:     r[9]  || '',
      sourceLink: r[10] || '',
      importedAt: r[11] || '',
    };
  }

  const CACHE_TTL = 5 * 60 * 1000;  // 5 分鐘

  async function getMonthlyData(year, month) {
    const ym  = `${year}-${String(month).padStart(2, '0')}`;
    const key = `ba_monthly_${ym}`;
    const hit = sessionStorage.getItem(key);
    if (hit) {
      const { ts, data } = JSON.parse(hit);
      if (Date.now() - ts < CACHE_TTL) return data;
    }

    const data = await _get(`${CONFIG.TABS.MONTHLY}!A:L`);
    const rows = (data.values || []).slice(1);  // skip header
    const filtered = rows
      .map((r, i) => _parseRow(r, i + 2))  // rowIndex: header=1, data starts at 2
      .filter(r => r.date.startsWith(ym));

    sessionStorage.setItem(key, JSON.stringify({ ts: Date.now(), data: filtered }));
    return filtered;
  }

  // ── 信用卡明細 ───────────────────────────────────────────────

  function _normalizeDate(v) {
    return String(v || '').replace(/^'/, '').trim();
  }

  async function getCreditCardImportStatus(year, month) {
    const ym = `${year}-${String(month).padStart(2, '0')}`;
    const banks = ['台新', '星展', '永豐'];
    const counts = Object.fromEntries(banks.map(b => [b, 0]));
    const data = await _get(`${CONFIG.TABS.CC}!A:L`);
    (data.values || []).slice(1).forEach(r => {
      const bank = r[0] || '';
      const billMonth = _normalizeDate(r[11]);
      if (bank in counts && billMonth === ym) counts[bank]++;
    });
    return banks.map(bank => ({ bank, count: counts[bank] }));
  }

  function invalidateMonth(ym) {
    sessionStorage.removeItem(`ba_monthly_${ym}`);
  }

  // ── Bear結算 ──────────────────────────────────────────────────

  async function getSettlement() {
    const data = await _get(`${CONFIG.TABS.SETTLEMENT}!${CONFIG.SETTLEMENT_CELL}`);
    return parseFloat(data.values?.[0]?.[0] ?? '0') || 0;
  }

  // ── 新增月度帳本列 ────────────────────────────────────────────
  // row: 長度 12 的陣列，對應 A~L 欄
  // [date, item, amount, payer, shared, category, sinShare, bearShare, note, source, sourceLink, importedAt]

  async function appendMonthlyRow(row) {
    // 讀 A 欄找最後一筆有值的列，避免 ARRAYFORMULA 延伸造成 append 位置錯誤
    const data = await _get(`${CONFIG.TABS.MONTHLY}!A:A`);
    const lastRow = (data.values || []).length;  // 含 header，下一列 = lastRow + 1
    const range = `${CONFIG.TABS.MONTHLY}!A${lastRow + 1}`;
    await _update(range, [row]);
    const ym = (row[0] || '').slice(0, 7);
    if (ym) invalidateMonth(ym);
  }

  // ── 修改月度帳本指定列 ────────────────────────────
  async function updateMonthlyRow(rowIndex, row) {
    const range = `${CONFIG.TABS.MONTHLY}!A${rowIndex}:L${rowIndex}`;
    await _update(range, [row]);
    const ym = (row[0] || '').slice(0, 7);
    if (ym) invalidateMonth(ym);
  }

  // ── 刪除月度帳本指定列 ────────────────────────────
  async function deleteMonthlyRow(rowIndex, ym) {
    const url = `${BASE}:batchUpdate`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { ..._authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: [{
          deleteDimension: {
            range: {
              sheetId: CONFIG.MONTHLY_SHEET_ID,
              dimension: 'ROWS',
              startIndex: rowIndex - 1,  // 0-based
              endIndex: rowIndex,
            },
          },
        }],
      }),
    });
    if (res.status === 401) { Auth.logout(); throw new Error('auth_expired'); }
    if (!res.ok) throw new Error(`Sheets API ${res.status}`);
    if (ym) invalidateMonth(ym);
    return res.json();
  }

  // ── 發票明細 ──────────────────────────────────────
  function _parseInvoiceRow(r, rowIndex) {
    return {
      rowIndex,
      carrier:   r[0]  || '',
      date:      r[1]  || '',
      invNum:    r[2]  || '',
      shop:      r[3]  || '',
      amount:    parseFloat(r[4]) || 0,
      status:    r[5]  || '',
      category:  r[6]  || '',
      shared:    r[7]  || '',
      note:      r[8]  || '',
      imported:  r[9]  || '',
      bearShare: r[10] || '',
    };
  }

  async function getInvoiceData() {
    const data = await _get(`${CONFIG.TABS.INVOICE}!A:K`);
    return (data.values || []).slice(1).map((r, i) => _parseInvoiceRow(r, i + 2));
  }

  // ── 品項明細 ──────────────────────────────────────
  function _parseItemRow(r, rowIndex) {
    return {
      rowIndex,
      carrier:     r[0]  || '',
      date:        r[1]  || '',
      invNum:      r[2]  || '',
      shop:        r[3]  || '',
      itemName:    r[4]  || '',
      itemAmount:  parseFloat(r[5]) || 0,
      attribution: r[6]  || '',
      bearShare:   r[7]  || '',
      custom:      r[8]  || '',
      note:        r[9]  || '',
      invStatus:   r[10] || '',
    };
  }

  async function getItemData() {
    const data = await _get(`${CONFIG.TABS.ITEMS}!A:K`);
    return (data.values || []).slice(1).map((r, i) => _parseItemRow(r, i + 2));
  }

  async function updateItemRow(rowIndex, attribution) {
    const range = `${CONFIG.TABS.ITEMS}!G${rowIndex}`;
    await _update(range, [[attribution]]);
  }

  // ── 新增發票明細列（掃描發票用）──────────────────────
  // A=載具 B=日期(YYYY-MM-DD) C=發票號碼(HYPERLINK→品項明細G欄) D=商店
  // E=金額 F=狀態 G=類別 H=是否共用 I=備註 J=已匯入
  async function appendInvoiceRow(carrier, date, invNum, shop, amount, status, category, shared, note) {
    const data      = await _get(`${CONFIG.TABS.INVOICE}!A:A`);
    const lastRow   = (data.values || []).length;
    const newRow    = lastRow + 1;
    const itemsGid  = CONFIG.ITEMS_SHEET_ID;
    const invLink   = `=HYPERLINK("#gid=${itemsGid}","${invNum}")`;
    const row = [carrier, date, invLink, shop, amount, status, category, shared, note, false];
    await _update(`${CONFIG.TABS.INVOICE}!A${newRow}`, [row]);
    return newRow;
  }

  // ── 新增品項明細列（掃描發票用）──────────────────────
  // A=載具 B=日期(YYYY-MM-DD) C=發票號碼(HYPERLINK→發票明細H欄) D=商店
  // E=品項名稱 F=品項金額 G=歸屬(空=未處理) H=Bear負擔(公式) I=自訂 J=備註
  async function appendItemRows(invoiceInfo, items) {
    const { carrier, date, invNum, shop } = invoiceInfo;
    const data    = await _get(`${CONFIG.TABS.ITEMS}!A:A`);
    const lastRow = (data.values || []).length;
    const invGid  = CONFIG.INVOICE_SHEET_ID;
    const rows    = items.map(({ name, amount }, idx) => {
      const r       = lastRow + 1 + idx;
      const invLink = `=HYPERLINK("#gid=${invGid}","${invNum}")`;
      const bearFormula = `=IF(I${r}<>"",I${r},IF(G${r}="🌟 Sin",0,IF(G${r}="🐨 Bear",F${r},IF(G${r}="共用",ROUNDDOWN(F${r}/2,0),0))))`;
      return [carrier, date, invLink, shop, name, amount, '', bearFormula, '', ''];
    });
    await _update(`${CONFIG.TABS.ITEMS}!A${lastRow + 1}:J${lastRow + rows.length}`, rows);
    return lastRow + 1;  // 第一筆品項的列號
  }

  // ── 勾選發票明細已匯入（J欄 = TRUE）────────────────────
  async function markInvoiceImported(rowIndex) {
    await _update(`${CONFIG.TABS.INVOICE}!J${rowIndex}`, [[true]]);
  }

  // ── 掃描發票直接匯入月度帳本 ────────────────────────────
  // shared: 是/否/-/x；sinShare/bearShare 由呼叫端計算
  async function appendMonthlyFromScan({ date, shop, amount, shared, category, note, invNum, invRowIndex }) {
    const now        = new Date();
    const importedAt = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
    const invGid     = CONFIG.INVOICE_SHEET_ID;
    const sourceLink = `=HYPERLINK("#gid=${invGid}&range=C${invRowIndex}","${invNum}")`;

    // 讀 A 欄定位最後列
    const data   = await _get(`${CONFIG.TABS.MONTHLY}!A:A`);
    const lastRow = (data.values || []).length;
    const nextRow = lastRow + 1;
    const tab     = CONFIG.TABS.MONTHLY;

    // G/H 欄不寫，保留公式自動計算；分兩段：A~F 和 I~L
    await _batchUpdate([
      { range: `${tab}!A${nextRow}:F${nextRow}`, values: [[date, shop, amount, '🌟 Star', shared, category]] },
      { range: `${tab}!I${nextRow}:L${nextRow}`, values: [[note, '掃描發票', sourceLink, importedAt]] },
    ]);

    const ym = (date || '').slice(0, 7);
    if (ym) invalidateMonth(ym);
    await markInvoiceImported(invRowIndex);
  }

  // ── 還款記錄（Bear結算 tab G~I 欄）────────────────────────
  // G=月份(YYYY-MM), H=已還金額（累計，同月累加）, I=最後還款日(YYYY-MM-DD)
  async function upsertRepayment(ym, amount) {
    const tab   = CONFIG.TABS.SETTLEMENT;
    const today = new Date();
    const dateStr = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
    const data  = await _get(`${tab}!G7:I`);
    const rows  = data.values || [];
    const idx   = rows.findIndex(r => r[0] === ym);
    if (idx >= 0) {
      const rowNum  = 7 + idx;
      const current = parseFloat(rows[idx][1]) || 0;
      await _update(`${tab}!G${rowNum}:I${rowNum}`, [[ym, current + amount, dateStr]]);
    } else {
      const lastRow = Math.max(rows.length + 6, 6);  // data 從第 7 列起
      await _update(`${tab}!G${lastRow + 1}:I${lastRow + 1}`, [[ym, amount, dateStr]]);
    }
  }

  // ── Bear結算還款記錄（G7:I 起，每月一行）───────────────────────
  async function getRepayments() {
    const data = await _get(`${CONFIG.TABS.SETTLEMENT}!G7:I`);
    return (data.values || [])
      .filter(r => r[0] && r[1])
      .map(r => ({
        ym:       r[0] || '',   // YYYY-MM
        amount:   parseFloat(r[1]) || 0,
        lastDate: r[2] || '',   // YYYY-MM-DD（最後一次還款日）
      }));
  }

  // ── 信用卡待填 ──────────────────────────────────────────────
  function _parseCCRow(r, rowIndex) {
    return {
      rowIndex,
      bank:     r[0] || '',
      txDate:   r[1] || '',
      shop:     r[3] || '',
      amount:   parseFloat(r[4]) || 0,
      shared:   r[7] || '',
      note:     r[9] || '',
      imported: r[10] || '',
    };
  }

  async function getCCPendingData() {
    const data = await _get(`${CONFIG.TABS.CC}!A:L`);
    return (data.values || []).slice(1)
      .map((r, i) => _parseCCRow(r, i + 2))
      .filter(r => r.shared === '' && r.imported !== 'TRUE');
  }

  async function updateCCShared(rowIndex, shared, note) {
    await _batchUpdate([
      { range: `${CONFIG.TABS.CC}!H${rowIndex}`, values: [[shared]] },
      { range: `${CONFIG.TABS.CC}!J${rowIndex}`, values: [[note]] },
    ]);
  }

  async function updateInvoiceShared(rowIndex, shared) {
    await _update(`${CONFIG.TABS.INVOICE}!H${rowIndex}`, [[shared]]);
  }

  return {
    getMonthlyData, getCreditCardImportStatus, getSettlement, getRepayments, appendMonthlyRow, invalidateMonth,
    updateMonthlyRow, deleteMonthlyRow,
    getInvoiceData, getItemData, updateItemRow,
    appendInvoiceRow, appendItemRows,
    markInvoiceImported, appendMonthlyFromScan,
    upsertRepayment,
    getCCPendingData, updateCCShared, updateInvoiceShared,
  };
})();
