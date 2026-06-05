const Settings = (() => {
  let _importYear  = new Date().getFullYear();
  let _importMonth = new Date().getMonth() + 1;
  function _buildCustomChipsList() {
    const chips = NoteChips.getCustom();
    if (!chips.length) return '<p class="settings-chip-empty">無自訂標籤</p>';
    return chips.map(c =>
      `<div class="note-chip-manage-row">
        <span class="chip note-chip-tag">${c}</span>
        <button class="btn-chip-delete" data-chip="${c}">✕</button>
      </div>`
    ).join('');
  }

  function _loadCCPasswords() {
    try { return JSON.parse(localStorage.getItem('ba_cc_passwords') || '{}'); }
    catch { return {}; }
  }

  function _saveCCPasswords(obj) {
    localStorage.setItem('ba_cc_passwords', JSON.stringify(obj));
  }

  function _fmt(n) {
    const abs = '$' + Math.abs(n).toLocaleString('zh-TW');
    if (n > 0)  return `Bear 欠 Sin ${abs}`;
    if (n < 0)  return `Sin 欠 Bear ${abs}`;
    return '已結清 ✓';
  }

  async function _loadSettlement() {
    const el = document.getElementById('settings-settlement');
    if (!el) return;
    el.textContent = '…';
    try {
      const val = await Sheets.getSettlement();
      el.textContent = _fmt(val);
      el.className   = 'settings-settlement-val '
        + (val > 0 ? 'amount-expense' : val < 0 ? 'amount-income' : '');
    } catch (e) {
      if (e.message !== 'auth_expired') el.textContent = '讀取失敗';
    }
  }

  function _currentYm() {
    const { year, month } = window.AppMonth?.get() || {
      year: new Date().getFullYear(),
      month: new Date().getMonth() + 1,
    };
    return { year, month, label: `${year}-${String(month).padStart(2, '0')}` };
  }

  function _renderCardStatus(rows) {
    return rows.map(({ bank, count }) => `
      <div class="settings-bank-row" data-bank="${bank}" style="cursor:pointer">
        <span class="settings-bank-name">${bank}</span>
        <span class="settings-bank-val ${count ? '' : 'settings-bank-empty'}">
          ${count ? `${count} 筆` : '未到'}
        </span>
      </div>
    `).join('');
  }

  async function _loadCardStatus() {
    const el = document.getElementById('settings-card-status');
    const monthEl = document.getElementById('settings-card-month');
    if (!el) return;
    const { year, month, label } = _currentYm();
    if (monthEl) monthEl.textContent = label;
    el.innerHTML = '<div class="settings-bank-loading">讀取中…</div>';
    try {
      el.innerHTML = _renderCardStatus(await Sheets.getCreditCardImportStatus(year, month));
      el.querySelectorAll('.settings-bank-row[data-bank]').forEach(row => {
        row.addEventListener('click', () => {
          Settings.close();
          window.Pending?.jumpTo({ bank: row.dataset.bank });
        });
      });
    } catch (e) {
      if (e.message !== 'auth_expired') {
        el.innerHTML = '<div class="settings-bank-loading">讀取失敗</div>';
      }
    }
  }

  function _buildContent() {
    const email = Auth.getEmail() || '—';
    const issin = email === CONFIG.EMAIL_WHITELIST[0];
    return `
      <div class="modal-header">
        <span class="modal-title">⚙️ 設定</span>
        <button class="modal-close" id="settings-close">✕</button>
      </div>
      <div class="modal-body">
        <div class="section-title" style="margin-top:0">帳戶</div>
        <div class="card">
          <div class="settings-row">
            <span class="settings-label">登入帳號</span>
            <span class="settings-val">${email}</span>
          </div>
          <div class="settings-row">
            <span class="settings-label">身份</span>
            <span class="settings-val">${issin ? '🌟 Sin' : '🐨 Bear'}</span>
          </div>
        </div>

        <div class="section-title">結算</div>
        <div class="card">
          <div class="settings-row">
            <span class="settings-label">Bear 結算（累計淨額）</span>
            <button class="month-btn refresh-btn" id="settings-refresh" title="重新載入">↺</button>
          </div>
          <div id="settings-settlement" class="settings-settlement-val">…</div>
        </div>


        <div class="section-title">資料</div>
        <div class="card">
          <div class="settings-row">
            <span class="settings-label">試算表 ID</span>
            <span class="settings-val settings-mono">${CONFIG.SHEET_ID.slice(0, 16)}…</span>
          </div>
          <div class="settings-row settings-row-stack">
            <div class="settings-row-head">
              <span class="settings-label">信用卡匯入狀態</span>
              <span class="settings-val" id="settings-card-month">—</span>
            </div>
            <div id="settings-card-status" class="settings-bank-list">
              <div class="settings-bank-loading">讀取中…</div>
            </div>
          </div>
        </div>

        ${issin ? `
        <div class="section-title">資料匯入</div>
        <div class="card">
          <div class="settings-row">
            <span class="settings-label">月份</span>
            <div style="display:flex;gap:8px;align-items:center">
              <button class="month-btn" id="import-prev-m">◀</button>
              <span id="import-month-lbl"></span>
              <button class="month-btn" id="import-next-m">▶</button>
            </div>
          </div>
          <div id="import-log" class="import-log"></div>
          <div style="display:flex;gap:8px;margin-top:8px">
            <button class="btn-primary" id="download-invoices" style="flex:1">下載發票 + CC</button>
            <button class="btn-primary" id="import-run" style="flex:1">匯入月度帳本</button>
          </div>
        </div>
        <div class="section-title">CC 帳單密碼</div>
        <div class="card">
          <p class="settings-label-sub" style="margin-bottom:8px">儲存於本機，不會上傳。各家銀行 PDF 解密密碼。</p>
          ${[['台新','taishin'],['星展','dbs'],['永豐','sinopac'],['富邦','fubon']].map(([name,key]) =>
            `<div class="settings-row">
              <span class="settings-label">${name}</span>
              <input type="password" id="cc-pwd-${key}" class="field-input" style="flex:1;max-width:200px" autocomplete="off" placeholder="輸入密碼">
            </div>`
          ).join('')}
        </div>
        <div class="section-title">備註快速選項</div>
        <div class="card" id="note-chips-card">
          <div class="note-chip-manage-row">
            ${CONFIG.DEFAULT_NOTE_CHIPS.map(c => `<span class="chip note-chip-tag">${c}</span>`).join('')}
            <span class="settings-label-sub">預設</span>
          </div>
          <div id="custom-chips-list">${_buildCustomChipsList()}</div>
          <div class="note-chip-add-row">
            <input type="text" id="new-chip-input" class="field-input" placeholder="新增自訂標籤">
            <button class="btn-primary" id="new-chip-add">新增</button>
          </div>
        </div>
        ` : ''}

        <div class="settings-logout-wrap">
          <button class="btn-logout" id="settings-logout">登出</button>
        </div>
        <p class="settings-version">v${CONFIG.APP_VERSION}</p>
      </div>
    `;
  }

  function open() {
    const sheet = document.getElementById('settings-sheet');
    const modal = document.getElementById('settings-modal');
    if (!sheet || !modal) return;
    sheet.innerHTML = _buildContent();
    modal.classList.remove('hidden');

    document.getElementById('settings-close').addEventListener('click', close);
    modal.addEventListener('click', e => { if (e.target === modal) close(); });
    document.getElementById('settings-refresh').addEventListener('click', _loadSettlement);
    document.getElementById('settings-logout').addEventListener('click', () => {
      if (confirm('確定登出？')) Auth.logout();
    });

    // 備註快速選項管理（Sin Only）
    const addBtn = document.getElementById('new-chip-add');
    if (addBtn) {
      const _rebindDeletes = () => {
        document.querySelectorAll('#note-chips-card .btn-chip-delete').forEach(btn => {
          btn.addEventListener('click', () => {
            NoteChips.remove(btn.dataset.chip);
            document.getElementById('custom-chips-list').innerHTML = _buildCustomChipsList();
            _rebindDeletes();
          });
        });
      };
      addBtn.addEventListener('click', () => {
        const inp = document.getElementById('new-chip-input');
        if (NoteChips.add(inp.value)) {
          inp.value = '';
          document.getElementById('custom-chips-list').innerHTML = _buildCustomChipsList();
          _rebindDeletes();
        }
      });
      document.getElementById('new-chip-input').addEventListener('keydown', e => {
        if (e.key === 'Enter') addBtn.click();
      });
      _rebindDeletes();
    }

    // 資料匯入（Sin Only）
    const importMonthLbl = document.getElementById('import-month-lbl');
    if (importMonthLbl) {
      const _updateImportLbl = () => {
        importMonthLbl.textContent = `${_importYear}-${String(_importMonth).padStart(2,'0')}`;
      };
      _updateImportLbl();

      document.getElementById('import-prev-m').addEventListener('click', () => {
        _importMonth--;
        if (_importMonth < 1) { _importMonth = 12; _importYear--; }
        _updateImportLbl();
        document.getElementById('import-log').textContent = '';
      });
      document.getElementById('import-next-m').addEventListener('click', () => {
        _importMonth++;
        if (_importMonth > 12) { _importMonth = 1; _importYear++; }
        _updateImportLbl();
        document.getElementById('import-log').textContent = '';
      });

      // ── 下載發票 + CC：發票 CSV + 四家 CC 帳單 PDF → Sheets ──
      document.getElementById('download-invoices').addEventListener('click', async () => {
        const btn = document.getElementById('download-invoices');
        const log = document.getElementById('import-log');
        btn.disabled = true;
        btn.textContent = '下載中…';
        log.textContent = '';
        const lines = [];
        const logMsg = msg => { lines.push(msg); log.textContent = lines.join('\n'); };

        try {
          // ── 發票 ──
          logMsg('── 發票 ──');
          try {
            const { invoices, items } = await Gmail.fetchInvoicesForMonth(
              _importYear, _importMonth, msg => logMsg(msg)
            );
            if (invoices.length) {
              const written = await Sheets.writeInvoicesFromGmail(
                invoices, items, msg => logMsg(msg)
              );
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
            const txns = await Gmail.fetchCCForMonth(
              _importYear, _importMonth, _loadCCPasswords(), msg => logMsg(msg)
            );
            if (txns.length) {
              const result = await Sheets.writeCCFromGmail(txns, msg => logMsg(msg));
              logMsg(`✅ CC：新寫入 ${result.written} 筆，略過 ${result.skipped} 筆`);
            } else {
              logMsg('⚠ 無有效 CC 交易');
            }
          } catch (e) {
            logMsg(`❌ CC：${e.message}`);
          }
        } finally {
          btn.disabled = false;
          btn.textContent = '下載發票 + CC';
        }
      });

      // ── 匯入月度帳本：將發票明細 + CC 明細寫入月度帳本 ──
      document.getElementById('import-run').addEventListener('click', async () => {
        const btn = document.getElementById('import-run');
        const log = document.getElementById('import-log');
        btn.disabled = true;
        btn.textContent = '匯入中…';
        log.textContent = '';
        const lines = [];
        const logMsg = msg => { lines.push(msg); log.textContent = lines.join('\n'); };

        try {
          const result = await Sheets.importToMonthly(_importYear, _importMonth, msg => logMsg(msg));
          logMsg(`\n✅ 完成：發票 ${result.invoices} 筆，CC ${result.cc} 筆（CC 略過 ${result.skippedCC} 筆）`);
          window.Home?.reload();
        } catch (e) {
          logMsg(`❌ 失敗：${e.message}`);
        } finally {
          btn.disabled = false;
          btn.textContent = '匯入月度帳本';
        }
      });
    }

    // CC 帳單密碼（Sin Only）
    const ccPwds = _loadCCPasswords();
    ['taishin', 'dbs', 'sinopac', 'fubon'].forEach(key => {
      const inp = document.getElementById(`cc-pwd-${key}`);
      if (!inp) return;
      inp.value = ccPwds[key] || '';
      inp.addEventListener('change', () => {
        const p = _loadCCPasswords();
        p[key] = inp.value;
        _saveCCPasswords(p);
      });
    });

    _loadSettlement();
    _loadCardStatus();
  }

  function close() {
    document.getElementById('settings-modal')?.classList.add('hidden');
  }

  function init() {
    // settings 現在是 Modal，不需要 tab 初始化
  }

  return { init, open, close };
})();

window.Settings = Settings;
