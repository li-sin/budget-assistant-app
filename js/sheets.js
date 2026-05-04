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
      + '?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS';
    const res = await fetch(url, {
      method: 'POST',
      headers: { ..._authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ values }),
    });
    if (res.status === 401) { Auth.logout(); throw new Error('auth_expired'); }
    if (!res.ok) throw new Error(`Sheets API ${res.status}`);
    return res.json();
  }

  // ── 月度帳本 ──────────────────────────────────────────────────

  function _parseRow(r) {
    return {
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

  async function getMonthlyData(year, month) {
    const ym  = `${year}-${String(month).padStart(2, '0')}`;
    const key = `ba_monthly_${ym}`;
    const hit = sessionStorage.getItem(key);
    if (hit) return JSON.parse(hit);

    const data = await _get(`${CONFIG.TABS.MONTHLY}!A:L`);
    const rows = (data.values || []).slice(1);  // skip header
    const filtered = rows
      .filter(r => r[0] && r[0].startsWith(ym))
      .map(_parseRow);

    sessionStorage.setItem(key, JSON.stringify(filtered));
    return filtered;
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
    await _append(`${CONFIG.TABS.MONTHLY}!A:L`, [row]);
    const ym = (row[0] || '').slice(0, 7);
    if (ym) invalidateMonth(ym);
  }

  return { getMonthlyData, getSettlement, appendMonthlyRow, invalidateMonth };
})();
