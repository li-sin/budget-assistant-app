const Scan = (() => {
  const CATEGORIES = ['🍴', '🛒', '⛽', '📦', '🎬', '👗', '🏠', '💊'];

  let _stream    = null;
  let _rafId     = null;
  let _left      = null;  // { invNum, invDate, rand, total }
  let _right     = null;  // { items: [{name, amount}] }
  let _mode = 'idle'; // idle | scanning | confirm

  // ── QR 解析 ──────────────────────────────────────────────────
  // 左側 QR：[invNum10][date7][rand4][sales8][total8][buyId8][sellId8][verify(base64)]:*****:品項數:...
  // 右側 QR：**[name]:[qty]:[price]:[name]:[qty]:[price]:...（純品項列表）

  function _parseLeft(text) {
    if (!/^[A-Z]{2}\d{8}/.test(text)) return null;
    const invNum   = text.slice(0, 10);
    const dateStr  = text.slice(10, 17);
    const rand     = text.slice(17, 21);
    const total    = parseInt(text.slice(29, 37), 16);  // 含稅總計為 hex 編碼（規格書 p.5）
    const sellerId = text.slice(45, 53);                // 賣方統編（規格書固定欄位 46-53 碼）
    if (!invNum || !dateStr || isNaN(total)) return null;

    // 77碼固定欄位後，以冒號分隔：自用區:完整筆數:總筆數:編碼參數:品名:數量:單價:...
    const leftItems = [];
    let orderNote = '';  // qty=0 & price=0 的標示列（如「UBER EATS訂單」）
    const starIdx = text.indexOf(':*');
    if (starIdx !== -1) {
      const afterStar = text.indexOf(':', starIdx + 1);
      if (afterStar !== -1) {
        const fields = text.slice(afterStar + 1).split(':').filter(f => f !== '');
        // fields[0]=完整筆數, fields[1]=總筆數, fields[2]=編碼參數, fields[3+]=品名/數量/單價
        const itemFields = fields.slice(3);
        for (let i = 0; i + 2 < itemFields.length; i += 3) {
          const name  = itemFields[i].trim();
          const qty   = parseInt(itemFields[i + 1], 10);
          const price = parseInt(itemFields[i + 2], 10);
          if (name && !isNaN(qty) && !isNaN(price)) {
            if (qty === 0 && price === 0) {
              // 標示列（如「UBER EATS訂單」），取第一個當 orderNote
              if (!orderNote) orderNote = name;
            } else {
              leftItems.push({ name, qty, price, amount: qty * price });
            }
          }
        }
      }
    }

    return { ..._buildInvResult(invNum, dateStr, rand, total), sellerId, leftItems, orderNote };
  }

  function _parseRight(text) {
    // 右側 QR 以 '**' 開頭，格式：**[name]:[qty]:[price]:...（單價為十進位，規格書 p.6）
    if (!text.startsWith('**')) return null;
    const content = text.slice(2);
    const fields  = content.split(':').filter(f => f !== '');
    // 每 3 個一組：name / qty / price，金額 = qty × price
    const items = [];
    for (let i = 0; i + 2 < fields.length; i += 3) {
      const name  = fields[i].trim();
      const qty   = parseInt(fields[i + 1], 10);
      const price = parseInt(fields[i + 2], 10);
      if (name && !isNaN(qty) && !isNaN(price)) {
        items.push({ name, qty, price, amount: qty * price });
      }
    }
    // '**' 開頭即視為右側 QR（items 可為空，品項全在左側 QR 的情況）
    return { items };
  }

  function _buildInvResult(invNum, dateStr, rand, total) {
    const yyy  = parseInt(dateStr.slice(0, 3), 10);
    const mm   = dateStr.slice(3, 5);
    const dd   = dateStr.slice(5, 7);
    const year = yyy + 1911;
    const dateForSheet = `${year}-${mm}-${dd}`;
    return { invNum, dateForSheet, rand, total };
  }

  // ── 鏡頭掃描 UI ──────────────────────────────────────────────
  function _buildScanOverlay() {
    if (document.getElementById('scan-overlay')) return;
    const el = document.createElement('div');
    el.id = 'scan-overlay';
    el.className = 'scan-overlay hidden';
    el.innerHTML = `
      <div class="scan-header">
        <span class="scan-title">掃描發票 QR Code</span>
        <button class="modal-close" id="scan-close">✕</button>
      </div>
      <div class="scan-viewport">
        <video id="scan-video" autoplay playsinline muted></video>
        <div class="scan-frame"></div>
      </div>
      <div class="scan-progress">
        <span id="scan-left-status" class="scan-dot">○ 左側 QR</span>
        <span id="scan-right-status" class="scan-dot">○ 右側 QR</span>
      </div>
      <p id="scan-status" class="scan-status">對準發票，左右兩個 QR Code 都掃</p>
    `;
    document.body.appendChild(el);
    document.getElementById('scan-close').addEventListener('click', stop);
  }

  function _updateProgress() {
    const lEl = document.getElementById('scan-left-status');
    const rEl = document.getElementById('scan-right-status');
    if (lEl) lEl.textContent = (_left  ? '✓' : '○') + ' 左側 QR';
    if (rEl) rEl.textContent = (_right ? '✓' : '○') + ' 右側 QR';
    if (lEl) lEl.classList.toggle('scan-dot-done', !!_left);
    if (rEl) rEl.classList.toggle('scan-dot-done', !!_right);

    const statusEl = document.getElementById('scan-status');
    if (!statusEl) return;
    if (_left && _right)       statusEl.textContent = '✓ 掃描完成，準備確認…';
    else if (_left && !_right) statusEl.textContent = '✓ 左側已讀取，繼續掃右側 QR';
    else if (!_left && _right) statusEl.textContent = '✓ 右側已讀取，繼續掃左側 QR';
    else                       statusEl.textContent = '對準發票，左右兩個 QR Code 都掃';
  }

  // 縮小至 640px 寬再解碼，降低 CPU 負擔提升 frame rate
  const DECODE_W = 640;

  function _drawFrame(video, canvas, ctx) {
    if (!_stream || _mode !== 'scanning') return;
    if (video.readyState === video.HAVE_ENOUGH_DATA) {
      const scale   = DECODE_W / video.videoWidth;
      canvas.width  = DECODE_W;
      canvas.height = Math.round(video.videoHeight * scale);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code    = window.jsQR(imgData.data, imgData.width, imgData.height, {
        inversionAttempts: 'attemptBoth',
      });
      if (code) _onQR(code.binaryData, code.data);
    }
    _rafId = requestAnimationFrame(() => _drawFrame(video, canvas, ctx));
  }

  function _decodeQR(bytes) {
    // jsQR binaryData 可能是普通陣列（非 Uint8Array），TextDecoder 需要 BufferSource
    const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    // 先嘗試 UTF-8（fatal=true，失敗 throw），失敗改 Big5
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch {
      return new TextDecoder('big5').decode(buf);
    }
  }

  function _onQR(bytes, fallbackStr) {
    // binaryData 可能不存在（舊版 jsQR），fallback 到 code.data string
    const text = bytes ? _decodeQR(bytes) : (fallbackStr || '');
    let changed = false;

    if (!_left) {
      const parsed = _parseLeft(text);
      if (parsed) { _left = parsed; changed = true; }
    }

    if (!_right) {
      const parsed = _parseRight(text);
      if (parsed) { _right = parsed; changed = true; }
    }

    if (changed) {
      _updateProgress();
      if (_left && _right) {
        // 兩個都掃到，停止並開確認 Modal
        setTimeout(async () => {
          _stopCamera();
          const statusEl = document.getElementById('scan-status');
          if (statusEl) statusEl.textContent = '查詢商店資訊中…';
          document.getElementById('scan-overlay')?.classList.remove('hidden');
          await _showConfirm();
          document.getElementById('scan-overlay')?.classList.add('hidden');
        }, 300);
      }
    }
  }

  function _stopCamera() {
    cancelAnimationFrame(_rafId);
    _rafId = null;
    if (_stream) {
      _stream.getTracks().forEach(t => t.stop());
      _stream = null;
    }
    document.getElementById('scan-overlay')?.classList.add('hidden');
  }

  // ── ECPay API 查詢公司名稱（用賣方統編，透過 Cloudflare Worker 代理）──
  async function _fetchSellerName(sellerId) {
    if (!sellerId || !/^\d{8}$/.test(sellerId)) return null;
    try {
      const res = await fetch(`${CONFIG.INVOICE_PROXY_URL}seller?id=${sellerId}`);
      if (!res.ok) return null;
      const json = await res.json();
      return json.name || null;
    } catch {
      return null;
    }
  }

  // ── 確認 Modal ────────────────────────────────────────────────
  async function _showConfirm() {
    _mode = 'confirm';
    const invNum   = _left?.invNum       || '—';
    const date     = _left?.dateForSheet || '';   // YYYY-MM-DD
    const sellerId  = _left?.sellerId   || '';
    const total     = _left?.total      || 0;
    const orderNote = _left?.orderNote  || '';
    // 用賣方統編查經濟部公司名稱；失敗則留空讓使用者手動填
    const shop = await _fetchSellerName(sellerId) || '';
    // 合併左側品項（leftItems）與右側品項（_right.items），去除數量/單價均為 0 的標示列
    const leftItems  = (_left?.leftItems  || []).filter(it => !(it.qty === 0 && it.price === 0));
    const rightItems = _right?.items || [];
    const items = [...leftItems, ...rightItems];

    let el = document.getElementById('scan-confirm-modal');
    if (!el) {
      el = document.createElement('div');
      el.id = 'scan-confirm-modal';
      el.className = 'modal-overlay hidden';
      document.body.appendChild(el);
    }

    el.innerHTML = `
      <div class="modal-sheet">
        <div class="modal-header">
          <span class="modal-title">確認發票資訊</span>
          <button class="modal-close" id="sconf-close">✕</button>
        </div>
        <div class="modal-body">
          <div class="sconf-row"><span class="sconf-label">發票號碼</span><span class="sconf-val">${invNum}</span></div>
          <div class="sconf-row"><span class="sconf-label">日期</span><span class="sconf-val">${date || '—'}</span></div>
          <div class="sconf-row"><span class="sconf-label">金額</span><span class="sconf-val amount-expense">$${total.toLocaleString('zh-TW')}</span></div>
          <div class="sconf-row"><span class="sconf-label">商店</span><input type="text" id="sconf-shop" class="field-input" style="flex:1;margin-left:8px" value="${shop}"></div>

          ${items.length ? `
          <div class="section-title" style="margin-top:12px">品項明細</div>
          <div class="sconf-items">
            ${items.map(it => `
              <div class="sconf-item-row">
                <span class="sconf-item-name">${it.name}${it.qty > 1 ? ` ×${it.qty}` : ''}</span>
                <span class="sconf-item-amount">$${it.amount.toLocaleString('zh-TW')}</span>
              </div>`).join('')}
          </div>` : ''}

          <label class="field-label" style="margin-top:16px">類別</label>
          <div class="chip-row cat-chip-row" id="sconf-cat-chips">
            <button class="chip cat-chip active" data-cat="">✕</button>
            ${CATEGORIES.map(c => `<button class="chip cat-chip" data-cat="${c}">${c}</button>`).join('')}
          </div>
          <input type="hidden" id="sconf-cat" value="">

          <label class="field-label">是否共用</label>
          <div class="chip-row cat-chip-row">
            <button class="chip sconf-shared active" data-shared="是">是</button>
            <button class="chip sconf-shared" data-shared="否">否</button>
            <button class="chip sconf-shared" data-shared="部分">部分</button>
            <button class="chip sconf-shared" data-shared="-">- 個人</button>
            <button class="chip sconf-shared" data-shared="x">x 跳過</button>
          </div>

          <label class="field-label">備註</label>
          <input type="text" id="sconf-note" class="field-input" placeholder="（選填）" value="${orderNote}">

          <p id="sconf-error" class="add-error hidden"></p>
        </div>
        <div class="modal-footer">
          <button class="btn-secondary" id="sconf-cancel">取消</button>
          <button class="btn-primary" id="sconf-submit">寫入發票明細</button>
        </div>
      </div>
    `;

    el.classList.remove('hidden');
    NoteChips.render('sconf-note');

    // 類別 chips
    el.querySelectorAll('.cat-chip').forEach(btn => {
      btn.addEventListener('click', () => {
        el.querySelectorAll('.cat-chip').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById('sconf-cat').value = btn.dataset.cat;
      });
    });

    // 是否共用 chips
    let _shared = '是';
    el.querySelectorAll('.sconf-shared').forEach(btn => {
      btn.addEventListener('click', () => {
        el.querySelectorAll('.sconf-shared').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        _shared = btn.dataset.shared;
      });
    });

    document.getElementById('sconf-close').addEventListener('click',  _closeConfirm);
    document.getElementById('sconf-cancel').addEventListener('click', _closeConfirm);
    el.addEventListener('click', e => { if (e.target === el) _closeConfirm(); });

    document.getElementById('sconf-submit').addEventListener('click', async () => {
      const category  = document.getElementById('sconf-cat').value;
      const note      = document.getElementById('sconf-note').value.trim();
      const shopValue = document.getElementById('sconf-shop').value.trim();
      const btn       = document.getElementById('sconf-submit');
      btn.disabled    = true;
      btn.textContent = '寫入中…';

      const errEl = document.getElementById('sconf-error');
      errEl.classList.add('hidden');

      try {
        // 寫入發票明細，取得列號
        const invRowIndex = await Sheets.appendInvoiceRow(
          '掃描發票', date, invNum, shopValue, total, '開立', category, _shared, note
        );

        // 寫入品項明細，取得第一筆列號
        let firstItemRow = null;
        if (items.length) {
          const invoiceInfo = { carrier: '掃描發票', date, invNum, shop: shopValue };
          firstItemRow = await Sheets.appendItemRows(invoiceInfo, items);
        }

        // 關閉確認 Modal，進入歸屬填寫頁
        el.classList.add('hidden');
        _showAttribution({ date, invNum, shop: shopValue, total, category, note, shared: _shared, items, invRowIndex, firstItemRow });
      } catch (e) {
        errEl.textContent = '寫入失敗：' + e.message;
        errEl.classList.remove('hidden');
        btn.disabled = false;
        btn.textContent = '寫入發票明細';
      }
    });
  }

  function _closeConfirm() {
    document.getElementById('scan-confirm-modal')?.classList.add('hidden');
    _mode = 'idle';
    _left = null;
    _right = null;
  }

  // ── 歸屬填寫頁 ───────────────────────────────────────────────
  // shared: 是/否/部分/-/x；items: [{name, amount}]
  function _showAttribution({ date, invNum, shop, total, category, note, shared, items, invRowIndex, firstItemRow }) {
    let el = document.getElementById('scan-attr-modal');
    if (!el) {
      el = document.createElement('div');
      el.id = 'scan-attr-modal';
      el.className = 'modal-overlay hidden';
      document.body.appendChild(el);
    }

    // 是/否/-/x 不需填品項歸屬，直接顯示摘要並提供匯入/略過
    const needsAttribution = shared === '部分';
    const itemOwners = {};  // invNum+idx → '🌟 Sin'|'🐨 Bear'|'共用'

    const itemRows = needsAttribution && items.length
      ? items.map((it, idx) => `
        <div class="attr-item-row" data-idx="${idx}">
          <span class="attr-item-name">${it.name}</span>
          <span class="attr-item-amt">$${it.amount}</span>
          <div class="chip-row attr-owner-chips" style="margin:4px 0 0 0">
            <button class="chip attr-owner${itemOwners[idx] === '🌟 Sin' ? ' active' : ''}" data-owner="🌟 Sin">🌟 Sin</button>
            <button class="chip attr-owner${itemOwners[idx] === '🐨 Bear' ? ' active' : ''}" data-owner="🐨 Bear">🐨 Bear</button>
            <button class="chip attr-owner${itemOwners[idx] === '共用' ? ' active' : ''}" data-owner="共用">共用</button>
          </div>
        </div>`).join('')
      : `<p style="color:#8E8E93;font-size:14px;margin:8px 0">
          ${shared === '是' ? '整張發票 Sin & Bear 各半' :
            shared === '否' ? 'Sin 代墊，Bear 全欠' :
            shared === '-' ? '個人消費，不計入分帳' :
            'x 跳過，不匯入帳本'}
        </p>`;

    el.innerHTML = `
      <div class="modal-sheet">
        <div class="modal-header">
          <span class="modal-title">歸屬 & 匯入</span>
          <button class="modal-close" id="sattr-close">✕</button>
        </div>
        <div class="modal-body">
          <div class="sconf-row"><span class="sconf-label">發票</span><span class="sconf-val">${invNum}</span></div>
          <div class="sconf-row"><span class="sconf-label">商店</span><span class="sconf-val">${shop || '—'}</span></div>
          <div class="sconf-row"><span class="sconf-label">金額</span><span class="sconf-val amount-expense">$${total.toLocaleString('zh-TW')}</span></div>
          <div class="sconf-row"><span class="sconf-label">是否共用</span><span class="sconf-val">${shared}</span></div>
          ${needsAttribution ? `<div class="section-title" style="margin-top:12px">逐項歸屬</div>` : ''}
          <div id="attr-items-wrap">${itemRows}</div>
          <p id="sattr-error" class="add-error hidden"></p>
        </div>
        <div class="modal-footer">
          <button class="btn-secondary" id="sattr-skip">略過</button>
          <button class="btn-primary" id="sattr-submit">確認匯入</button>
        </div>
      </div>
    `;

    el.classList.remove('hidden');

    // 歸屬 chip 事件
    el.querySelectorAll('.attr-owner').forEach(btn => {
      btn.addEventListener('click', () => {
        const row = btn.closest('.attr-item-row');
        row.querySelectorAll('.attr-owner').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        itemOwners[parseInt(row.dataset.idx)] = btn.dataset.owner;
      });
    });

    document.getElementById('sattr-close').addEventListener('click', _closeAttribution);
    document.getElementById('sattr-skip').addEventListener('click', () => {
      _closeAttribution();
      alert(`發票 ${invNum} 已寫入，可至待處理頁面填寫歸屬後匯入。`);
    });

    document.getElementById('sattr-submit').addEventListener('click', async () => {
      const errEl = document.getElementById('sattr-error');
      errEl.classList.add('hidden');

      // 部分共用：確認所有品項都有歸屬
      if (needsAttribution) {
        const missing = items.some((_, idx) => !itemOwners[idx]);
        if (missing) {
          errEl.textContent = '請先選擇所有品項的歸屬';
          errEl.classList.remove('hidden');
          return;
        }
      }

      const btn = document.getElementById('sattr-submit');
      btn.disabled    = true;
      btn.textContent = '匯入中…';

      try {
        let sinShare, bearShare;

        if (shared === '是') {
          sinShare  = Math.floor(total / 2);
          bearShare = total - sinShare;
        } else if (shared === '否') {
          sinShare  = total;
          bearShare = 0;
        } else if (shared === '-' || shared === 'x') {
          sinShare  = total;
          bearShare = 0;
        } else if (shared === '部分') {
          // 逐項加總
          bearShare = items.reduce((sum, it, idx) => {
            const owner = itemOwners[idx];
            if (owner === '🐨 Bear') return sum + it.amount;
            if (owner === '共用')    return sum + Math.floor(it.amount / 2);
            return sum;
          }, 0);
          sinShare = total - bearShare;

          // 更新品項明細 G 欄歸屬（用寫入時取得的起始列號）
          if (firstItemRow != null) {
            for (let idx = 0; idx < items.length; idx++) {
              await Sheets.updateItemRow(firstItemRow + idx, itemOwners[idx]);
            }
          }
        }

        await Sheets.appendMonthlyFromScan({ date, shop, amount: total, shared, category, note, invNum, invRowIndex, sinShare, bearShare });

        _closeAttribution();
        alert(`✓ 發票 ${invNum} 已匯入月度帳本`);
      } catch (e) {
        errEl.textContent = '匯入失敗：' + e.message;
        errEl.classList.remove('hidden');
        btn.disabled    = false;
        btn.textContent = '確認匯入';
      }
    });
  }

  function _closeAttribution() {
    document.getElementById('scan-attr-modal')?.classList.add('hidden');
    _mode = 'idle';
    _left = null;
    _right = null;
  }

  // ── 選主後鏡頭（iOS 直接用 environment，Android 枚舉選最高解析度）──
  function _isIOS() {
    return /iP(hone|ad|od)/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }

  async function _openBestBackCamera() {
    // iOS：getUserMedia 中間不能有多餘 await，否則被視為非使用者手勢，相機全黑
    if (_isIOS()) {
      return navigator.mediaDevices.getUserMedia({
        video: { facingMode: { exact: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
    }

    // Android：先取得權限，再枚舉鏡頭選最高解析度（避免三星廣角）
    const tempStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    tempStream.getTracks().forEach(t => t.stop());

    const devices     = await navigator.mediaDevices.enumerateDevices();
    const videoDevices = devices.filter(d => d.kind === 'videoinput');

    let bestStream = null;
    let bestMaxW   = 0;
    for (const dev of videoDevices) {
      try {
        const s = await navigator.mediaDevices.getUserMedia({
          video: { deviceId: { exact: dev.deviceId }, width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: false,
        });
        const track = s.getVideoTracks()[0];
        const caps  = track.getCapabilities?.() || {};
        const maxW  = caps.width?.max || track.getSettings().width || 0;
        if (maxW > bestMaxW) {
          if (bestStream) bestStream.getTracks().forEach(t => t.stop());
          bestStream = s;
          bestMaxW   = maxW;
        } else {
          s.getTracks().forEach(t => t.stop());
        }
      } catch { /* 跳過無法開啟的鏡頭 */ }
    }

    if (!bestStream) {
      bestStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
    }
    return bestStream;
  }

  // ── 公開 API ──────────────────────────────────────────────────
  async function start() {
    _left  = null;
    _right = null;
    _mode  = 'scanning';

    _buildScanOverlay();
    const overlay = document.getElementById('scan-overlay');
    overlay.classList.remove('hidden');
    _updateProgress();

    try {
      _stream = await _openBestBackCamera();
    } catch (e) {
      document.getElementById('scan-status').textContent = '無法開啟鏡頭，請手動填寫';
      setTimeout(stop, 2000);
      return;
    }

    // 嘗試啟用連續自動對焦（Android Chrome 支援）
    const track = _stream.getVideoTracks()[0];
    if (track && typeof track.applyConstraints === 'function') {
      const caps = track.getCapabilities?.() || {};
      if (caps.focusMode?.includes?.('continuous')) {
        track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
      }
    }

    const video = document.getElementById('scan-video');
    video.srcObject = _stream;
    video.play().catch(() => {});  // iOS PWA 需要明確呼叫 play()

    let canvas = document.getElementById('scan-canvas');
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.id = 'scan-canvas';
      canvas.style.display = 'none';
      document.body.appendChild(canvas);
    }

    video.addEventListener('loadedmetadata', () => {
      video.play().catch(() => {});
      _rafId = requestAnimationFrame(() => _drawFrame(video, canvas, canvas.getContext('2d')));
    }, { once: true });
  }

  function stop() {
    _stopCamera();
    _mode = 'idle';
  }

  return { start, stop };
})();

window.Scan = Scan;
