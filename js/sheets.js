const Sheets = (() => {
  const BASE = `https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.SHEET_ID}`;

  function _authHeader() {
    return { Authorization: `Bearer ${Auth.getToken()}` };
  }

  const _isDev = location.hostname === '127.0.0.1' || location.hostname === 'localhost';

  async function _apiError(res, label) {
    if (res.status === 401) { if (!_isDev) Auth.logout(); throw new Error('auth_expired'); }
    if (!res.ok) {
      let detail = '';
      try { detail = ': ' + ((await res.json()).error?.message || ''); } catch {}
      throw new Error(`Sheets API ${res.status}${detail}`);
    }
  }

  async function _get(range) {
    const url = `${BASE}/values/${encodeURIComponent(range)}`;
    const res = await fetch(url, { headers: _authHeader() });
    await _apiError(res);
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
    await _apiError(res);
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
    await _apiError(res);
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
    await _apiError(res);
    return res.json();
  }

  // ── Sheet 行數自動擴充 ────────────────────────────────────────
  // tabName → numeric sheet gid（供 insertDimension 用）
  const _tabGids = {
    [CONFIG.TABS.INVOICE]: CONFIG.INVOICE_SHEET_ID,
    [CONFIG.TABS.ITEMS]:   CONFIG.ITEMS_SHEET_ID,
    [CONFIG.TABS.MONTHLY]: CONFIG.MONTHLY_SHEET_ID,
  };
  const _rowCapCache = {};  // { tabName: { maxRow, ts } }

  async function _ensureRowCapacity(tabName, neededRow) {
    const gid = _tabGids[tabName];
    if (!gid) return;
    const CACHE_MS = 2 * 60 * 1000;
    const cached = _rowCapCache[tabName];
    let maxRow = cached && (Date.now() - cached.ts < CACHE_MS) ? cached.maxRow : 0;

    if (!maxRow) {
      // 查詢目前 sheet 行數上限
      const metaUrl = `https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.SHEET_ID}`
        + '?fields=sheets(properties(sheetId,gridProperties(rowCount)))';
      const r = await fetch(metaUrl, { headers: _authHeader() });
      if (!r.ok) return;
      const meta = await r.json();
      const sp = (meta.sheets || []).find(s => s.properties.sheetId === gid);
      maxRow = sp?.properties?.gridProperties?.rowCount ?? 0;
      _rowCapCache[tabName] = { maxRow, ts: Date.now() };
    }

    if (neededRow <= maxRow) return;

    // 不夠用 → insertDimension 補 1000 行
    const addRows = neededRow - maxRow + 1000;
    const extUrl = `https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.SHEET_ID}:batchUpdate`;
    const r2 = await fetch(extUrl, {
      method: 'POST',
      headers: { ..._authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: [{
          insertDimension: {
            range: { sheetId: gid, dimension: 'ROWS', startIndex: maxRow, endIndex: maxRow + addRows },
            inheritFromBefore: true,
          },
        }],
      }),
    });
    if (r2.ok) {
      _rowCapCache[tabName] = { maxRow: maxRow + addRows, ts: Date.now() };
    }
  }

  // ── 月度帳本 ──────────────────────────────────────────────────

  function _parseRow(r, rowIndex) {
    return {
      rowIndex,
      date:       r[0]  || '',
      item:       r[1]  || '',
      amount:     parseFloat(r[2])  || 0,
      payer:      r[3]  || '',
      shared:     r[4] === '部分共用' ? '部分' : (r[4] || ''),
      category:   r[5]  || '',
      sinShare:   parseFloat(r[6])  || 0,
      bearShare:  parseFloat(r[7])  || 0,
      note:       r[8]  || '',
      source:     r[9]  || '',
      sourceLink: r[10] || '',
      importedAt: r[11] || '',
    };
  }

  function _formulaText(value) {
    return String(value ?? '').replace(/"/g, '""');
  }

  function _sheetRef(name) {
    return `'${String(name).replace(/'/g, "''")}'`;
  }

  function _asInvoiceNumber(value) {
    const compact = String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const m = compact.match(/[A-Z]{2}\d{8}/);
    return m ? m[0] : '';
  }

  function _dynamicInvoiceLink(invNum, display = invNum, targetCol = 'C') {
    const q = _formulaText(invNum);
    return `=HYPERLINK("#gid=${CONFIG.INVOICE_SHEET_ID}&range=${targetCol}"&MATCH("${q}",${_sheetRef(CONFIG.TABS.INVOICE)}!$C:$C,0),"${_formulaText(display)}")`;
  }

  function _dynamicItemsLink(invNum, display = invNum) {
    const q = _formulaText(invNum);
    return `=HYPERLINK("#gid=${CONFIG.ITEMS_SHEET_ID}&range=G"&MATCH("${q}",${_sheetRef(CONFIG.TABS.ITEMS)}!$L:$L,0),"${_formulaText(display)}")`;
  }

  function _dynamicCCLink(ccGid, date, shop, amount, display = '→') {
    const normalizedAmount = Number(String(amount ?? '').replace(/,/g, ''));
    const key = _formulaText(`${date}|${shop}|${Math.round(normalizedAmount || 0)}`);
    const cc = _sheetRef(CONFIG.TABS.CC);
    return `=HYPERLINK("#gid=${ccGid}&range=A"&MATCH("${key}",ARRAYFORMULA(IFERROR(TEXT(${cc}!$B:$B,"yyyy-mm-dd"),SUBSTITUTE(${cc}!$B:$B,"/","-"))&"|"&${cc}!$D:$D&"|"&IFERROR(ROUND(VALUE(${cc}!$E:$E),0),${cc}!$E:$E)),0),"${_formulaText(display)}")`;
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
    const banks = ['台新', '星展', '永豐', '富邦'];
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
    await _ensureRowCapacity(CONFIG.TABS.MONTHLY, lastRow + 1);
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
    if (res.status === 401) { if (!_isDev) Auth.logout(); throw new Error('auth_expired'); }
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
      shared:    r[7] === '部分共用' ? '部分' : (r[7] || ''),
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

  async function updateItemRow(rowIndex, attribution, customBearAmount = null) {
    await _update(`${CONFIG.TABS.ITEMS}!G${rowIndex}`, [[attribution]]);
    if (customBearAmount !== null) {
      await _update(`${CONFIG.TABS.ITEMS}!I${rowIndex}`, [[customBearAmount]]);
    }
  }

  // ── 重複發票號碼查詢（兩段式：先查 C:C 定位，再單列取日期/商店）──
  async function checkDuplicateInvoice(invNum) {
    const data = await _get(`${CONFIG.TABS.INVOICE}!C:C`);
    const rows = (data.values || []).slice(1);
    const matches = rows
      .map((r, i) => ({ rowIndex: i + 2, invNum: r[0] || '' }))
      .filter(r => r.invNum === invNum);
    if (matches.length === 0) return [];
    const details = await Promise.all(
      matches.map(async m => {
        const d = await _get(`${CONFIG.TABS.INVOICE}!B${m.rowIndex}:D${m.rowIndex}`);
        const r = ((d.values || [[]])[0]) || [];
        return { rowIndex: m.rowIndex, date: r[0] || '', invNum: r[1] || invNum, shop: r[2] || '' };
      })
    );
    return details;
  }

  // ── 新增發票明細列（掃描發票用）──────────────────────
  // A=載具 B=日期(YYYY-MM-DD) C=發票號碼(HYPERLINK→品項明細G欄) D=商店
  // E=金額 F=狀態 G=類別 H=是否共用 I=備註 J=已匯入
  async function appendInvoiceRow(carrier, date, invNum, shop, amount, status, category, shared, note) {
    const data      = await _get(`${CONFIG.TABS.INVOICE}!A:A`);
    const lastRow   = (data.values || []).length;
    const newRow    = lastRow + 1;
    const invLink   = _dynamicItemsLink(invNum);
    const row = [carrier, date, invLink, shop, amount, status, category, shared, note, false];
    await _ensureRowCapacity(CONFIG.TABS.INVOICE, newRow);
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
    const rows    = items.map(({ name, amount }, idx) => {
      const r       = lastRow + 1 + idx;
      const invLink = _dynamicInvoiceLink(invNum, invNum, 'H');
      const bearFormula = `=IF(I${r}<>"",I${r},IF(G${r}="🌟 Sin",0,IF(G${r}="🐨 Bear",F${r},IF(G${r}="共用",ROUND(F${r}/2,0),0))))`;
      return [carrier, date, invLink, shop, name, amount, '', bearFormula, '', ''];
    });
    const startRow = lastRow + 1;
    const endRow = lastRow + rows.length;
    await _ensureRowCapacity(CONFIG.TABS.ITEMS, endRow);
    await _batchUpdate([
      { range: `${CONFIG.TABS.ITEMS}!A${startRow}:J${endRow}`, values: rows },
      { range: `${CONFIG.TABS.ITEMS}!L${startRow}:L${endRow}`, values: rows.map(() => [invNum]) },
    ]);
    return lastRow + 1;  // 第一筆品項的列號
  }

  // ── 新增單筆整體品項（無品項→部分 時，讓公式鏈生效）─────
  async function appendSyntheticItemRow(invoiceInfo, { itemName, itemAmount, attribution, customAmount, note = '' }) {
    const { carrier, date, invNum, shop } = invoiceInfo;
    const data    = await _get(`${CONFIG.TABS.ITEMS}!A:A`);
    const r       = (data.values || []).length + 1;
    const invLink = _dynamicInvoiceLink(invNum, invNum, 'H');
    const bearFormula = `=IF(I${r}<>"",I${r},IF(G${r}="🌟 Sin",0,IF(G${r}="🐨 Bear",F${r},IF(G${r}="共用",ROUND(F${r}/2,0),0))))`;
    const row = [carrier, date, invLink, shop, itemName, itemAmount, attribution, bearFormula, customAmount, note];
    await _batchUpdate([
      { range: `${CONFIG.TABS.ITEMS}!A${r}:J${r}`, values: [row] },
      { range: `${CONFIG.TABS.ITEMS}!L${r}:L${r}`, values: [[invNum]] },
    ]);
  }

  // ── 勾選發票明細已匯入（J欄 = TRUE）────────────────────
  async function markInvoiceImported(rowIndex) {
    await _update(`${CONFIG.TABS.INVOICE}!J${rowIndex}`, [[true]]);
  }

  async function setInvoiceImported(rowIndex, imported) {
    await _update(`${CONFIG.TABS.INVOICE}!J${rowIndex}`, [[!!imported]]);
  }

  // ── 發票來源匯入月度帳本 ────────────────────────────
  // 有 invNum 時寫 VLOOKUP 公式（C/E/G/H），發票明細改動後月度帳本自動同步。
  // 無 invNum 時寫靜態值，G/H 沿用 ensure_capacity 的 buffer 公式。
  async function appendMonthlyFromInvoice({ date, shop, amount, shared, category, note = '', invNum, invRowIndex, source = '發票', payer = '🌟 Star' }) {
    const now        = new Date();
    const importedAt = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
    const sourceLink = _dynamicInvoiceLink(invNum);

    // 讀 A 欄定位最後列
    const data   = await _get(`${CONFIG.TABS.MONTHLY}!A:A`);
    const lastRow = (data.values || []).length;
    const nextRow = lastRow + 1;
    const tab     = CONFIG.TABS.MONTHLY;
    const invSheet = CONFIG.TABS.INVOICE;

    const ccSheet  = CONFIG.TABS.CC;
    const batchData = [];
    if (invNum) {
      // C：CC 金額 > 発票金額+1（外送費）→ 用 CC 金額，否則用発票金額
      const cFormula = `=IFERROR(IF(ISNUMBER(MATCH(K${nextRow},'${ccSheet}'!$I:$I,0)),IF(INDEX('${ccSheet}'!$E:$E,MATCH(K${nextRow},'${ccSheet}'!$I:$I,0))>IFERROR(VLOOKUP(K${nextRow},'${invSheet}'!$C:$E,3,0),0)+1,INDEX('${ccSheet}'!$E:$E,MATCH(K${nextRow},'${ccSheet}'!$I:$I,0)),IFERROR(VLOOKUP(K${nextRow},'${invSheet}'!$C:$E,3,0),"")),IFERROR(VLOOKUP(K${nextRow},'${invSheet}'!$C:$E,3,0),"")),"")`;
      const eFormula = `=IFERROR(VLOOKUP(K${nextRow},'${invSheet}'!$C:$H,6,0),"")`;
      const gFormula = `=IFERROR(IF(C${nextRow}="","",C${nextRow}-H${nextRow}),"")`;
      // H：依月度帳本 C（正確總金額）與 E（是否共用）計算
      const hFormula = `=IFERROR(IF(E${nextRow}="是",ROUND(C${nextRow}/2,0),IF(E${nextRow}="否",C${nextRow},IF(E${nextRow}="-",0,IF(E${nextRow}="部分",IFERROR(VLOOKUP(K${nextRow},'${invSheet}'!$C:$K,9,0),0)+ROUND((C${nextRow}-IFERROR(VLOOKUP(K${nextRow},'${invSheet}'!$C:$E,3,0),0))/2,0),0)))),"")`;

      batchData.push(
        { range: `${tab}!A${nextRow}:F${nextRow}`, values: [[date, shop, cFormula, payer || '🌟 Star', eFormula, category]] },
        { range: `${tab}!G${nextRow}:H${nextRow}`, values: [[gFormula, hFormula]] },
      );
    } else {
      // 無發票號碼 → 靜態值，G/H 由 buffer 公式計算
      batchData.push(
        { range: `${tab}!A${nextRow}:F${nextRow}`, values: [[date, shop, amount, payer || '🌟 Star', shared, category]] },
      );
    }
    batchData.push({ range: `${tab}!I${nextRow}:L${nextRow}`, values: [[note, source, sourceLink, importedAt]] });

    await _batchUpdate(batchData);

    const ym = (date || '').slice(0, 7);
    if (ym) invalidateMonth(ym);
    await markInvoiceImported(invRowIndex);
  }

  // ── 掃描發票直接匯入月度帳本 ────────────────────────────
  // shared: 是/否/部分/-/x；G/H 由月度帳本公式自動計算。
  async function appendMonthlyFromScan(args) {
    return appendMonthlyFromInvoice({ ...args, source: args.source || '掃描發票' });
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
      category: r[6] || '',
      shared:   r[7] || '',
      note:     r[9] || '',
      imported: r[10] || '',
    };
  }

  async function getCCPendingData() {
    const data = await _get(`${CONFIG.TABS.CC}!A:L`);
    return (data.values || []).slice(1)
      .map((r, i) => _parseCCRow(r, i + 2))
      .filter(r => r.shared === '' && r.imported !== 'TRUE' && r.shop !== '' && r.amount > 0);
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

  // ── 取得全部信用卡明細（掃描/CC 配對用）────────────────────────
  async function getCCAllData() {
    const data = await _get(`${CONFIG.TABS.CC}!A:J`);
    return (data.values || []).slice(1)
      .map((r, i) => ({
        rowIndex: i + 2,
        bank:    r[0] || '',
        txDate:  _normalizeDate(r[1]),
        shop:    r[3] || '',
        amount:  parseFloat(r[4]) || 0,
        shared:  r[7] || '',
        matched: _asInvoiceNumber(r[8]),  // I欄：只接受發票號碼，避免誤填備註被當連結
        note:    r[9] || '',
      }))
      .filter(r => r.amount > 0 && r.txDate);
  }

  // ── 將信用卡明細連結至掃描發票（H='x', I=發票號碼連結）──────────────
  async function linkCCToInvoice(ccRowIndex, invNum, invRowIndex) {
    const cellVal = invNum ? _dynamicInvoiceLink(invNum) : invNum;
    await _batchUpdate([
      { range: `${CONFIG.TABS.CC}!H${ccRowIndex}`, values: [['x']] },
      { range: `${CONFIG.TABS.CC}!I${ccRowIndex}`, values: [[cellVal]] },
    ]);
  }

  // ── 讀商店分類規則 A:C，回傳平台 mapping ──────────────────────
  // 回傳: { 'UberEats': ['優步', '優食', ...], '蝦皮': ['樂購蝦皮'] }
  // 內建平台商家預設（永豐等新來源的 CC 商店字串），與 Sheet 第三欄合併，
  //   Sheet 仍可再擴充其他平台/商家；UberEats CC 出現「優步福爾摩沙…」與「優食－…」兩種字串。
  const _BUILTIN_PLATFORM_MERCHANTS = { 'UberEats': ['優步', '優食'] };
  async function getRulesData() {
    const map = {};
    for (const [p, kws] of Object.entries(_BUILTIN_PLATFORM_MERCHANTS)) map[p] = [...kws];
    try {
      const data = await _get(`${CONFIG.TABS.RULES}!A:C`);
      (data.values || []).slice(1).forEach(r => {
        const keyword  = (r[0] || '').trim();
        const platform = (r[2] || '').trim();
        if (keyword && platform && !(map[platform] || []).includes(keyword)) {
          (map[platform] = map[platform] || []).push(keyword);
        }
      });
    } catch { /* 讀取失敗仍回傳內建預設 */ }
    return map;
  }

  // ── 平台訂單配對 CC 後寫入月度帳本 ───────────────────────────
  // sinShare/bearShare 由呼叫端根據品項歸屬 + CC 差額計算
  async function linkPlatformToCC({ inv, cc, sinShare, bearShare, payer = '🌟 Star' }) {
    const now = new Date();
    const importedAt = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
    const sourceLink = _dynamicInvoiceLink(inv.invNum);
    const source = inv.carrier === '手查發票' ? '手查發票' : '掃描發票';

    const row = [
      inv.date, inv.shop, cc.amount,
      payer || '🌟 Star', inv.shared, inv.category || '',
      sinShare, bearShare, '',
      source, sourceLink, importedAt,
    ];
    await appendMonthlyRow(row);
    await markInvoiceImported(inv.rowIndex);
    await linkCCToInvoice(cc.rowIndex, inv.invNum, inv.rowIndex);
  }

  // ── 匯入月度帳本（Step 1–4）──────────────────────────────────
  function _calcShares(amount, shared, bearStr) {
    const amt = parseFloat(String(amount).replace(',', '')) || 0;
    if (shared === '是') { const h = Math.floor(amt / 2); return [String(h), String(amt - h)]; }
    if (shared === '否') return ['0', String(Math.round(amt))];
    if (shared === '部分') { const b = parseInt(bearStr) || 0; return [String(Math.round(amt) - b), String(b)]; }
    if (shared === '-') return [String(Math.round(amt)), '0'];
    return [String(Math.round(amt)), '0'];
  }

  let _sheetIdCache = null;
  async function _fetchSheetIds() {
    if (_sheetIdCache) return _sheetIdCache;
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.SHEET_ID}?fields=sheets.properties`;
    const res = await fetch(url, { headers: _authHeader() });
    if (res.status === 401) { if (!_isDev) Auth.logout(); throw new Error('auth_expired'); }
    if (!res.ok) throw new Error(`Sheets API ${res.status}`);
    const data = await res.json();
    _sheetIdCache = {};
    (data.sheets || []).forEach(s => { _sheetIdCache[s.properties.title] = s.properties.sheetId; });
    return _sheetIdCache;
  }

  async function importToMonthly(year, month, onProgress) {
    const ym  = `${year}-${String(month).padStart(2, '0')}`;
    const now = new Date();
    const importedAt = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
    const sid = CONFIG.SHEET_ID;
    const log = msg => onProgress?.(msg);

    log('讀取 Sheet 資訊…');
    const gids   = await _fetchSheetIds();
    const invGid = gids[CONFIG.TABS.INVOICE];
    const ccGid  = gids[CONFIG.TABS.CC];

    // ── Step 1: 發票明細 → 月度帳本 ───────────────────────────
    log('[Step 1] 讀取發票明細 + 品項明細…');
    const [invRaw, itemRaw] = await Promise.all([
      _get(`${CONFIG.TABS.INVOICE}!A:K`),
      _get(`${CONFIG.TABS.ITEMS}!A:K`),
    ]);
    const itemMap = {};
    (itemRaw.values || []).slice(1).forEach(r => {
      const num = r[2] || '';
      if (num) (itemMap[num] = itemMap[num] || []).push(r);
    });
    const invRows    = (invRaw.values || []).slice(1);
    const toImportInv = [];
    for (let i = 0; i < invRows.length; i++) {
      const r = [...invRows[i]];
      while (r.length < 11) r.push('');
      const date = r[1].replace(/^'/, '').replace(/\//g, '-');
      if (r[5] === '作廢') continue;
      if (!['是','否','部分','-'].includes(r[7])) continue;
      if (!r[6]) continue;
      if (r[9] === 'TRUE' || r[9] === 'True') continue;
      if (CONFIG.CC_PAY_KEYWORDS.some(kw => (r[8] || '').toLowerCase().includes(kw.toLowerCase()))) continue;
      if (!date.startsWith(ym)) continue;
      if (r[7] === '部分') {
        const its = itemMap[r[2]] || [];
        if (!its.length || its.some(it => !(it[6] || '').trim())) continue;
      }
      toImportInv.push({ rowIndex: i + 2, r });
    }
    log(`[Step 1] 待匯入 ${toImportInv.length} 筆`);

    const importedInvList = [];
    const invMonthlyRows  = [];
    const invMarkRanges   = [];
    for (const { rowIndex, r } of toImportInv) {
      const date = r[1].replace(/^'/, '');
      const [sin, bear] = _calcShares(r[4], r[7], r[10]);
      const link = _dynamicInvoiceLink(r[2] || '→');
      invMonthlyRows.push([date, r[3]||'', r[4]||'0', '🌟 Star', r[7], r[6]||'', sin, bear, r[8]||'', '發票', link, importedAt]);
      invMarkRanges.push({ range: `${CONFIG.TABS.INVOICE}!J${rowIndex}`, values: [[true]] });
      importedInvList.push({ date, amount: parseFloat(String(r[4]).replace(',','')) || 0 });
    }
    if (invMonthlyRows.length) {
      const colA = await _get(`${CONFIG.TABS.MONTHLY}!A:A`);
      const next = (colA.values || []).length + 1;
      await _update(`${CONFIG.TABS.MONTHLY}!A${next}:L${next + invMonthlyRows.length - 1}`, invMonthlyRows);
      await _batchUpdate(invMarkRanges);
      invalidateMonth(ym);
    }
    log(`[Step 1] 完成，匯入 ${invMonthlyRows.length} 筆`);

    // ── Step 2: 信用卡明細 → 月度帳本 ─────────────────────────
    log('[Step 2] 讀取信用卡明細…');
    const ccRaw  = await _get(`${CONFIG.TABS.CC}!A:K`);
    const ccRows = (ccRaw.values || []).slice(1);

    // 已匯入發票（含 App 掃描）加入去重清單
    const allInvDedup = [...importedInvList];
    invRows.forEach(r => {
      if ((r[9]==='TRUE'||r[9]==='True') && r[7]!=='x' && r[7]!=='') {
        const date = (r[1]||'').replace(/^'/,'');
        const amt  = parseFloat(r[4]) || 0;
        if (date && amt) allInvDedup.push({ date, amount: amt });
      }
    });

    const toImportCC = [];
    let unresPartial = 0;
    for (let i = 0; i < ccRows.length; i++) {
      const r = [...ccRows[i]];
      while (r.length < 11) r.push('');
      const date = r[1].replace(/^'/, '').replace(/\//g, '-');
      if (!['是','否','-','部分'].includes(r[7])) continue;
      if (r[10]==='TRUE' || r[10]==='True') continue;
      if (_asInvoiceNumber(r[8])) continue;
      if (!date.startsWith(ym)) continue;
      if (r[7] === '部分') {
        const bearAmt = parseFloat((r[9]||'').replace(',',''));
        if (isNaN(bearAmt)) { unresPartial++; continue; }
        toImportCC.push({ rowIndex: i+2, r, bearOverride: bearAmt, date });
      } else {
        toImportCC.push({ rowIndex: i+2, r, bearOverride: null, date });
      }
    }
    if (unresPartial) log(`[Step 2] ⚠ ${unresPartial} 筆「部分」備註未填金額，略過`);
    log(`[Step 2] 待匯入（篩前）${toImportCC.length} 筆`);

    const ccMonthlyRows = [];
    const ccMarkRanges  = [];
    let   skippedInv    = 0;
    for (const { rowIndex, r, bearOverride, date } of toImportCC) {
      const amt    = parseFloat(r[4]) || 0;
      const ccDate = new Date(date);
      const hasDup = allInvDedup.some(({ date: d, amount: a }) =>
        Math.abs((ccDate - new Date(d)) / 86400000) <= 5 && amt === a
      );
      if (hasDup) { skippedInv++; continue; }
      const [sin, bear] = bearOverride !== null
        ? _calcShares(r[4], '部分', String(bearOverride))
        : _calcShares(r[4], r[7]);
      const link = _dynamicCCLink(ccGid, date, r[3] || '', r[4] || 0);
      ccMonthlyRows.push([date, r[3]||'', r[4]||'0', '🌟 Star', r[7], r[6]||'', sin, bear, r[9]||'', '信用卡', link, importedAt]);
      ccMarkRanges.push({ range: `${CONFIG.TABS.CC}!K${rowIndex}`, values: [[true]] });
    }
    log(`[Step 2] 因已有發票略過：${skippedInv} 筆`);
    if (ccMonthlyRows.length) {
      const colA = await _get(`${CONFIG.TABS.MONTHLY}!A:A`);
      const next = (colA.values || []).length + 1;
      await _update(`${CONFIG.TABS.MONTHLY}!A${next}:L${next + ccMonthlyRows.length - 1}`, ccMonthlyRows);
      await _batchUpdate(ccMarkRanges);
      invalidateMonth(ym);
    }
    log(`[Step 2] 完成，匯入 CC ${ccMonthlyRows.length} 筆`);

    // ── Step 3: 固定月費（房租）────────────────────────────────
    log('[Step 3] 固定月費…');
    const abRaw = await _get(`${CONFIG.TABS.MONTHLY}!A:B`);
    const monthItems = new Set(
      (abRaw.values||[]).slice(1).filter(r=>(r[0]||'').startsWith(ym)).map(r=>r[1]||'')
    );
    const RECURRING = [
      { day:1, item:'房租', amount:'16500', payer:'🌟 Star', shared:'是', category:'🏠', note:'' },
    ];
    for (const e of RECURRING) {
      if (monthItems.has(e.item)) { log(`[Step 3] ${e.item} 已存在，略過`); continue; }
      const [sin, bear] = _calcShares(e.amount, e.shared);
      const date = `${ym}-${String(e.day).padStart(2,'0')}`;
      const colA = await _get(`${CONFIG.TABS.MONTHLY}!A:A`);
      await _update(`${CONFIG.TABS.MONTHLY}!A${(colA.values||[]).length+1}:L${(colA.values||[]).length+1}`,
        [[date, e.item, e.amount, e.payer, e.shared, e.category, sin, bear, e.note, '手動記帳', '', importedAt]]);
      invalidateMonth(ym);
      log(`[Step 3] 新增 ${e.item}`);
    }

    // ── Step 4: 交通費提醒列 ─────────────────────────────────
    log('[Step 4] 交通費提醒列…');
    const bRaw = await _get(`${CONFIG.TABS.MONTHLY}!B:B`);
    const transportKey = `交通費 ${ym}`;
    if (!(bRaw.values||[]).slice(1).some(r=>(r[0]||'').includes(transportKey))) {
      const lastDay = new Date(year, month, 0).getDate();
      const colA    = await _get(`${CONFIG.TABS.MONTHLY}!A:A`);
      await _update(`${CONFIG.TABS.MONTHLY}!A${(colA.values||[]).length+1}:L${(colA.values||[]).length+1}`,
        [[`${ym}-${lastDay}`, `[待填] ${transportKey}`, '', '🌟 Star', '-', '⛽', '', '0', '悠遊卡', '手動記帳', '', '']]);
      invalidateMonth(ym);
      log(`[Step 4] 新增 [待填] ${transportKey}`);
    } else {
      log('[Step 4] 交通費已存在，略過');
    }

    return { invoices: invMonthlyRows.length, cc: ccMonthlyRows.length, skippedCC: skippedInv };
  }

  // ── F20 刪除：發票明細整列刪除 ──────────────────────────────
  async function deleteInvoiceRow(rowIndex) {
    const url = `${BASE}:batchUpdate`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { ..._authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: [{
          deleteDimension: {
            range: {
              sheetId: CONFIG.INVOICE_SHEET_ID,
              dimension: 'ROWS',
              startIndex: rowIndex - 1,
              endIndex: rowIndex,
            },
          },
        }],
      }),
    });
    if (res.status === 401) { if (!_isDev) Auth.logout(); throw new Error('auth_expired'); }
    if (!res.ok) throw new Error(`Sheets API ${res.status}`);
    return res.json();
  }

  // ── F20 刪除：品項明細多列刪除（降序避免 index 位移）──────────
  async function deleteItemRows(rowIndices) {
    if (!rowIndices.length) return;
    const sorted = [...rowIndices].sort((a, b) => b - a);
    const url = `${BASE}:batchUpdate`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { ..._authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: sorted.map(rowIndex => ({
          deleteDimension: {
            range: {
              sheetId: CONFIG.ITEMS_SHEET_ID,
              dimension: 'ROWS',
              startIndex: rowIndex - 1,
              endIndex: rowIndex,
            },
          },
        })),
      }),
    });
    if (res.status === 401) { if (!_isDev) Auth.logout(); throw new Error('auth_expired'); }
    if (!res.ok) throw new Error(`Sheets API ${res.status}`);
    return res.json();
  }

  // ── Sub-tab：更新信用卡明細 G（類別）/ H（共用）/ J（備註）──
  async function updateCCFields(rowIndex, { category, shared, note } = {}) {
    const updates = [];
    if (category !== undefined) updates.push({ range: `${CONFIG.TABS.CC}!G${rowIndex}`, values: [[category]] });
    if (shared   !== undefined) updates.push({ range: `${CONFIG.TABS.CC}!H${rowIndex}`, values: [[shared]] });
    if (note     !== undefined) updates.push({ range: `${CONFIG.TABS.CC}!J${rowIndex}`, values: [[note]] });
    if (updates.length) await _batchUpdate(updates);
  }

  // ── F20 編輯：更新發票明細 G/H/I 欄 ─────────────────────────
  async function updateInvoiceFields(rowIndex, { category, shared, note } = {}) {
    const updates = [];
    if (category !== undefined) updates.push({ range: `${CONFIG.TABS.INVOICE}!G${rowIndex}`, values: [[category]] });
    if (shared   !== undefined) updates.push({ range: `${CONFIG.TABS.INVOICE}!H${rowIndex}`, values: [[shared]] });
    if (note     !== undefined) updates.push({ range: `${CONFIG.TABS.INVOICE}!I${rowIndex}`, values: [[note]] });
    if (updates.length) await _batchUpdate(updates);
  }

  // ── F20 編輯：更新品項明細 G/I/J 欄 ─────────────────────────
  async function updateItemFields(rowIndex, { attribution, customAmount, note } = {}) {
    const updates = [];
    if (attribution  !== undefined) updates.push({ range: `${CONFIG.TABS.ITEMS}!G${rowIndex}`, values: [[attribution]] });
    if (customAmount !== undefined) updates.push({ range: `${CONFIG.TABS.ITEMS}!I${rowIndex}`, values: [[customAmount]] });
    if (note         !== undefined) updates.push({ range: `${CONFIG.TABS.ITEMS}!J${rowIndex}`, values: [[note]] });
    if (updates.length) await _batchUpdate(updates);
  }

  // ── F20 編輯：同步更新月度帳本指定列的 E（共用）或 F（類別）──
  async function updateMonthlyFields(rowIndex, { shared, category, payer } = {}, ym) {
    const updates = [];
    if (payer    !== undefined) updates.push({ range: `${CONFIG.TABS.MONTHLY}!D${rowIndex}`, values: [[payer]] });
    if (shared   !== undefined) updates.push({ range: `${CONFIG.TABS.MONTHLY}!E${rowIndex}`, values: [[shared]] });
    if (category !== undefined) updates.push({ range: `${CONFIG.TABS.MONTHLY}!F${rowIndex}`, values: [[category]] });
    if (updates.length) {
      await _batchUpdate(updates);
      if (ym) invalidateMonth(ym);
    }
  }

  // ── F20 刪除/編輯：找出連結某發票的 CC 列（兩段式，只讀 I:I 定位）──
  async function getCCForInvoice(invNum) {
    const iData = await _get(`${CONFIG.TABS.CC}!I:I`);
    const iRows = (iData.values || []).slice(1);
    const matches = iRows
      .map((r, i) => ({ rowIndex: i + 2, matched: _asInvoiceNumber(r[0]) }))
      .filter(r => r.matched === _asInvoiceNumber(invNum));
    if (!matches.length) return [];
    return await Promise.all(matches.map(async m => {
      const d = await _get(`${CONFIG.TABS.CC}!A${m.rowIndex}:E${m.rowIndex}`);
      const r = ((d.values || [[]])[0]) || [];
      return { rowIndex: m.rowIndex, bank: r[0] || '', amount: parseFloat(r[4]) || 0 };
    }));
  }

  // ── F20 CC 月度帳本 G/H 直接更新（CC 配對靜態值同步）─────────
  async function updateMonthlyGH(rowIndex, sinShare, bearShare, ym) {
    await _batchUpdate([
      { range: `${CONFIG.TABS.MONTHLY}!G${rowIndex}`, values: [[sinShare]] },
      { range: `${CONFIG.TABS.MONTHLY}!H${rowIndex}`, values: [[bearShare]] },
    ]);
    if (ym) invalidateMonth(ym);
  }

  // ── F20 解除配對：清 CC H/I 欄 + 重設 K=FALSE ───────────────
  async function unlinkCC(ccRowIndex) {
    await _batchUpdate([
      { range: `${CONFIG.TABS.CC}!H${ccRowIndex}`, values: [['']] },
      { range: `${CONFIG.TABS.CC}!I${ccRowIndex}`, values: [['']] },
      { range: `${CONFIG.TABS.CC}!K${ccRowIndex}`, values: [[false]] },
    ]);
  }

  // ── 依日期+金額找 CC 明細列（CC月度刪除用）───────────────────
  async function findCCRowByDateAmount(date, amount) {
    const data = await _get(`${CONFIG.TABS.CC}!B:E`);
    const rows  = (data.values || []).slice(1);
    const target = Math.round(amount);
    const tDate  = new Date(date);
    for (let i = 0; i < rows.length; i++) {
      const r   = rows[i];
      const amt = Math.round(parseFloat(r[3]) || 0);
      if (amt !== target) continue;
      const rDate = new Date(r[0] || '');
      const diff  = Math.abs((rDate - tDate) / 86400000);
      if (diff <= 3) return { rowIndex: i + 2 };
    }
    return null;
  }

  // ── 重設 CC 已匯入 K=FALSE（CC月度刪除用）───────────────────
  async function resetCCImported(ccRowIndex) {
    await _batchUpdate([
      { range: `${CONFIG.TABS.CC}!K${ccRowIndex}`, values: [[false]] },
    ]);
  }

  // ── 發票明細 sub-tab 資料（date = YYYYMMDD）──────────────────
  async function getInvoiceSheetData(year, month) {
    const data = await _get(`${CONFIG.TABS.INVOICE}!A:K`);
    const ym = `${year}-${String(month).padStart(2, '0')}`;
    return (data.values || []).slice(1)
      .map((r, i) => _parseInvoiceRow(r, i + 2))
      .filter(r => r.date.startsWith(ym));
  }

  // ── CC明細 sub-tab 資料（txDate = YYYY-MM-DD）────────────────
  async function getCCSheetData(year, month) {
    const data = await _get(`${CONFIG.TABS.CC}!A:L`);
    const ym = `${year}-${String(month).padStart(2, '0')}`;
    return (data.values || []).slice(1).map((r, i) => ({
      rowIndex:     i + 2,
      bank:         r[0]  || '',
      txDate:       (r[1] || '').replace(/^'/, '').replace(/\//g, '-'),
      entryDate:    r[2]  || '',
      shop:         r[3]  || '',
      amount:       parseFloat(r[4]) || 0,
      country:      r[5]  || '',
      category:     r[6]  || '',
      shared:       r[7]  || '',
      matched:      _asInvoiceNumber(r[8]),
      note:         r[9]  || '',
      posted:       r[10] === 'TRUE' || r[10] === true,
      billingMonth: r[11] || '',
    })).filter(r => r.txDate.startsWith(ym));
  }

  // ── Gmail 載具抓取：檢查與批次寫入 ──────────────────────────

  // carrierKeyword: 若提供，只計算 A 欄（載具）含該關鍵字的列
  async function countRawInvoicesForMonth(year, month, carrierKeyword = null) {
    const ym   = `${year}-${String(month).padStart(2, '0')}`;
    const data = await _get(`${CONFIG.TABS.INVOICE}!A:B`);
    return (data.values || []).slice(1)
      .filter(r => {
        const date    = (r[1] || '').replace(/^'/, '').replace(/\//g, '-');
        const carrier = r[0] || '';
        return date.startsWith(ym) && (!carrierKeyword || carrier.includes(carrierKeyword));
      })
      .length;
  }

  async function writeInvoicesFromGmail(invoices, items, onProgress) {
    const log = m => onProgress?.(m);

    // 0. 讀商店分類規則（對齊 Python fetch_invoices.py lookup_category）
    let invRulesRows = [];
    try {
      const rd = await _get(`${CONFIG.TABS.RULES}!A:B`);
      invRulesRows = (rd.values || []).slice(1)
        .map(r => [(r[0] || '').trim().toUpperCase(), (r[1] || '').trim()])
        .filter(([k]) => k);
    } catch (e) { log(`⚠ 讀取商店分類規則失敗：${e.message}，類別留空`); }
    function _invLookupCategory(seller) {
      const su = (seller || '').toUpperCase();
      for (const [kw, cat] of invRulesRows) { if (su.includes(kw)) return cat; }
      return '';
    }

    // 1. 讀取既有發票號碼（C 欄 FORMATTED_VALUE = 顯示文字 = invNum）
    log('檢查既有發票號碼…');
    const existingData = await _get(`${CONFIG.TABS.INVOICE}!C:C`);
    const existingNums = new Set(
      (existingData.values || []).slice(1).map(r => (r[0] || '').trim()).filter(Boolean)
    );

    const newInvoices = invoices.filter(inv => !existingNums.has(inv.invNum));
    if (!newInvoices.length) {
      log('所有發票已存在，略過寫入');
      return { invoices: 0, items: 0 };
    }

    // 2. 讀取既有品項 invNum（L 欄 = 純發票號碼 helper）
    const existingItemData = await _get(`${CONFIG.TABS.ITEMS}!L:L`);
    const existingItemNums = new Set(
      (existingItemData.values || []).slice(1).map(r => (r[0] || '').trim()).filter(Boolean)
    );
    const itemsByInv = {};
    for (const it of items) {
      if (!existingItemNums.has(it.invNum)) {
        (itemsByInv[it.invNum] = itemsByInv[it.invNum] || []).push(it);
      }
    }

    // 3. 批次寫入發票明細（C 欄先寫純文字，等品項寫完後再更新 HYPERLINK）
    const invColA   = await _get(`${CONFIG.TABS.INVOICE}!A:A`);
    let invLastRow  = (invColA.values || []).length;
    const invRows   = [], invRowMap = {};
    for (const inv of newInvoices) {
      invLastRow++;
      invRowMap[inv.invNum] = invLastRow;
      const _cat    = _invLookupCategory(inv.seller);
      const _shared = (_cat && inv.shared === '') ? '-' : inv.shared;
      invRows.push([
        inv.carrier, "'" + inv.date, inv.invNum,
        inv.seller, inv.amount, inv.status,
        _cat, _shared, '', false,
      ]);
    }
    const invStart = invLastRow - invRows.length + 1;
    await _update(`${CONFIG.TABS.INVOICE}!A${invStart}:J${invLastRow}`, invRows);
    log(`  → 發票明細：寫入 ${invRows.length} 筆`);

    // 4. 批次寫入品項明細
    const itemColA   = await _get(`${CONFIG.TABS.ITEMS}!A:A`);
    let itemLastRow  = (itemColA.values || []).length;
    const itemRows   = [], helperRows = [];
    const firstItemRowByInv = {};
    for (const inv of newInvoices) {
      for (const it of itemsByInv[inv.invNum] || []) {
        itemLastRow++;
        if (!(inv.invNum in firstItemRowByInv)) firstItemRowByInv[inv.invNum] = itemLastRow;
        const invLink     = _dynamicInvoiceLink(inv.invNum, inv.invNum, 'H');
        const bearFormula = `=IF(I${itemLastRow}<>"",I${itemLastRow},IF(G${itemLastRow}="🌟 Sin",0,IF(G${itemLastRow}="🐨 Bear",F${itemLastRow},IF(G${itemLastRow}="共用",ROUND(F${itemLastRow}/2,0),0))))`;
        itemRows.push([inv.carrier, "'" + inv.date, invLink, inv.seller, it.name, it.amount, '', bearFormula, '', '']);
        helperRows.push([inv.invNum]);
      }
    }
    let writtenItems = 0;
    if (itemRows.length) {
      const itemStart = itemLastRow - itemRows.length + 1;
      await _ensureRowCapacity(CONFIG.TABS.ITEMS, itemLastRow);
      await _batchUpdate([
        { range: `${CONFIG.TABS.ITEMS}!A${itemStart}:J${itemLastRow}`, values: itemRows },
        { range: `${CONFIG.TABS.ITEMS}!L${itemStart}:L${itemLastRow}`, values: helperRows },
      ]);
      writtenItems = itemRows.length;
      log(`  → 品項明細：寫入 ${writtenItems} 筆`);

      // 5. 更新發票明細 C 欄為 HYPERLINK → 品項明細（有品項的發票才更新）
      const cUpdates = Object.entries(firstItemRowByInv)
        .filter(([invNum]) => invRowMap[invNum])
        .map(([invNum]) => ({
          range: `${CONFIG.TABS.INVOICE}!C${invRowMap[invNum]}`,
          values: [[_dynamicItemsLink(invNum)]],
        }));
      if (cUpdates.length) {
        await _batchUpdate(cUpdates);
        log(`  → 發票明細 C 欄連結：更新 ${cUpdates.length} 筆`);
      }
    }

    return { invoices: invRows.length, items: writtenItems };
  }

  // ── CC 明細：從 Gmail.fetchCCForMonth() 回傳的交易寫入 Sheets ──

  // ── CC ↔ 發票自動配對（port Python match.py match_cc_with_invoices）──
  //  開立發票：金額±1、日期±3 且「唯一候選」→ CC I 欄填發票連結、H 原空才填 'x'
  //  作廢發票（cc金額>0）：金額±1、日期±3 且唯一候選 → I 欄填「號碼(作廢)」連結、H='x'
  //  根治誤配（2026-06-16，App+Python match.py 一致）：
  //   ① 跳過平台商家（UberEats/蝦皮）——訂單金額含運費/小費，常與他店發票±1 巧合誤配，
  //      一律走 F18 平台待配對手動連。
  //   ② 預載 Sheet 上已連結的發票號碼，一張發票永不重複連（跨多次執行去重）。
  //   ③ 一筆 CC 命中多張候選發票 → 留白不連，避免任選一張造成張冠李戴。
  function _parseDateObj(s) {
    const m = _normalizeDate(s).replace(/\//g, '-').match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
  }
  // 平台商家：禁止自動金額配對（改走平台待配對）。蝦皮原本用 ±10 容差，現一併跳過。
  const _MATCH_SKIP_MERCHANTS = ['優步', '優食', 'UBER', 'UBEREATS', '蝦皮', '樂購蝦皮', 'SHOPEE'];
  function _isPlatformMerchant(shop) {
    const su = (shop || '').toUpperCase();
    return _MATCH_SKIP_MERCHANTS.some(k => su.includes(k.toUpperCase()));
  }

  async function matchCCWithInvoices(onProgress) {
    const log = m => onProgress?.(m);
    const [invData, ccData] = await Promise.all([
      _get(`${CONFIG.TABS.INVOICE}!A:F`),
      _get(`${CONFIG.TABS.CC}!A:I`),
    ]);
    const opened = [], voided = [];
    (invData.values || []).slice(1).forEach(r => {
      const d   = _parseDateObj(r[1]);
      const amt = parseFloat(String(r[4] || '').replace(/,/g, '')) || 0;
      const num = (r[2] || '').trim();
      if (!d || !amt || !num) return;
      (r[5] === '作廢' ? voided : opened).push({ d, amt, num });
    });
    if (!opened.length && !voided.length) { log('→ 發票配對：無發票可比對'); return 0; }

    const _days = (a, b) => Math.abs((a - b) / 86400000);
    const updates = [];
    const ccRows = (ccData.values || []).slice(1);
    // 根治②：預載 Sheet 上已連結的發票號碼，避免跨執行把同一張發票連到多筆 CC
    const matchedInv = new Set();
    for (const r of ccRows) {
      const num = _asInvoiceNumber(r[8]);
      if (num) matchedInv.add(num);
    }
    for (let i = 0; i < ccRows.length; i++) {
      const r = ccRows[i];
      const rowNum = i + 2;
      if ((r[8] || '').trim()) continue;            // I 欄已連結
      const ccD   = _parseDateObj(r[1]);
      const ccAmt = parseFloat(String(r[4] || '').replace(/,/g, '')) || 0;
      if (!ccD || !ccAmt) continue;
      const shop  = r[3] || '';
      if (_isPlatformMerchant(shop)) continue;      // 根治①：平台訂單不自動金額配對
      // 根治③：收集所有符合的開立發票候選，唯一才連、多張留白
      const cands = opened.filter(inv =>
        !matchedInv.has(inv.num) && _days(ccD, inv.d) <= 3 && Math.abs(ccAmt - inv.amt) <= 1);
      let matched = false;
      if (cands.length === 1) {
        const inv = cands[0];
        updates.push({ range: `${CONFIG.TABS.CC}!I${rowNum}`, values: [[_dynamicInvoiceLink(inv.num)]] });
        if (!(r[7] || '').trim()) updates.push({ range: `${CONFIG.TABS.CC}!H${rowNum}`, values: [['x']] });
        matchedInv.add(inv.num); matched = true;
      }
      if (!matched && ccAmt > 0) {
        const vcands = voided.filter(inv =>
          !matchedInv.has(inv.num) && _days(ccD, inv.d) <= 3 && Math.abs(ccAmt - inv.amt) <= 1);
        if (vcands.length === 1) {
          const inv = vcands[0];
          updates.push({ range: `${CONFIG.TABS.CC}!I${rowNum}`, values: [[_dynamicInvoiceLink(inv.num, `${inv.num}(作廢)`)]] });
          updates.push({ range: `${CONFIG.TABS.CC}!H${rowNum}`, values: [['x']] });
          matchedInv.add(inv.num);
        }
      }
    }
    const count = updates.filter(u => u.range.includes('!I')).length;
    if (updates.length) await _batchUpdate(updates);
    log(`→ 發票配對：連結 ${count} 筆`);
    return count;
  }

  async function writeCCFromGmail(transactions, onProgress) {
    const log = m => onProgress?.(m);
    if (!transactions.length) return { written: 0, skipped: 0 };

    // 0. 讀商店分類規則（A=關鍵字, B=類別），用於自動填 G/H 欄
    //    規則同 Python write_to_sheets.py：負數→x、悠遊卡（加值/儲值）→x、類別'-'→'-'
    let rulesRows = [];
    try {
      const rd = await _get(`${CONFIG.TABS.RULES}!A:B`);
      rulesRows = (rd.values || []).slice(1)
        .map(r => [(r[0] || '').trim().toUpperCase(), (r[1] || '').trim()])
        .filter(([k]) => k);
    } catch (e) { log(`⚠ 讀取商店分類規則失敗：${e.message}，類別留空`); }

    function _lookupCategory(shop) {
      const su = shop.toUpperCase();
      for (const [kw, cat] of rulesRows) { if (su.includes(kw)) return cat; }
      return '';
    }
    function _autoShared(shop, amount, category) {
      if (amount < 0 || shop.includes('悠遊卡')) return 'x';
      if (category === '-') return '-';
      return '';
    }

    // 1. 讀既有 CC 明細 A:E，建去重 key set
    log('檢查既有 CC 明細…');
    const existing     = await _get(`${CONFIG.TABS.CC}!A:E`);
    const existingKeys = new Set(
      (existing.values || []).slice(1).map(r => {
        const date = (r[1] || '').replace(/^'/, '').replace(/\//g, '-');
        return `${r[0] || ''}|${date}|${r[3] || ''}|${parseFloat(r[4]) || 0}`;
      })
    );

    // 2. 過濾已存在的交易
    const newTxns = transactions.filter(t => {
      const date = t.txDate.replace(/\//g, '-');
      return !existingKeys.has(`${t.bank}|${date}|${t.shop}|${t.amount}`);
    });
    const skipped = transactions.length - newTxns.length;
    if (!newTxns.length) {
      log(`所有 CC 明細已存在，略過寫入（共 ${skipped} 筆）`);
      return { written: 0, skipped };
    }

    // 3. 取最後一列後 append（G=類別、H=是否共用自動填入）
    const colA    = await _get(`${CONFIG.TABS.CC}!A:A`);
    const lastRow = (colA.values || []).length;
    const rows    = newTxns.map(t => {
      const category = _lookupCategory(t.shop);
      const shared   = _autoShared(t.shop, t.amount, category);
      return [
        t.bank, "'" + t.txDate, "'" + t.entryDate,
        t.shop, t.amount, t.currency || '', category, shared, '', '', false, t.billingMonth || '',
      ];
    });
    const startRow = lastRow + 1;
    await _update(`${CONFIG.TABS.CC}!A${startRow}:L${startRow + rows.length - 1}`, rows);
    log(`→ CC 明細：新寫入 ${rows.length} 筆，略過 ${skipped} 筆`);
    return { written: rows.length, skipped };
  }

  return {
    getMonthlyData, getCreditCardImportStatus, getSettlement, getRepayments, appendMonthlyRow, invalidateMonth,
    updateMonthlyRow, deleteMonthlyRow,
    getInvoiceData, getItemData, updateItemRow,
    checkDuplicateInvoice, appendInvoiceRow, appendItemRows, appendSyntheticItemRow,
    markInvoiceImported, setInvoiceImported, appendMonthlyFromInvoice, appendMonthlyFromScan,
    upsertRepayment,
    getCCPendingData, updateCCShared, updateInvoiceShared,
    getCCAllData, linkCCToInvoice,
    getRulesData, linkPlatformToCC,
    importToMonthly,
    countRawInvoicesForMonth, writeInvoicesFromGmail, matchCCWithInvoices,
    deleteInvoiceRow, deleteItemRows,
    updateInvoiceFields, updateItemFields, updateMonthlyFields,
    getCCForInvoice, updateMonthlyGH, unlinkCC,
    findCCRowByDateAmount, resetCCImported,
    getInvoiceSheetData, getCCSheetData,
    updateCCFields,
    writeCCFromGmail,
  };
})();
