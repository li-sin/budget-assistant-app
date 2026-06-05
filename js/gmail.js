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
  // 結果快取於 sessionStorage（TTL 30 分鐘），避免每次開設定都重新下載 CSV
  async function checkForMonth(year, month) {
    const ym      = `${year}-${String(month).padStart(2, '0')}`;
    const cacheKey = `ba_gmail_check_${ym}`;
    const hit      = sessionStorage.getItem(cacheKey);
    if (hit) {
      const { ts, result } = JSON.parse(hit);
      if (Date.now() - ts < 30 * 60 * 1000) return result;
    }

    const msgIds = await _searchEmails(year, month, true);
    if (!msgIds.length) {
      const result = { found: false, invoiceCount: 0 };
      sessionStorage.setItem(cacheKey, JSON.stringify({ ts: Date.now(), result }));
      return result;
    }

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
    const result = { found: true, invoiceCount };
    sessionStorage.setItem(cacheKey, JSON.stringify({ ts: Date.now(), result }));
    return result;
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

  // ── CC 帳單 Gmail 下載 + PDF 解析 ───────────────────────────────

  const _CC_BANKS = [
    { bank: '台新', pwdKey: 'taishin', q: 'from:webmaster@bhurecv.taishinbank.com.tw' },
    { bank: '星展', pwdKey: 'dbs',     q: 'from:eservicetw@dbs.com' },
    { bank: '永豐', pwdKey: 'sinopac', q: 'from:ebillservice@newebill.banksinopac.com.tw' },
    { bank: '富邦', pwdKey: 'fubon',   q: 'from:rs@cf.taipeifubon.com.tw has:attachment' },
  ];

  function _findPdfPart(parts) {
    for (const part of parts || []) {
      const mime  = (part.mimeType || '').toLowerCase();
      const fname = (part.filename || '').toLowerCase();
      if ((mime.includes('pdf') || fname.endsWith('.pdf')) && part.body?.attachmentId) {
        return { attachmentId: part.body.attachmentId, filename: part.filename };
      }
      const sub = _findPdfPart(part.parts);
      if (sub) return sub;
    }
    return null;
  }

  function _extractYearMonth(subject) {
    // 西元年 YYYY年M月
    let m = subject.match(/(\d{4})年(\d{1,2})月/);
    if (m) return { year: parseInt(m[1]), month: parseInt(m[2]) };
    // 民國年 YYY年M月（e.g. 115年5月 → 2026年5月）
    m = subject.match(/(\d{3})年(\d{1,2})月/);
    if (m) return { year: parseInt(m[1]) + 1911, month: parseInt(m[2]) };
    return null;
  }

  function _mergeContinuationLines(lines) {
    const dateRe = /^\d{2,4}\//;
    const merged = [];
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      if (dateRe.test(t)) { merged.push(t); }
      else if (merged.length) { merged[merged.length - 1] += ' ' + t; }
    }
    return merged;
  }

  async function _extractPdfText(pdfBytes, password) {
    if (typeof pdfjsLib === 'undefined') throw new Error('PDF.js 未載入');
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    const pdf = await pdfjsLib.getDocument({ data: pdfBytes, password: password || '' }).promise;
    const pageLines = [];
    for (let pg = 1; pg <= pdf.numPages; pg++) {
      const page    = await pdf.getPage(pg);
      const content = await page.getTextContent();
      const items   = content.items.filter(i => i.str && i.str.trim());
      if (!items.length) continue;
      // Sort top-to-bottom (Y descending in PDF coords), then left-to-right
      items.sort((a, b) => {
        const dy = b.transform[5] - a.transform[5];
        return Math.abs(dy) > 5 ? dy : a.transform[4] - b.transform[4];
      });
      // Group into lines with Y tolerance 5
      const groups = [];
      for (const item of items) {
        const y    = item.transform[5];
        const last = groups[groups.length - 1];
        if (last && Math.abs(y - last.y) <= 5) { last.items.push(item); }
        else { groups.push({ y, items: [item] }); }
      }
      for (const g of groups) {
        g.items.sort((a, b) => a.transform[4] - b.transform[4]);
        // 根據相鄰 item 座標間距決定是否補空格，還原 PDF 視覺排版
        let line = '';
        for (let i = 0; i < g.items.length; i++) {
          const cur = g.items[i];
          if (i > 0) {
            const prev    = g.items[i - 1];
            const prevEnd = prev.transform[4] + (prev.width || 0);
            if (cur.transform[4] - prevEnd > 1) line += ' ';
          }
          line += cur.str;
        }
        const trimmed = line.trim();
        if (trimmed) pageLines.push(trimmed);
      }
    }
    return pageLines.join('\n');
  }

  // ── 四家銀行 parser（Python budget_parsers.py 的 JS 移植）──────

  function _parseTaishin(allText) {
    const si = allText.indexOf('下列消費明細');
    const ei = allText.indexOf('本年度截至本期');
    if (si === -1) return [];
    const section  = ei !== -1 ? allText.slice(si, ei) : allText.slice(si);
    const lines    = _mergeContinuationLines(section.split('\n'));
    const pForeign = /^(\d{3}\/\d{2}\/\d{2})\s+(\d{3}\/\d{2}\/\d{2})\s+(.+)\s+(-?\d+(?:\.\d+)?)\s+([A-Z]{2,3})$/;
    const pTwd     = /^(\d{3}\/\d{2}\/\d{2})\s+(\d{3}\/\d{2}\/\d{2})\s+(.+)\s+(-?\d{1,3}(?:,\d{3})*)$/;
    const txns = [];
    for (const line of lines) {
      if (line.includes('自動轉帳扣繳')) continue;
      const m = line.match(pForeign) || line.match(pTwd);
      if (!m) continue;
      const roc = m[1], yr = parseInt(roc.split('/')[0]) + 1911;
      txns.push({
        bank: '台新', txDate: `${yr}/${roc.slice(4)}`,
        entryDate: `${parseInt(m[2].split('/')[0]) + 1911}/${m[2].slice(4)}`,
        shop: m[3].trim(), amount: parseFloat(m[4].replace(/,/g, '')),
        currency: m[5] || 'TWD',
      });
    }
    return txns;
  }

  function _parseDbs(allText) {
    const si = allText.indexOf('您本期的消費明細如下');
    const ei = allText.indexOf('注意事項');
    if (si === -1) return [];
    const section = ei !== -1 ? allText.slice(si, ei) : allText.slice(si);
    const lines   = _mergeContinuationLines(section.split('\n'));
    const p       = /^(\d{4}\/\d{2}\/\d{2})\s+(\d{4}\/\d{2}\/\d{2})\s+(.+?)\s+(-?\d{1,3}(?:,\d{3})*)$/;
    const txns = [];
    for (const line of lines) {
      const m = line.match(p);
      if (!m) continue;
      const shop = m[3].trim()
        .replace(/\s*\/\s*[A-Z]{2}\s+\S+$/, '')
        .replace(/\s*\/\s*[A-Z]{2}.*$/, '')
        .trim();
      txns.push({
        bank: '星展', txDate: m[1], entryDate: m[2],
        shop, amount: parseFloat(m[4].replace(/,/g, '')), currency: 'TWD',
      });
    }
    return txns;
  }

  function _parseSinopac(allText, year) {
    let si = allText.indexOf('消費日 入帳\n起息日');
    if (si === -1) si = allText.indexOf('消費日 入帳');
    const ei = allText.indexOf('您的正卡，本期應繳金額合計');
    if (si === -1) return [];
    const section = ei !== -1 ? allText.slice(si, ei) : allText.slice(si);
    const lines   = _mergeContinuationLines(section.split('\n'));
    const SKIP    = ['豐點', '回饋', '折抵', '自扣', '點數'];
    const p = /^(\d{2}\/\d{2})\s+(\d{2}\/\d{2})\s+(\d{4})\s+(?:[A-Z]{1,3}-\s+)?(.+?)\s+(-?\d{1,3}(?:,\d{3})*)$/;
    const txns = [];
    for (const line of lines) {
      const m = line.match(p);
      if (!m) continue;
      const shop = m[4].trim();
      if (SKIP.some(k => shop.includes(k))) continue;
      txns.push({
        bank: '永豐', txDate: `${year}/${m[1]}`, entryDate: `${year}/${m[2]}`,
        shop, amount: parseFloat(m[5].replace(/,/g, '')), currency: 'TWD',
      });
    }
    return txns;
  }

  function _parseFubon(allText) {
    const si = allText.indexOf('消費日期 消費說明');
    if (si === -1) return [];
    const eis = ['本期應繳金額', '您本期循環信用年利率']
      .map(marker => allText.indexOf(marker, si)).filter(i => i !== -1);
    const ei      = eis.length ? Math.min(...eis) : -1;
    const section = ei !== -1 ? allText.slice(si, ei) : allText.slice(si);
    const lines   = _mergeContinuationLines(section.split('\n'));
    const SKIP    = ['前期應繳', '本期應繳', '自動扣繳', '退款', '上期'];
    const p = /^(\d{3}\/\d{2}\/\d{2})\s+(.+?)\s+(\d{3}\/\d{2}\/\d{2})(?:\s+\S+\/\S+\s+\S+)?(?:\s+[A-Z]{2,3})?\s+(-?\d{1,3}(?:,\d{3})*)$/;
    const txns = [];
    for (const line of lines) {
      const m = line.match(p);
      if (!m) continue;
      const desc = m[2].trim();
      if (SKIP.some(k => desc.includes(k))) continue;
      const yr1 = parseInt(m[1].split('/')[0]) + 1911;
      const yr2 = parseInt(m[3].split('/')[0]) + 1911;
      txns.push({
        bank: '富邦', txDate: `${yr1}/${m[1].slice(4)}`, entryDate: `${yr2}/${m[3].slice(4)}`,
        shop: desc, amount: parseFloat(m[4].replace(/,/g, '')), currency: 'TWD',
      });
    }
    return txns;
  }

  // ── 主進入點：搜尋 Gmail → 下載 PDF → 解析 → 回傳交易清單 ──────

  async function fetchCCForMonth(year, month, passwords, onProgress) {
    const log      = m => onProgress?.(m);
    const allTxns  = [];
    const billingM = `${year}-${String(month).padStart(2, '0')}`;

    for (const cfg of _CC_BANKS) {
      log(`搜尋 ${cfg.bank} ${billingM} 帳單…`);
      let msgs;
      try {
        const data = await _get(`/messages?q=${encodeURIComponent(cfg.q)}&maxResults=12`);
        msgs = (data.messages || []).map(m => m.id);
      } catch (e) {
        log(`  ⚠ ${cfg.bank}：搜尋失敗 — ${e.message}`); continue;
      }
      if (!msgs.length) { log(`  ⚠ ${cfg.bank}：找不到帳單信件`); continue; }

      // 逐封取 Subject，找符合年月的信
      let pdfBytes = null, matchedYear = year;
      for (const msgId of msgs) {
        const meta = await _get(`/messages/${msgId}?format=metadata&metadataHeaders=Subject`);
        const subj = (meta.payload?.headers || [])
          .find(h => h.name.toLowerCase() === 'subject')?.value || '';
        const ym = _extractYearMonth(subj);
        if (!ym || ym.year !== year || ym.month !== month) continue;

        const full    = await _get(`/messages/${msgId}`);
        const pdfInfo = _findPdfPart(full.payload?.parts || []);
        if (!pdfInfo) continue;

        const att = await _get(`/messages/${msgId}/attachments/${pdfInfo.attachmentId}`);
        pdfBytes    = Uint8Array.from(
          atob(att.data.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)
        );
        matchedYear = ym.year;
        break;
      }

      if (!pdfBytes) {
        log(`  ⚠ ${cfg.bank}：找不到 ${billingM} 帳單`); continue;
      }

      log(`  解密並提取文字…`);
      let allText;
      try {
        allText = await _extractPdfText(pdfBytes, passwords[cfg.pwdKey] || '');
      } catch (e) {
        const msg = e.name === 'PasswordException'
          ? `密碼錯誤或未設定（請在設定頁填入 ${cfg.bank} 密碼）`
          : `PDF 解析失敗 — ${e.message}`;
        log(`  ❌ ${cfg.bank}：${msg}`); continue;
      }

      let txns;
      if (cfg.pwdKey === 'taishin')      txns = _parseTaishin(allText);
      else if (cfg.pwdKey === 'dbs')     txns = _parseDbs(allText);
      else if (cfg.pwdKey === 'sinopac') txns = _parseSinopac(allText, matchedYear);
      else                               txns = _parseFubon(allText);

      txns.forEach(t => { t.billingMonth = billingM; });
      log(`  ✓ ${cfg.bank}：解析 ${txns.length} 筆`);
      allTxns.push(...txns);
    }
    return allTxns;
  }

  return { fetchInvoicesForMonth, checkForMonth, fetchCCForMonth };
})();

window.Gmail = Gmail;
