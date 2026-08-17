// 資料下載／匯入的共用層
// 邏輯（runDownload / runImport）原本寫死在 settings.js 的 click handler 裡，
// 抽出來讓首頁 header 的 ⬇ 入口與設定頁共用同一份流程，兩邊不會走鐘。
const Importer = (() => {
  const BANKS = ['台新', '星展', '永豐', '富邦'];

  let _year  = new Date().getFullYear();
  let _month = new Date().getMonth() + 1;
  let _busy  = false;

  function loadCCPasswords() {
    try { return JSON.parse(localStorage.getItem('ba_cc_passwords') || '{}'); }
    catch { return {}; }
  }

  function saveCCPasswords(obj) {
    localStorage.setItem('ba_cc_passwords', JSON.stringify(obj));
  }

  // ── 流程邏輯（設定頁與首頁共用）─────────────────────────────

  // 發票 CSV + 四家 CC 帳單 PDF → Sheets，並做 CC↔發票配對與刷退沖銷
  async function runDownload(year, month, logMsg) {
    // ── 發票 ──
    logMsg('── 發票 ──');
    try {
      const { invoices, items } = await Gmail.fetchInvoicesForMonth(year, month, logMsg);
      if (invoices.length) {
        const written = await Sheets.writeInvoicesFromGmail(invoices, items, logMsg);
        logMsg(`✅ 新寫入 ${written.invoices} 筆發票、${written.items} 筆品項`);
      } else {
        logMsg('⚠ 無有效發票');
      }
    } catch (e) {
      if (e.message === 'gmail_scope_missing') logMsg('⚠ 發票：Gmail 授權失敗，請重試或登出後重新登入');
      else if (e.message === 'auth_cancelled')  logMsg('⚠ 發票：授權已取消');
      else logMsg(`❌ 發票：${e.message}`);
    }

    // ── CC 明細 ──
    logMsg('\n── CC 明細 ──');
    try {
      const txns = await Gmail.fetchCCForMonth(year, month, loadCCPasswords(), logMsg);
      if (txns.length) {
        const result = await Sheets.writeCCFromGmail(txns, logMsg);
        logMsg(`✅ CC：新寫入 ${result.written} 筆，略過 ${result.skipped} 筆`);
      } else {
        logMsg('⚠ 無有效 CC 交易');
      }
      // CC 解析後比對發票（金額±1、日期±3，蝦皮±10），自動填 CC I 欄連結
      await Sheets.matchCCWithInvoices(logMsg);
      // F32：刷退沖銷——同名同額的消費列一併標 x，把握不準的留給待處理頁
      await Sheets.matchCCRefunds(logMsg);
    } catch (e) {
      logMsg(`❌ CC：${e.message}`);
    } finally {
      // 下載後家數會變，讓徽章與匯入狀態重新讀
      Sheets.invalidateCCStatus();
    }
  }

  // 發票明細 + CC 明細 → 月度帳本
  async function runImport(year, month, logMsg) {
    const result = await Sheets.importToMonthly(year, month, logMsg);
    logMsg(`\n✅ 完成：發票 ${result.invoices} 筆，CC ${result.cc} 筆${result.skippedSuspect ? `（${result.skippedSuspect} 筆疑似重複待確認）` : ''}`);
    window.Home?.reload();
  }

  // ── 下載 + 匯入徽章（各 tab 共用）──────────────────────────

  // 四家到齊 + 全部匯入 → ✓✓；四家到齊但未全部匯入 → ✓；未到齊 → n/4
  async function loadBadge(el, year, month) {
    if (!el) return;
    el.textContent = '';
    el.className   = 'import-badge';
    try {
      const { done, total, overdue } = await getStatus(year, month);
      if (done === total) {
        let fullyImported = false;
        try {
          const c = await Sheets.getImportCompleteness(year, month);
          fullyImported = (c.inv.total === 0 || c.inv.imported === c.inv.total)
                       && (c.cc.total  === 0 || c.cc.imported  === c.cc.total);
        } catch { /* ignore */ }
        el.textContent = fullyImported ? '✓✓' : '✓';
        el.className   = 'import-badge import-badge-done';
      } else {
        el.textContent = `${done}/${total}`;
        el.className   = 'import-badge' + (overdue ? ' import-badge-warn' : '');
      }
    } catch {
      el.textContent = '';
    }
  }

  function _refreshAllBadges() {
    [window.Home, window.Ledger, window.Stats, window.Pending]
      .forEach(m => m?.refreshImportBadge?.());
  }

  // ── 下載狀態 ─────────────────────────────────────────────────

  // 回傳 { rows, done, total, isCurrentMonth, overdue }
  // overdue：今天已過該月 15 號仍未收齊（只在看當月時成立，翻舊月份不提醒）
  async function getStatus(year, month) {
    const rows  = await Sheets.getCreditCardImportStatus(year, month);
    const done  = rows.filter(r => r.count > 0 || r.skipped).length;
    const now   = new Date();
    const isCurrentMonth = year === now.getFullYear() && month === now.getMonth() + 1;
    return {
      rows, done, total: rows.length, isCurrentMonth,
      overdue: isCurrentMonth && now.getDate() >= 15 && done < rows.length,
    };
  }

  // ── Modal ────────────────────────────────────────────────────

  function _ymLabel() {
    return `${_year}-${String(_month).padStart(2, '0')}`;
  }

  function _build() {
    if (document.getElementById('importer-modal')) return;
    const el = document.createElement('div');
    el.id = 'importer-modal';
    el.className = 'modal-overlay hidden';
    el.innerHTML = `
      <div class="modal-sheet">
        <div class="modal-header">
          <span class="modal-title">⬇ 下載 / 匯入</span>
          <button class="modal-close" id="importer-close">✕</button>
        </div>
        <div class="modal-body">
          <div class="card">
            <div class="settings-row">
              <span class="settings-label">月份</span>
              <div style="display:flex;gap:8px;align-items:center">
                <button class="month-btn" id="importer-prev-m">◀</button>
                <span id="importer-month-lbl"></span>
                <button class="month-btn" id="importer-next-m">▶</button>
              </div>
            </div>
            <div class="settings-row settings-row-stack">
              <div class="settings-row-head">
                <span class="settings-label">帳單下載狀態</span>
                <span class="settings-val" id="importer-status-sum">—</span>
              </div>
              <div id="importer-status" class="settings-bank-list">
                <div class="settings-bank-loading">讀取中…</div>
              </div>
            </div>
            <div class="settings-row settings-row-stack">
              <div class="settings-row-head">
                <span class="settings-label">匯入狀態</span>
                <span class="settings-val" id="importer-import-sum">—</span>
              </div>
              <div id="importer-import-status" class="importer-import-grid">
                <div class="settings-bank-loading">讀取中…</div>
              </div>
            </div>
            <div id="importer-log" class="import-log"></div>
            <div style="display:flex;gap:8px;margin-top:8px">
              <button class="btn-primary" id="importer-download" style="flex:1">下載發票 + CC</button>
              <button class="btn-primary" id="importer-run" style="flex:1">匯入月度帳本</button>
            </div>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(el);

    document.getElementById('importer-close').addEventListener('click', close);
    el.addEventListener('click', e => { if (e.target === el && !_busy) close(); });
    document.getElementById('importer-prev-m').addEventListener('click', () => _shiftMonth(-1));
    document.getElementById('importer-next-m').addEventListener('click', () => _shiftMonth(1));
    document.getElementById('importer-download').addEventListener('click', _onDownload);
    document.getElementById('importer-run').addEventListener('click', _onImport);
  }

  function _shiftMonth(delta) {
    if (_busy) return;
    _month += delta;
    if (_month < 1)  { _month = 12; _year--; }
    if (_month > 12) { _month = 1;  _year++; }
    document.getElementById('importer-month-lbl').textContent = _ymLabel();
    document.getElementById('importer-log').textContent = '';
    const impEl = document.getElementById('importer-import-status');
    if (impEl) impEl.innerHTML = '<div class="settings-bank-loading">讀取中…</div>';
    _renderStatus();
  }

  async function _renderStatus() {
    const el  = document.getElementById('importer-status');
    const sum = document.getElementById('importer-status-sum');
    if (!el) return;
    el.innerHTML = '<div class="settings-bank-loading">讀取中…</div>';
    if (sum) sum.textContent = '—';
    try {
      const { rows, done, total } = await getStatus(_year, _month);
      el.innerHTML = rows.map(({ bank, count, skipped }) => {
        let valHtml, btnHtml = '';
        if (count > 0) {
          valHtml = `<span class="settings-bank-val">${count} 筆</span>`;
        } else if (skipped) {
          valHtml = `<span class="settings-bank-val settings-bank-skipped">已略過</span>`;
          btnHtml = `<button class="importer-skip-btn" data-bank="${bank}" data-action="unskip">取消</button>`;
        } else {
          valHtml = `<span class="settings-bank-val settings-bank-empty">未到</span>`;
          btnHtml = `<button class="importer-skip-btn" data-bank="${bank}" data-action="skip">略過</button>`;
        }
        return `<div class="settings-bank-row">
          <span class="settings-bank-name">${bank}</span>
          <div style="display:flex;align-items:center;gap:6px">${valHtml}${btnHtml}</div>
        </div>`;
      }).join('');
      el.querySelectorAll('.importer-skip-btn').forEach(btn => {
        btn.addEventListener('click', () => _onSkipToggle(btn.dataset.bank, btn.dataset.action));
      });
      if (sum) sum.textContent = done === total ? '✓ 四家到齊' : `${done}/${total} 家`;
    } catch (e) {
      if (e.message !== 'auth_expired') {
        el.innerHTML = '<div class="settings-bank-loading">讀取失敗</div>';
      }
    }
    _renderImportCompleteness();
  }

  async function _onSkipToggle(bank, action) {
    if (_busy) return;
    const btns = document.querySelectorAll('.importer-skip-btn');
    btns.forEach(b => b.disabled = true);
    try {
      if (action === 'skip') {
        await Sheets.skipCCBank(_year, _month, bank);
      } else {
        const rows = await Sheets.getCreditCardImportStatus(_year, _month);
        const row = rows.find(r => r.bank === bank);
        if (row?.skipRow) await Sheets.unskipCCBank(row.skipRow);
      }
      await _renderStatus();
      _refreshAllBadges();
    } catch (e) {
      alert(`操作失敗：${e.message}`);
      btns.forEach(b => b.disabled = false);
    }
  }

  async function _renderImportCompleteness() {
    const el  = document.getElementById('importer-import-status');
    const sum = document.getElementById('importer-import-sum');
    if (!el) return;
    el.innerHTML = '<div class="settings-bank-loading">讀取中…</div>';
    if (sum) sum.textContent = '—';
    try {
      const { inv, cc } = await Sheets.getImportCompleteness(_year, _month);
      const suspect = cc.suspect || 0;
      const total = inv.total + cc.total;
      const imported = inv.imported + cc.imported;
      const blocked = inv.blocked + cc.blocked;

      if (total === 0) {
        el.innerHTML = '<div class="settings-bank-loading">本月無資料</div>';
        if (sum) sum.textContent = '—';
        return;
      }

      const _row = (label, d) => {
        const sus = d.suspect || 0;
        const allDone = (d.imported + sus) === d.total && d.total > 0;
        const icon = allDone ? '✅' : (d.blocked > 0 || sus > 0) ? '⚠' : '';
        let detail = `${d.imported}/${d.total}`;
        if (sus > 0) detail += `<span class="importer-suspect">（${sus} 筆疑似重複）</span>`;
        if (d.blocked > 0) detail += `<span class="importer-blocked">（${d.blocked} 筆待填）</span>`;
        return `<div class="importer-import-row">
          <span class="importer-import-label">${label}</span>
          <span class="importer-import-val ${allDone ? 'importer-import-done' : ''}">${icon} ${detail}</span>
        </div>`;
      };

      el.innerHTML = _row('發票', inv) + _row('CC', cc);

      if (imported === total) {
        if (sum) sum.textContent = '✓ 全部匯入';
      } else {
        const ready = total - imported - blocked - suspect;
        if (sum) sum.textContent = ready > 0 ? `${ready} 筆可匯入` : suspect > 0 ? `${suspect} 筆待確認` : `${blocked} 筆待填`;
      }
    } catch (e) {
      if (e.message !== 'auth_expired') {
        el.innerHTML = '<div class="settings-bank-loading">讀取失敗</div>';
      }
    }
  }

  // 兩顆按鈕共用：跑流程期間鎖住 UI，結束後刷新狀態與首頁徽章
  async function _runWithUI(btnId, busyLabel, fn) {
    const btn = document.getElementById(btnId);
    const log = document.getElementById('importer-log');
    const other = document.getElementById(btnId === 'importer-download' ? 'importer-run' : 'importer-download');
    const label = btn.textContent;
    _busy = true;
    btn.disabled = other.disabled = true;
    btn.textContent = busyLabel;
    log.textContent = '';
    const lines = [];
    const logMsg = msg => { lines.push(msg); log.textContent = lines.join('\n'); };

    try {
      await fn(logMsg);
    } catch (e) {
      logMsg(`❌ 失敗：${e.message}`);
    } finally {
      _busy = false;
      btn.disabled = other.disabled = false;
      btn.textContent = label;
      await _renderStatus();
      _refreshAllBadges();
    }
  }

  function _onDownload() {
    return _runWithUI('importer-download', '下載中…', logMsg => runDownload(_year, _month, logMsg));
  }

  function _onImport() {
    return _runWithUI('importer-run', '匯入中…', logMsg => runImport(_year, _month, logMsg));
  }

  function open(year, month) {
    _build();
    if (year)  _year  = year;
    if (month) _month = month;
    document.getElementById('importer-month-lbl').textContent = _ymLabel();
    document.getElementById('importer-log').textContent = '';
    document.getElementById('importer-modal').classList.remove('hidden');
    _renderStatus();
  }

  function close() {
    document.getElementById('importer-modal')?.classList.add('hidden');
  }

  return { open, close, runDownload, runImport, getStatus, loadBadge, loadCCPasswords, saveCCPasswords, BANKS };
})();

window.Importer = Importer;
