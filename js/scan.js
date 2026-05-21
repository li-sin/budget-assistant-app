const Scan = (() => {
  const CATEGORIES = ['🍴', '🛒', '⛽', '📦', '🎬', '👗', '🏠', '💊', '🧋'];
  const INVOICE_QUERY_URL = 'https://www.einvoice.nat.gov.tw/portal/btc/audit/btc601w/search';
  const IOS_SAFARI_QUERY_URL = `x-safari-${INVOICE_QUERY_URL}`;
  const ANDROID_CHROME_QUERY_URL = `intent://${INVOICE_QUERY_URL.replace(/^https?:\/\//, '')}#Intent;scheme=https;package=com.android.chrome;end`;

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

  function _escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function _sumItems(items) {
    return items.reduce((sum, it) => sum + (Number(it.amount) || 0), 0);
  }

  function _missingAmount(total, items) {
    return Math.round((Number(total) || 0) - _sumItems(items));
  }

  function _formatQueryDate(date) {
    return date ? date.replace(/-/g, '/') : '';
  }

  function _isAndroid() {
    return /Android/i.test(navigator.userAgent);
  }

  function _queryLaunchLinks() {
    if (_isIOS()) {
      return [{ label: '用 Safari 開啟', href: IOS_SAFARI_QUERY_URL }];
    }
    if (_isAndroid()) {
      return [{ label: '用 Chrome 開啟', href: ANDROID_CHROME_QUERY_URL }];
    }

    return [{ label: '開啟查詢頁', href: INVOICE_QUERY_URL, target: '_blank', rel: 'noopener noreferrer external' }];
  }

  async function _copyText(value, btn) {
    const text = String(value ?? '');
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      if (btn) {
        const oldText = btn.textContent;
        btn.textContent = '已複製';
        setTimeout(() => { btn.textContent = oldText; }, 1000);
      }
    } catch {
      alert(`複製失敗，請手動複製：${text}`);
    }
  }

  function _normalizeOcrText(text) {
    return String(text || '')
      .replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
      .replace(/[，,]/g, '')
      .replace(/[：]/g, ':')
      .replace(/[−–—ー－]/g, '-')
      .replace(/(^|[\s$])一\s*(?=\d)/g, '$1-')
      .replace(/-\s+(?=\d)/g, '-')
      .replace(/[|｜]/g, ' ');
  }

  function _compactOcrName(name) {
    return String(name || '')
      .replace(/\s+/g, '')
      .replace(/^[\s\-:：]+/, '')
      .replace(/[\s\-:：]+$/, '')
      .replace(/[^\p{L}\p{N}（）()\-_.#]/gu, '')
      .trim();
  }

  function _isOcrDetailTitle(line) {
    return /消費明細/.test(line.replace(/\s+/g, ''));
  }

  function _isOcrTableHeader(line) {
    const compact = line.replace(/\s+/g, '');
    return /品名/.test(compact) &&
      (/數量|数量/.test(compact)) &&
      (/單價|单價|單价|单价/.test(compact)) &&
      /金額|金额/.test(compact);
  }

  function _extractOcrExpectedCount(lines, detailIdx, headerIdx) {
    const start = Math.max(0, detailIdx >= 0 ? detailIdx - 1 : 0);
    const end = Math.min(lines.length, headerIdx >= 0 ? headerIdx + 1 : start + 6);
    const scope = lines.slice(start, end).join(' ');
    const match = scope.match(/共\s*(\d{1,3})\s*(?:筆|笔|莖|隻)?/);
    return match ? parseInt(match[1], 10) : null;
  }

  function _isOcrTableEnd(line) {
    return /頁\s*\/\s*顯示/.test(line) ||
      /顯示/.test(line) ||
      /上一頁|下一頁|列印/.test(line) ||
      /^\d+\s*(頁|筆)$/.test(line);
  }

  function _extractOcrDetailLines(text) {
    const lines = _normalizeOcrText(text).split(/\r?\n/)
      .map(line => line.replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    const detailIdx = lines.findIndex(_isOcrDetailTitle);
    const headerIdx = lines.findIndex((line, idx) => idx >= Math.max(detailIdx, 0) && _isOcrTableHeader(line));
    const expectedCount = _extractOcrExpectedCount(lines, detailIdx, headerIdx);
    if (detailIdx < 0) {
      return { expectedCount, lines: [], foundTable: false };
    }

    const startIdx = headerIdx >= 0 ? headerIdx + 1 : detailIdx + 1;
    const sliced = lines.slice(startIdx);
    const endIdx = sliced.findIndex(_isOcrTableEnd);

    return {
      expectedCount,
      lines: (endIdx >= 0 ? sliced.slice(0, endIdx) : sliced)
        .filter(line => !/^共\s*\d{1,3}\s*(?:筆|笔)?$/.test(line) && !_isOcrTableHeader(line)),
      foundTable: headerIdx >= 0 || sliced.some(line => _parseOcrTableRow(line, Number.MAX_SAFE_INTEGER)),
    };
  }

  function _parseOcrTableRow(line, total) {
    const clean = line.replace(/\s+/g, ' ').trim();
    const row = clean.match(/^(.+?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*$/);
    if (!row) return null;

    const name = _compactOcrName(row[1]);
    const qty = Math.round(parseFloat(row[2]));
    const price = Math.round(parseFloat(row[3]));
    const amount = Math.round(parseFloat(row[4]));
    if (!name || /^\d+$/.test(name)) return null;
    if (!Number.isFinite(qty) || qty === 0 || Math.abs(qty) > 999) return null;
    if (!Number.isFinite(price) || price === 0 || Math.abs(price) > Math.max(Math.abs(total) * 2, 99999)) return null;
    if (!Number.isFinite(amount) || amount === 0 || Math.abs(amount) > Math.max(Math.abs(total) * 2, 99999)) return null;
    return { name, qty, price, amount, manual: true, ocr: true };
  }

  function _parseOcrItems(text, total) {
    const { expectedCount, lines, foundTable } = _extractOcrDetailLines(text);
    const seen = new Set();
    const result = [];

    lines.forEach(line => {
      const item = _parseOcrTableRow(line, total);
      if (!item) return;
      const key = `${item.name}|${item.qty}|${item.price}|${item.amount}`;
      if (seen.has(key)) return;
      seen.add(key);
      result.push(item);
    });

    return { items: result, expectedCount, foundTable };
  }

  function _loadImageForOcr(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('圖片讀取失敗'));
      };
      img.src = url;
    });
  }

  async function _preprocessOcrImage(file, mode = 'binary') {
    const img = await _loadImageForOcr(file);
    const maxSide = 2600;
    const baseScale = mode === 'legacy' ? 2 : 2.4;
    const naturalW = img.naturalWidth || img.width;
    const naturalH = img.naturalHeight || img.height;
    const scale = Math.min(baseScale, maxSide / Math.max(naturalW, naturalH));
    const width = Math.max(1, Math.round(naturalW * scale));
    const height = Math.max(1, Math.round(naturalH * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('無法建立 OCR 圖片處理器');

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, width, height);

    const imageData = ctx.getImageData(0, 0, width, height);
    const data = imageData.data;
    for (let i = 0; i < data.length; i += 4) {
      const gray = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
      const contrast = mode === 'legacy' ? 1.45 : (mode === 'binary-strong' ? 1.55 : 1.35);
      const contrasted = Math.max(0, Math.min(255, (gray - 128) * contrast + 128));
      const threshold = mode === 'binary-strong' ? 168 : 176;
      const value = mode === 'soft' ? contrasted : (contrasted > threshold ? 255 : 0);
      data[i] = value;
      data[i + 1] = value;
      data[i + 2] = value;
    }
    ctx.putImageData(imageData, 0, 0);
    return canvas;
  }

  async function _readClipboardImage() {
    if (!navigator.clipboard?.read) {
      throw new Error('此瀏覽器不支援直接貼上圖片，請改用上傳截圖');
    }
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const imageType = item.types.find(type => type.startsWith('image/'));
      if (imageType) return item.getType(imageType);
    }
    throw new Error('剪貼簿沒有圖片，請先複製截圖或改用上傳截圖');
  }

  async function _readClipboardText() {
    if (!navigator.clipboard?.readText) {
      throw new Error('此瀏覽器不支援直接貼上文字，請手動改用上傳截圖');
    }
    const text = await navigator.clipboard.readText();
    if (!String(text || '').trim()) throw new Error('剪貼簿沒有文字，請先複製明細文字');
    return text;
  }

  function _scoreOcrCandidate(candidate, total) {
    const parsed = candidate.parsed || { items: [] };
    let score = parsed.foundTable ? 30 : 0;
    score += Math.min(parsed.items.length, 20) * 5;
    if (Number.isInteger(parsed.expectedCount)) {
      if (parsed.items.length === parsed.expectedCount) score += 80;
      else score -= Math.abs(parsed.items.length - parsed.expectedCount) * 12;
    }
    const itemTotal = _sumItems(parsed.items);
    if (total && itemTotal === total) score += 25;
    score += Math.max(0, Math.min(100, Number(candidate.confidence) || 0)) / 4;
    return score;
  }

  async function _recognizeOcrSource(source, label, total, onStatus) {
    onStatus?.(`OCR ${label}辨識中…`);
    const res = await window.Tesseract.recognize(source, 'chi_tra+eng', {
      tessedit_pageseg_mode: '6',
      preserve_interword_spaces: '1',
      user_defined_dpi: '300',
      logger: msg => {
        if (msg.status === 'recognizing text') {
          onStatus?.(`OCR ${label}${Math.round((msg.progress || 0) * 100)}%`);
        } else if (msg.status) {
          onStatus?.(`OCR ${label}${msg.status}`);
        }
      },
    });
    const text = res?.data?.text || '';
    return {
      label: label.trim() || '原圖',
      text,
      confidence: res?.data?.confidence,
      parsed: _parseOcrItems(text, total),
    };
  }

  async function _runOcr(file, total, onStatus) {
    if (!window.Tesseract?.recognize) {
      throw new Error('OCR 套件尚未載入，請確認網路後重試');
    }
    onStatus?.('OCR 圖片前處理中…');
    const sources = [];
    try {
      sources.push({ label: '黑白新版 ', source: await _preprocessOcrImage(file, 'binary') });
    } catch {
      sources.push({ label: '原圖 ', source: file });
    }

    onStatus?.('OCR 載入中…');
    const candidates = [];
    for (const item of sources) {
      candidates.push(await _recognizeOcrSource(item.source, item.label, total, onStatus));
    }
    const variants = candidates.map(candidate => ({
      label: candidate.label,
      text: candidate.text,
      confidence: candidate.confidence,
      score: _scoreOcrCandidate(candidate, total),
      ...candidate.parsed,
    }));
    return { variants, text: variants[0]?.text || '', ...(variants[0] || { items: [] }) };
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
    let items = [...leftItems, ...rightItems];
    let ocrItems = [];
    let ocrRawText = '';
    let ocrStatus = '';
    let ocrExpectedCount = null;
    let ocrFoundTable = false;
    let ocrVariants = [];
    let ocrVariantIndex = 0;
    let ocrTextPanelOpen = false;
    let ocrTextDraft = '';

    let el = document.getElementById('scan-confirm-modal');
    if (!el) {
      el = document.createElement('div');
      el.id = 'scan-confirm-modal';
      el.className = 'modal-overlay hidden';
      document.body.appendChild(el);
    }

    const queryDate = _formatQueryDate(date);
    el.innerHTML = `
      <div class="modal-sheet">
        <div class="modal-header">
          <span class="modal-title">確認發票資訊</span>
          <button class="modal-close" id="sconf-close">✕</button>
        </div>
        <div class="modal-body">
          <div class="sconf-row"><span class="sconf-label">發票號碼</span><span class="sconf-val">${_escapeHtml(invNum)}</span></div>
          <div class="sconf-row"><span class="sconf-label">日期</span><span class="sconf-val">${_escapeHtml(date || '—')}</span></div>
          <div class="sconf-row"><span class="sconf-label">金額</span><span class="sconf-val amount-expense">$${total.toLocaleString('zh-TW')}</span></div>
          <div class="sconf-row"><span class="sconf-label">商店</span><input type="text" id="sconf-shop" class="field-input" style="flex:1;margin-left:8px" value="${_escapeHtml(shop)}"></div>

          <div id="sconf-missing-wrap"></div>
          <div id="sconf-items-wrap"></div>

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
          <input type="text" id="sconf-note" class="field-input" placeholder="（選填）" value="${_escapeHtml(orderNote)}">

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

    function getOcrCountNote() {
      if (!ocrRawText) return '';
      if (!ocrFoundTable) return '未明確找到「消費明細」表格，請裁切截圖或改用手動補品項。';
      if (Number.isInteger(ocrExpectedCount)) {
        if (ocrItems.length === ocrExpectedCount) return `已對照截圖共 ${ocrExpectedCount} 筆`;
        return `截圖顯示共 ${ocrExpectedCount} 筆，目前解析 ${ocrItems.length} 筆，請補齊或編輯後再使用。`;
      }
      return '未讀到截圖的「共 x 筆」，請確認候選品項數量。';
    }

    function applyOcrVariant(variant, statusPrefix = '已切換') {
      ocrRawText = variant?.text || '';
      ocrItems = (variant?.items || []).filter(it => (it.name || '').trim() && Number.isFinite(Number(it.amount)) && Number(it.amount) !== 0);
      ocrExpectedCount = Number.isInteger(variant?.expectedCount) ? variant.expectedCount : null;
      ocrFoundTable = !!variant?.foundTable;
      const label = variant?.label ? `「${variant.label}」` : '';
      ocrStatus = ocrItems.length ? `${statusPrefix}${label}，已解析 ${ocrItems.length} 筆候選品項` : `${statusPrefix}${label}，但未解析出品項`;
    }

    function buildTextVariant(text, label = '貼上文字') {
      const parsed = _parseOcrItems(text, total);
      return { label, text, confidence: null, score: null, ...parsed };
    }

    async function handleOcrSource(source) {
      const buttons = Array.from(document.querySelectorAll('.sconf-ocr-action'));
      buttons.forEach(btn => { btn.disabled = true; });
      try {
        const res = await _runOcr(source, total, status => {
          ocrStatus = status;
          const statusEl = document.querySelector('.sconf-ocr-status');
          if (statusEl) statusEl.textContent = status;
        });
        ocrVariants = res.variants?.length ? res.variants : [res];
        ocrVariantIndex = 0;
        applyOcrVariant(ocrVariants[ocrVariantIndex], 'OCR 完成');
        renderItemsAndGuard();
      } catch (err) {
        ocrStatus = `OCR 失敗：${err.message}`;
        renderItemsAndGuard();
      } finally {
        document.querySelectorAll('.sconf-ocr-action').forEach(btn => { btn.disabled = false; });
      }
    }

    function handlePastedText(text) {
      ocrTextDraft = text;
      ocrTextPanelOpen = false;
      ocrVariants = [buildTextVariant(text)];
      ocrVariantIndex = 0;
      applyOcrVariant(ocrVariants[0], '文字解析完成');
      renderItemsAndGuard();
    }

    function renderItemsAndGuard() {
      const itemsWrap = document.getElementById('sconf-items-wrap');
      const missingWrap = document.getElementById('sconf-missing-wrap');
      const itemTotal = _sumItems(items);
      const missing = _missingAmount(total, items);
      const ocrCountNote = getOcrCountNote();

      if (itemsWrap) {
        itemsWrap.innerHTML = items.length ? `
          <div class="section-title" style="margin-top:12px">品項明細</div>
          <div class="sconf-items">
            ${items.map((it, idx) => `
              <div class="sconf-item-row">
                <span class="sconf-item-name">${_escapeHtml(it.name)}${it.qty > 1 ? ` ×${it.qty}` : ''}</span>
                <span class="sconf-item-amount">$${Number(it.amount || 0).toLocaleString('zh-TW')}</span>
                ${it.manual ? `<button class="sconf-item-remove" data-remove-idx="${idx}" aria-label="移除品項">✕</button>` : ''}
              </div>`).join('')}
          </div>` : '';
      }

      if (missingWrap) {
        missingWrap.innerHTML = missing > 1 ? `
          <div class="sconf-warning">
            <div class="sconf-warning-title">QR Code 明細可能不完整</div>
            <div class="sconf-warning-grid">
              <span>發票總額</span><strong>$${total.toLocaleString('zh-TW')}</strong>
              <span>QR 品項合計</span><strong>$${itemTotal.toLocaleString('zh-TW')}</strong>
              <span>差額</span><strong class="amount-expense">$${missing.toLocaleString('zh-TW')}</strong>
            </div>
            <p class="sconf-warning-text">若這張發票要做「部分」分帳，建議先查詢完整明細或補上差額品項，避免分帳金額錯誤。</p>
            <div class="sconf-query-box">
              ${[
                ['發票號碼', invNum],
                ['發票日期', queryDate],
                ['隨機碼', _left?.rand || ''],
                ['賣方統編', sellerId],
                ['總金額', total],
              ].map(([label, value]) => `
                <div class="sconf-copy-row">
                  <span class="sconf-copy-label">${label}</span>
                  <code class="sconf-copy-value">${_escapeHtml(value)}</code>
                  <button class="btn-secondary sconf-copy-btn" data-copy="${_escapeHtml(value)}">複製</button>
                </div>`).join('')}
            </div>
            <div class="sconf-warning-actions">
              <button class="btn-secondary" id="sconf-fill-missing" data-missing="${missing}">補差額品項繼續</button>
              ${_queryLaunchLinks().map(link => `
                <a class="btn-secondary sconf-query-link" href="${_escapeHtml(link.href)}"${link.target ? ` target="${link.target}"` : ''}${link.rel ? ` rel="${link.rel}"` : ''}>${link.label}</a>
              `).join('')}
              <button class="btn-secondary sconf-share-btn" id="sconf-share-query" aria-label="分享查詢頁" title="分享查詢頁">📤</button>
            </div>
            <div class="sconf-manual-add">
              <input type="text" id="sconf-manual-name" class="field-input" placeholder="缺漏品項名稱">
              <input type="number" id="sconf-manual-amount" class="field-input" placeholder="金額" min="1" step="1" inputmode="decimal">
              <button class="btn-secondary" id="sconf-add-item">新增品項</button>
            </div>
            <div class="sconf-ocr-box">
              <input type="file" id="sconf-ocr-file" accept="image/*" class="hidden">
              <div class="sconf-ocr-actions">
                <button class="btn-secondary sconf-ocr-action" id="sconf-ocr-paste">貼上截圖</button>
                <button class="btn-secondary sconf-ocr-action" id="sconf-ocr-pick">上傳截圖</button>
                <button class="btn-secondary sconf-ocr-action" id="sconf-text-paste">貼上文字</button>
              </div>
              ${ocrTextPanelOpen ? `
                <div class="sconf-text-paste-box">
                  <textarea id="sconf-text-raw" class="field-input sconf-text-raw" placeholder="貼上消費明細文字">${_escapeHtml(ocrTextDraft)}</textarea>
                  <button class="btn-secondary sconf-ocr-action" id="sconf-text-parse">解析文字</button>
                </div>
              ` : ''}
              <span class="sconf-ocr-status">${_escapeHtml(ocrStatus)}</span>
              <div id="sconf-ocr-wrap">
                ${ocrItems.length ? `
                  ${ocrVariants.length > 1 ? `
                    <div class="sconf-ocr-modes">
                      ${ocrVariants.map((variant, idx) => `
                        <button class="chip sconf-ocr-mode ${idx === ocrVariantIndex ? 'active' : ''}" data-ocr-mode="${idx}">
                          ${_escapeHtml(variant.label || `模式 ${idx + 1}`)}
                          <span>${(variant.items || []).length}筆</span>
                        </button>
                      `).join('')}
                    </div>
                  ` : ''}
                  <div class="sconf-ocr-title">OCR 候選品項</div>
                  ${ocrItems.map((it, idx) => `
                    <div class="sconf-ocr-row" data-ocr-idx="${idx}">
                      <input type="text" class="field-input sconf-ocr-name" value="${_escapeHtml(it.name)}" placeholder="品項名稱">
                      <input type="number" class="field-input sconf-ocr-amount" value="${Number(it.amount || 0)}" step="1" inputmode="decimal" placeholder="金額">
                      <button class="sconf-item-remove sconf-ocr-remove" data-ocr-remove="${idx}" aria-label="移除 OCR 品項">✕</button>
                    </div>
                  `).join('')}
                  ${ocrCountNote ? `<div class="sconf-ocr-empty">${_escapeHtml(ocrCountNote)}</div>` : ''}
                  <div class="sconf-ocr-summary">OCR 合計 $${_sumItems(ocrItems).toLocaleString('zh-TW')} / 發票總額 $${total.toLocaleString('zh-TW')}</div>
                  <button class="btn-secondary sconf-ocr-use" id="sconf-ocr-use">使用 OCR 明細</button>
                ` : ocrRawText ? `<p class="sconf-ocr-empty">${_escapeHtml(ocrCountNote || 'OCR 未解析出品項，請改用手動補品項或補差額。')}</p>` : ''}
              </div>
            </div>
          </div>` : '';
      }

      el.querySelectorAll('.sconf-copy-btn').forEach(btn => {
        btn.addEventListener('click', () => _copyText(btn.dataset.copy, btn));
      });

      document.getElementById('sconf-share-query')?.addEventListener('click', async e => {
        if (navigator.share) {
          try {
            await navigator.share({ title: '財政部電子發票查詢', url: INVOICE_QUERY_URL });
            return;
          } catch (err) {
            if (err?.name === 'AbortError') return;
          }
        }
        await _copyText(INVOICE_QUERY_URL, e.currentTarget);
      });

      document.getElementById('sconf-fill-missing')?.addEventListener('click', e => {
        const amount = parseInt(e.currentTarget.dataset.missing, 10);
        if (!(amount > 0)) return;
        items = [...items, { name: '未列明細差額', qty: 1, price: amount, amount, manual: true }];
        renderItemsAndGuard();
      });

      document.getElementById('sconf-add-item')?.addEventListener('click', () => {
        const nameEl = document.getElementById('sconf-manual-name');
        const amountEl = document.getElementById('sconf-manual-amount');
        const name = nameEl?.value.trim() || '';
        const amount = Math.round(parseFloat(amountEl?.value || '0'));
        if (!name || !(amount > 0)) {
          alert('請輸入缺漏品項名稱與有效金額');
          return;
        }
        items = [...items, { name, qty: 1, price: amount, amount, manual: true }];
        renderItemsAndGuard();
      });

      document.getElementById('sconf-ocr-pick')?.addEventListener('click', () => {
        document.getElementById('sconf-ocr-file')?.click();
      });

      document.getElementById('sconf-ocr-paste')?.addEventListener('click', async () => {
        try {
          const image = await _readClipboardImage();
          await handleOcrSource(image);
        } catch (err) {
          ocrStatus = err.message;
          renderItemsAndGuard();
        }
      });

      document.getElementById('sconf-ocr-file')?.addEventListener('change', async e => {
        const file = e.target.files?.[0];
        if (!file) return;
        await handleOcrSource(file);
        e.target.value = '';
      });

      document.getElementById('sconf-text-paste')?.addEventListener('click', async () => {
        try {
          const text = await _readClipboardText();
          handlePastedText(text);
        } catch (err) {
          ocrTextPanelOpen = true;
          ocrStatus = `${err.message}；也可以直接貼到下方文字框後按解析文字`;
          renderItemsAndGuard();
        }
      });

      document.getElementById('sconf-text-parse')?.addEventListener('click', () => {
        const text = document.getElementById('sconf-text-raw')?.value || '';
        if (!text.trim()) {
          ocrStatus = '請先貼上消費明細文字';
          renderItemsAndGuard();
          return;
        }
        handlePastedText(text);
      });

      el.querySelectorAll('.sconf-ocr-mode').forEach(btn => {
        btn.addEventListener('click', () => {
          const idx = parseInt(btn.dataset.ocrMode, 10);
          if (!ocrVariants[idx]) return;
          ocrVariantIndex = idx;
          applyOcrVariant(ocrVariants[idx]);
          renderItemsAndGuard();
        });
      });

      el.querySelectorAll('.sconf-ocr-row').forEach(row => {
        const idx = parseInt(row.dataset.ocrIdx, 10);
        row.querySelector('.sconf-ocr-name')?.addEventListener('input', e => {
          if (ocrItems[idx]) ocrItems[idx].name = e.target.value.trim();
        });
        row.querySelector('.sconf-ocr-amount')?.addEventListener('input', e => {
          const amount = Math.round(parseFloat(e.target.value || '0'));
          if (ocrItems[idx]) {
            ocrItems[idx].amount = amount;
            ocrItems[idx].price = amount;
          }
        });
      });

      el.querySelectorAll('.sconf-ocr-remove').forEach(btn => {
        btn.addEventListener('click', () => {
          const idx = parseInt(btn.dataset.ocrRemove, 10);
          ocrItems = ocrItems.filter((_, itemIdx) => itemIdx !== idx);
          renderItemsAndGuard();
        });
      });

      document.getElementById('sconf-ocr-use')?.addEventListener('click', () => {
        const cleaned = ocrItems
          .map(it => ({ ...it, name: (it.name || '').trim(), amount: Math.round(Number(it.amount) || 0) }))
          .filter(it => it.name && it.amount !== 0)
          .map(it => ({ ...it, qty: 1, price: it.amount, manual: true, ocr: true }));
        if (!cleaned.length) {
          alert('請先確認 OCR 候選品項名稱與金額');
          return;
        }
        items = cleaned;
        ocrItems = [];
        ocrRawText = '';
        ocrStatus = '已使用 OCR 明細取代 QR 品項';
        ocrExpectedCount = null;
        ocrFoundTable = false;
        ocrVariants = [];
        ocrVariantIndex = 0;
        renderItemsAndGuard();
      });

      el.querySelectorAll('.sconf-item-remove').forEach(btn => {
        btn.addEventListener('click', () => {
          const idx = parseInt(btn.dataset.removeIdx, 10);
          items = items.filter((_, itemIdx) => itemIdx !== idx);
          renderItemsAndGuard();
        });
      });
    }

    renderItemsAndGuard();

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
      btn.textContent = '檢查中…';

      const errEl = document.getElementById('sconf-error');
      errEl.classList.add('hidden');

      try {
        const missing = _missingAmount(total, items);
        if (missing > 1 && _shared === '部分') {
          errEl.textContent = 'QR 品項合計仍小於發票總額；請先補齊品項或使用「補差額品項繼續」再做部分分帳';
          errEl.classList.remove('hidden');
          btn.disabled = false;
          btn.textContent = '寫入發票明細';
          return;
        }

        // 重複發票號碼檢查
        let noteToWrite = note;
        const dups = await Sheets.checkDuplicateInvoice(invNum);
        if (dups.length > 0) {
          const dupInfo = dups.map(d => `${d.date} ${d.shop}`).join('、');
          const ok = window.confirm(`⚠️ 發票 ${invNum} 已有記錄：\n${dupInfo}\n\n確定繼續記錄？（備註將自動加入原始發票連結）`);
          if (!ok) {
            btn.disabled = false;
            btn.textContent = '寫入發票明細';
            return;
          }
          // 備註加入第一筆重複記錄的 HYPERLINK
          const dup = dups[0];
          const invGid = CONFIG.INVOICE_SHEET_ID;
          const invNumFormula = invNum.replace(/"/g, '""');
          const invSheet = CONFIG.TABS.INVOICE.replace(/'/g, "''");
          const link = `HYPERLINK("#gid=${invGid}&range=C"&MATCH("${invNumFormula}",'${invSheet}'!$C:$C,0),"重複:${invNumFormula}")`;
          noteToWrite = note ? `="${note.replace(/"/g, '""')}"&"｜"&${link}` : `=${link}`;
        }

        btn.textContent = '寫入中…';

        // 寫入發票明細，取得列號
        const invRowIndex = await Sheets.appendInvoiceRow(
          '掃描發票', date, invNum, shopValue, total, '開立', category, _shared, noteToWrite
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
    const itemOwners = {};       // idx → '🌟 Sin'|'🐨 Bear'|'共用'|'部分'
    const itemCustomAmounts = {}; // idx → Bear 負擔金額（僅 '部分' 時有效）

    const itemRows = needsAttribution && items.length
      ? items.map((it, idx) => `
        <div class="attr-item-row" data-idx="${idx}">
          <span class="attr-item-name">${it.name}</span>
          <span class="attr-item-amt">$${it.amount}</span>
          <div class="chip-row attr-owner-chips" style="margin:4px 0 0 0">
            <button class="chip attr-owner${itemOwners[idx] === '🌟 Sin' ? ' active' : ''}" data-owner="🌟 Sin">🌟 Sin</button>
            <button class="chip attr-owner${itemOwners[idx] === '🐨 Bear' ? ' active' : ''}" data-owner="🐨 Bear">🐨 Bear</button>
            <button class="chip attr-owner${itemOwners[idx] === '共用' ? ' active' : ''}" data-owner="共用">共用</button>
            <button class="chip attr-owner${itemOwners[idx] === '部分' ? ' active' : ''}" data-owner="部分">部分</button>
          </div>
          <div class="partial-bear-wrap hidden" id="partial-wrap-${idx}">
            <div class="amount-wrap" style="margin-top:6px">
              <span class="amount-prefix">$</span>
              <input type="number" id="partial-input-${idx}" class="field-input amount-input partial-bear-input"
                     data-idx="${idx}" value="" min="0" step="1" inputmode="decimal"
                     placeholder="Bear 負擔">
            </div>
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
        const idx = parseInt(row.dataset.idx);
        row.querySelectorAll('.attr-owner').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        itemOwners[idx] = btn.dataset.owner;
        const wrapEl = document.getElementById(`partial-wrap-${idx}`);
        if (wrapEl) wrapEl.classList.toggle('hidden', itemOwners[idx] !== '部分');
        if (itemOwners[idx] !== '部分') delete itemCustomAmounts[idx];
      });
    });

    // 部分金額輸入
    el.querySelectorAll('.partial-bear-input').forEach(input => {
      input.addEventListener('input', () => {
        itemCustomAmounts[parseInt(input.dataset.idx)] = parseFloat(input.value);
      });
    });

    document.getElementById('sattr-close').addEventListener('click', _closeAttribution);
    document.getElementById('sattr-skip').addEventListener('click', () => {
      _closeAttribution();
      alert(`發票 ${invNum} 已寫入，可至待處理頁面填寫歸屬後匯入。`);
    });

    // 偵測平台訂單（備註含 CC_PAY_KEYWORDS）
    const isPlatformOrder = CONFIG.CC_PAY_KEYWORDS.some(
      kw => note.toLowerCase().includes(kw.toLowerCase())
    );
    if (isPlatformOrder && shared !== 'x') {
      document.getElementById('sattr-submit').textContent = '確認（待 CC 配對）';
    }

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
        const missingPartial = items.some((_, idx) => itemOwners[idx] === '部分' && !(itemCustomAmounts[idx] >= 0));
        if (missingPartial) {
          errEl.textContent = '請填入「部分」品項的 Bear 負擔金額';
          errEl.classList.remove('hidden');
          return;
        }
      }

      const btn = document.getElementById('sattr-submit');
      btn.disabled    = true;
      btn.textContent = isPlatformOrder && shared !== 'x' ? '儲存中…' : '匯入中…';

      try {
        // 平台訂單：只存品項歸屬，不寫月度帳本，等待 CC 配對
        if (isPlatformOrder && shared !== 'x') {
          if (needsAttribution && firstItemRow != null) {
            for (let idx = 0; idx < items.length; idx++) {
              const isPartial = itemOwners[idx] === '部分';
              await Sheets.updateItemRow(firstItemRow + idx, isPartial ? '共用' : itemOwners[idx], isPartial ? (itemCustomAmounts[idx] || 0) : null);
            }
          }
          _closeAttribution();
          alert(`✓ 品項已儲存\n請至「待處理」頁面選擇對應 CC 明細後匯入帳本`);
          return;
        }

        // 一般訂單：計算分攤後直接寫入月度帳本
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
          bearShare = items.reduce((sum, it, idx) => {
            const owner = itemOwners[idx];
            if (owner === '🐨 Bear') return sum + it.amount;
            if (owner === '共用')    return sum + Math.floor(it.amount / 2);
            if (owner === '部分')    return sum + (itemCustomAmounts[idx] || 0);
            return sum;
          }, 0);
          sinShare = total - bearShare;

          if (firstItemRow != null) {
            for (let idx = 0; idx < items.length; idx++) {
              const isPartial = itemOwners[idx] === '部分';
              await Sheets.updateItemRow(firstItemRow + idx, isPartial ? '共用' : itemOwners[idx], isPartial ? (itemCustomAmounts[idx] || 0) : null);
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
        btn.textContent = isPlatformOrder && shared !== 'x' ? '確認（待 CC 配對）' : '確認匯入';
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
