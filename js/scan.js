const Scan = (() => {
  let _stream = null;
  let _rafId  = null;
  let _onFill = null;  // callback(amount, storeName)

  // ── QR Code 解析（財政部左側 / 右側 QR 格式）────────────────────
  // 左側格式：:[invNum10]:[yyyMMdd7]:[rand4]:[salesAmt]:[totalAmt]:...
  // 右側格式：[invNum10][yyyMMdd7][rand4][salesAmt8][totalAmt8][buyId8][sellId8][verify24]:*****:[itemCount]:...
  function _parseInvoiceQR(text) {
    // 左側 QR：以 ':' 開頭
    if (text.startsWith(':')) {
      const parts = text.split(':');
      if (parts.length < 6) return null;
      const invNum  = parts[1];
      const dateStr = parts[2];
      const rand    = parts[3];
      const total   = parseInt(parts[5], 10);
      if (!invNum || !dateStr || isNaN(total)) return null;
      return _buildResult(invNum, dateStr, rand, total);
    }

    // 右側 QR：[invNum10][date7][rand4][sales8][total8][buyId8][sellId8][verify(base64)]:*****:[itemCount]:[name]:[qty]:[price]:...
    if (/^[A-Z]{2}\d{8}/.test(text)) {
      const invNum  = text.slice(0, 10);
      const dateStr = text.slice(10, 17);
      const rand    = text.slice(17, 21);
      const total   = parseInt(text.slice(29, 37), 10);
      if (!invNum || !dateStr || isNaN(total)) return null;
      const result = _buildResult(invNum, dateStr, rand, total);

      // verify 為 base64 長度不固定，用 ':' 定位品項區段
      // 格式：...verify:*****:[itemCount]:[name1]:[qty1]:[price1]:...
      // 找第一個 ':' 後面跟著 '*' 的位置（即 :*** 區段）
      const starIdx = text.indexOf(':*');
      if (starIdx !== -1) {
        // 跳過 :***** 再找下一個 ':'
        const afterStar = text.indexOf(':', starIdx + 1);
        if (afterStar !== -1) {
          // afterStar 之後：[itemCount]:[name1]:[qty1]:[price1]:...
          // afterStar 之後：[itemCount]:[unknown]:[qty1]:[name1]:[unitPrice1]:[price1]:...
          // 實際格式（從財政部規格）：itemCount:sellerName?:itemCount2:name:qty:price
          // 用範例反推：8:13:1:UBER EATS訂單:0:0:餐-雙層牛肉3PO:1:82
          // → 跳過純數字欄位，取第一個非純數字的欄位作為商店/品項名
          const itemsPart = text.slice(afterStar + 1);
          const fields = itemsPart.split(':');
          const nameField = fields.find(f => f && !/^\d+$/.test(f.trim()));
          if (nameField) {
            result.storeName = nameField.trim();
          }
        }
      }
      return result;
    }

    return null;
  }

  function _buildResult(invNum, dateStr, rand, total) {
    const yyy  = parseInt(dateStr.slice(0, 3), 10);
    const mm   = dateStr.slice(3, 5);
    const dd   = dateStr.slice(5, 7);
    const year = yyy + 1911;
    const invDate = `${year}.${mm}.${dd}`;
    return { invNum, invDate, rand, total };
  }

  // ── 財政部 API（透過 Cloudflare Worker）───────────────────────
  async function _queryInvoice({ invNum, invDate, rand }) {
    const body = new URLSearchParams({
      version:      '0.5',
      type:         'Barcode',
      action:       'qryInvDetail',
      generation:   'V2',
      invNum,
      invDate,
      randomNumber: rand,
    }).toString();

    const resp = await fetch(CONFIG.INVOICE_PROXY_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!resp.ok) throw new Error(`Worker HTTP ${resp.status}`);
    return resp.json();
  }

  // ── 鏡頭 UI ───────────────────────────────────────────────────
  function _buildOverlay() {
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
      <p id="scan-status" class="scan-status">對準發票左側 QR Code</p>
    `;
    document.body.appendChild(el);
    document.getElementById('scan-close').addEventListener('click', stop);
  }

  function _drawFrame(video, canvas, ctx) {
    if (!_stream) return;
    if (video.readyState === video.HAVE_ENOUGH_DATA) {
      canvas.width  = video.videoWidth;
      canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0);
      const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code    = window.jsQR(imgData.data, imgData.width, imgData.height, {
        inversionAttempts: 'dontInvert',
      });
      if (code) {
        _onQR(code.data);
        return;
      }
    }
    _rafId = requestAnimationFrame(() => _drawFrame(video, canvas, ctx));
  }

  async function _onQR(text) {
    // 暫停掃描
    cancelAnimationFrame(_rafId);
    _setStatus('解析中…');

    const parsed = _parseInvoiceQR(text);
    if (!parsed) {
      _setStatus('不是發票 QR Code，請對準左側');
      _rafId = requestAnimationFrame(() => {
        const v = document.getElementById('scan-video');
        const c = document.getElementById('scan-canvas');
        _drawFrame(v, c, c.getContext('2d'));
      });
      return;
    }

    // 右側 QR 已含商店名，直接回填不需呼叫 API
    if (parsed.storeName) {
      stop();
      if (_onFill) _onFill(parsed.total, parsed.storeName);
      return;
    }

    // 左側 QR：呼叫財政部 API 取商店名
    try {
      const data = await Promise.race([
        _queryInvoice(parsed),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000)),
      ]);

      let storeName = '';
      let amount    = parsed.total;

      if (data.code === '200' && data.invDetail) {
        storeName = data.invDetail.sellerName || '';
        amount    = parseInt(data.invDetail.amount, 10) || parsed.total;
      }

      stop();
      if (_onFill) _onFill(amount, storeName);

    } catch (e) {
      const msg = e.message === 'timeout' ? 'API 逾時，已帶入 QR 金額' : `查詢失敗：${e.message}`;
      _setStatus(msg);
      setTimeout(() => {
        stop();
        if (_onFill) _onFill(parsed.total, '');
      }, 1500);
    }
  }

  function _setStatus(msg) {
    const el = document.getElementById('scan-status');
    if (el) el.textContent = msg;
  }

  // ── 公開 API ──────────────────────────────────────────────────
  async function start(onFill) {
    _onFill = onFill;
    _buildOverlay();

    const overlay = document.getElementById('scan-overlay');
    overlay.classList.remove('hidden');
    _setStatus('對準發票左側 QR Code');

    try {
      _stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
        audio: false,
      });
    } catch (e) {
      _setStatus('無法開啟鏡頭，請手動填寫');
      setTimeout(stop, 2000);
      return;
    }

    const video  = document.getElementById('scan-video');
    video.srcObject = _stream;

    // 建立離屏 canvas（不插入 DOM）
    let canvas = document.getElementById('scan-canvas');
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.id = 'scan-canvas';
      canvas.style.display = 'none';
      document.body.appendChild(canvas);
    }

    video.addEventListener('loadedmetadata', () => {
      _rafId = requestAnimationFrame(() => _drawFrame(video, canvas, canvas.getContext('2d')));
    }, { once: true });
  }

  function stop() {
    cancelAnimationFrame(_rafId);
    _rafId = null;
    if (_stream) {
      _stream.getTracks().forEach(t => t.stop());
      _stream = null;
    }
    const overlay = document.getElementById('scan-overlay');
    if (overlay) overlay.classList.add('hidden');
  }

  return { start, stop };
})();

window.Scan = Scan;
