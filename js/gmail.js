const Gmail = (() => {
  const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

  function _authHeader() {
    return { Authorization: `Bearer ${Auth.getToken()}` };
  }

  // quiet=true：403 直接拋出，不彈授權視窗（供狀態查詢用）
  async function _get(path, quiet = false) {
    const res = await fetch(`${BASE}${path}`, { headers: _authHeader() });
    if (res.status === 401) { Auth.logout(); throw new Error('auth_expired'); }
    if (res.status === 403) {
      if (quiet) throw new Error('gmail_scope_missing');
      // Token 缺少 gmail.readonly scope，自動彈出授權視窗（不需登出）
      await Auth.updateAuth();
      const retry = await fetch(`${BASE}${path}`, { headers: _authHeader() });
      if (retry.status === 403) throw new Error('gmail_scope_missing');
      if (!retry.ok) throw new Error(`Gmail API ${retry.status}`);
      return retry.json();
    }
    if (!res.ok) throw new Error(`Gmail API ${res.status}`);
    return res.json();
  }

  // 財政部彙整信於次月初寄出（e.g., 5 月發票 → 6 月初收到）
  function _searchRange(year, month) {
    const pad  = n => String(n).padStart(2, '0');
    const after = month === 12 ? { y: year + 1, m: 1 } : { y: year, m: month + 1 };
    const before = after.m === 12 ? { y: after.y + 1, m: 1 } : { y: after.y, m: after.m + 1 };
    return {
      after:  `${after.y}/${pad(after.m)}/01`,
      before: `${before.y}/${pad(before.m)}/01`,
    };
  }

  async function _searchEmails(year, month, quiet = false) {
    const { after, before } = _searchRange(year, month);
    const senders = '(from:einvoice@einvoice.nat.gov.tw OR from:m10515005@mail.ntust.edu.tw)';
    const q = `${senders} subject:消費發票彙整通知 after:${after} before:${before}`;
    const data = await _get(`/messages?q=${encodeURIComponent(q)}&maxResults=10`, quiet);
    return (data.messages || []).map(m => m.id);
  }

  // 靜默查詢：計算 Gmail 中該月份的手機條碼發票筆數，不寫入 Sheet，auth 失敗不彈視窗
  async function checkForMonth(year, month) {
    const msgIds = await _searchEmails(year, month, true);
    if (!msgIds.length) return { found: false, invoiceCount: 0 };

    let invoiceCount = 0;
    const seen = new Set();
    for (const msgId of msgIds) {
      const csv = await _downloadCsv(msgId, true);
      if (!csv) continue;
      const pq = _pqFromFilename(csv.filename);
      const { invoices } = _parseCsv(csv.text, pq);
      for (const inv of invoices) {
        if (inv.status === '開立' && !seen.has(inv.invNum)) {
          invoiceCount++;
          seen.add(inv.invNum);
        }
      }
    }
    return { found: true, invoiceCount };
  }

  function _findCsvPart(parts) {
    for (const part of parts || []) {
      if ((part.filename || '').toLowerCase().endsWith('.csv') && part.body?.attachmentId) {
        return { attachmentId: part.body.attachmentId, filename: part.filename };
      }
      const sub = _findCsvPart(part.parts);
      if (sub) return sub;
    }
    return null;
  }

  async function _downloadCsv(msgId, quiet = false) {
    const msg  = await _get(`/messages/${msgId}`, quiet);
    const info = _findCsvPart(msg.payload?.parts || []);
    if (!info) return null;
    const att   = await _get(`/messages/${msgId}/attachments/${info.attachmentId}`, quiet);
    const bytes = Uint8Array.from(atob(att.data.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    const text  = new TextDecoder('utf-8').decode(bytes).replace(/^﻿/, '');
    return { text, filename: info.filename };
  }

  function _pqFromFilename(filename) {
    const m = (filename || '').match(/(\d{2})\.csv$/i);
    if (!m) return '';
    return m[1] === '01' ? 'P' : m[1] === '02' ? 'Q' : '';
  }

  function _carrierDisplay(name, code, pq) {
    if (code.includes('/P')) return name + 'P';
    if (code.includes('/Q')) return name + 'Q';
    return pq ? name + pq : name;
  }

  const _AUTO_SKIP     = ['優食台灣'];
  const _AUTO_PERSONAL = ['優食'];
  const _FEE_KEYWORDS  = ['外送費', '服務費', '優惠'];

  function _autoShared(seller, status, itemNames) {
    if (status === '作廢') return 'x';
    if (_AUTO_SKIP.some(k => seller.includes(k))) {
      const hasFood = itemNames.length > 0 && itemNames.some(n => !_FEE_KEYWORDS.some(k => n.includes(k)));
      return hasFood ? '' : 'x';
    }
    if (_AUTO_PERSONAL.some(k => seller.includes(k))) return '-';
    return '';
  }

  function _parseCsv(text, pqSuffix) {
    const invoices = [], items = [], invMap = {};
    for (const line of text.split('\n')) {
      const f = line.split('|');
      if (f[0] === 'M' && f.length >= 9) {
        const status = f[8].trim();
        if (!['開立', '作廢'].includes(status)) continue;
        const ds = f[3].trim();
        if (ds.length !== 8) continue;
        const date = `${ds.slice(0,4)}-${ds.slice(4,6)}-${ds.slice(6,8)}`;
        const inv = {
          carrier: _carrierDisplay(f[1].trim(), f[2].trim(), pqSuffix),
          date, invNum: f[6].trim(), seller: f[5].trim(),
          amount: f[7].trim(), status,
        };
        invoices.push(inv);
        if (status === '開立') invMap[inv.invNum] = inv;
      } else if (f[0] === 'D' && f.length >= 4) {
        const p = invMap[f[1].trim()];
        if (!p) continue;
        items.push({ carrier: p.carrier, date: p.date, invNum: p.invNum,
          seller: p.seller, amount: f[2].trim(), name: f[3].trim() });
      }
    }
    return { invoices, items };
  }

  async function fetchInvoicesForMonth(year, month, onProgress) {
    const log = m => onProgress?.(m);
    const ym  = `${year}-${String(month).padStart(2, '0')}`;

    log(`搜尋 ${ym} 財政部彙整信…`);
    const msgIds = await _searchEmails(year, month);
    if (!msgIds.length) throw new Error(`找不到 ${ym} 的載具明細信（約次月初寄出）`);

    log(`找到 ${msgIds.length} 封，下載 CSV…`);
    const allInvoices = [], allItems = [], seen = new Set();

    for (const msgId of msgIds) {
      const csv = await _downloadCsv(msgId);
      if (!csv) { log(`  ⚠ 信件 ${msgId} 無 CSV 附件，略過`); continue; }
      const pq = _pqFromFilename(csv.filename);
      const { invoices, items } = _parseCsv(csv.text, pq);
      for (const inv of invoices) {
        if (!seen.has(inv.invNum)) { allInvoices.push(inv); seen.add(inv.invNum); }
      }
      allItems.push(...items);
    }

    log(`解析完成：${allInvoices.length} 張發票，${allItems.length} 筆品項`);

    // 補上 shared 欄位（根據商店名稱自動判斷）
    const itemNamesMap = {};
    for (const it of allItems) {
      (itemNamesMap[it.invNum] = itemNamesMap[it.invNum] || []).push(it.name);
    }
    for (const inv of allInvoices) {
      inv.shared = _autoShared(inv.seller, inv.status, itemNamesMap[inv.invNum] || []);
    }

    return { invoices: allInvoices, items: allItems };
  }

  return { fetchInvoicesForMonth, checkForMonth };
})();

window.Gmail = Gmail;
