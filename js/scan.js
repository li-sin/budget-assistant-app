const Scan = (() => {
  const CATEGORIES = ['🍴', '🛒', '⛽', '📦', '🎬', '👗', '🏠', '💊'];

  let _stream  = null;
  let _rafId   = null;
  let _left    = null;  // { invNum, invDate, rand, total }
  let _right   = null;  // { storeName, items: [{name, amount}] }
  let _mode    = 'idle'; // idle | scanning | confirm

  // ── QR 解析 ──────────────────────────────────────────────────
  // 左側 QR：[invNum10][date7][rand4][sales8][total8][buyId8][sellId8][verify(base64)]:*****:品項數:...
  // 右側 QR：**[name]:[qty]:[price]:[name]:[qty]:[price]:...（純品項列表）

  function _parseLeft(text) {
    if (!/^[A-Z]{2}\d{8}/.test(text)) return null;
    const invNum  = text.slice(0, 10);
    const dateStr = text.slice(10, 17);
    const rand    = text.slice(17, 21);
    const total   = parseInt(text.slice(29, 37), 10);
    if (!invNum || !dateStr || isNaN(total)) return null;

    // 商店名：找 :*** 後解析品項，取第一個非數字欄位
    let storeName = '';
    const starIdx = text.indexOf(':*');
    if (starIdx !== -1) {
      const afterStar = text.indexOf(':', starIdx + 1);
      if (afterStar !== -1) {
        const fields = text.slice(afterStar + 1).split(':').filter(f => f !== '');
        storeName = fields.find(f => !/^\d+$/.test(f.trim())) || '';
      }
    }

    return { ..._buildInvResult(invNum, dateStr, rand, total), storeName };
  }

  function _parseRight(text) {
    // 右側 QR 以 '**' 開頭，格式：**[name]:[qty]:[price]:[name]:[qty]:[price]:...
    if (!text.startsWith('**')) return null;
    const content = text.slice(2);  // 去掉 **
    const fields  = content.split(':').filter(f => f !== '');
    // 每 3 個一組：name / qty / price
    const items = [];
    for (let i = 0; i + 2 < fields.length; i += 3) {
      const name   = fields[i].trim();
      const amount = parseInt(fields[i + 2], 10);
      if (name && !isNaN(amount)) items.push({ name, amount });
    }
    return items.length ? { items } : null;
  }

  function _buildInvResult(invNum, dateStr, rand, total) {
    const yyy  = parseInt(dateStr.slice(0, 3), 10);
    const mm   = dateStr.slice(3, 5);
    const dd   = dateStr.slice(5, 7);
    const year = yyy + 1911;
    // 發票明細 B 欄格式：YYYYMMDD
    const dateForSheet = `${year}${mm}${dd}`;
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
      if (code) _onQR(code.data);
    }
    _rafId = requestAnimationFrame(() => _drawFrame(video, canvas, ctx));
  }

  function _onQR(text) {
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
        setTimeout(() => {
          _stopCamera();
          _showConfirm();
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

  // ── 確認 Modal ────────────────────────────────────────────────
  function _showConfirm() {
    _mode = 'confirm';
    const invNum   = _left?.invNum        || '—';
    const date     = _left?.dateForSheet  || '';
    const total    = _left?.total         || 0;
    const shop     = _left?.storeName     || '';
    const items    = _right?.items        || [];
    const dateDisp = date ? `${date.slice(0,4)}-${date.slice(4,6)}-${date.slice(6,8)}` : '—';

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
          <div class="sconf-row"><span class="sconf-label">日期</span><span class="sconf-val">${dateDisp}</span></div>
          <div class="sconf-row"><span class="sconf-label">金額</span><span class="sconf-val amount-expense">$${total.toLocaleString('zh-TW')}</span></div>
          <div class="sconf-row"><span class="sconf-label">商店</span><span class="sconf-val">${shop || '—'}</span></div>

          ${items.length ? `
          <div class="section-title" style="margin-top:12px">品項明細</div>
          <div class="sconf-items">
            ${items.map(it => `
              <div class="sconf-item-row">
                <span class="sconf-item-name">${it.name}</span>
                <span class="sconf-item-amount">$${it.amount}</span>
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
            <button class="chip sconf-shared" data-shared="部分共用">部分</button>
            <button class="chip sconf-shared" data-shared="-">- 個人</button>
            <button class="chip sconf-shared" data-shared="x">x 跳過</button>
          </div>

          <label class="field-label">備註</label>
          <input type="text" id="sconf-note" class="field-input" placeholder="（選填）">

          <p id="sconf-error" class="add-error hidden"></p>
        </div>
        <div class="modal-footer">
          <button class="btn-secondary" id="sconf-cancel">取消</button>
          <button class="btn-primary" id="sconf-submit">寫入發票明細</button>
        </div>
      </div>
    `;

    el.classList.remove('hidden');

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
      const category = document.getElementById('sconf-cat').value;
        const note     = document.getElementById('sconf-note').value.trim();
      const btn = document.getElementById('sconf-submit');
      btn.disabled = true;
      btn.textContent = '寫入中…';

      const errEl = document.getElementById('sconf-error');
      errEl.classList.add('hidden');

      try {
        // 發票明細列：[carrier, date, invNum, shop, amount, status, category, shared, note, imported]
        const invoiceRow = ['掃描發票', date, invNum, shop, total, '開立', category, _shared, note, 'FALSE'];
        await Sheets.appendInvoiceRow(invoiceRow);

        // 品項明細
        if (items.length) {
          const invoiceInfo = { carrier: '掃描發票', date, invNum, shop };
          await Sheets.appendItemRows(invoiceInfo, items);
        }

        _closeConfirm();
        alert(`✓ 發票 ${invNum} 已寫入`);
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
