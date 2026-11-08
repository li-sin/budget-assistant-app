// 🧮 計算機 modal：Calculator.open(初始值, onApply) → 按「帶入」回傳整數結果
// 自寫運算解析（不用 eval），支援 + − × ÷ 與先乘除後加減
const Calculator = (() => {
  let _expr = '';
  let _onApply = null;

  const KEYS = [
    ['C', '⌫', '÷', '×'],
    ['7', '8', '9', '−'],
    ['4', '5', '6', '+'],
    ['1', '2', '3', '='],
    ['0', '00', '.'],
  ];
  const OPS = { '+': (a, b) => a + b, '−': (a, b) => a - b, '×': (a, b) => a * b, '÷': (a, b) => a / b };

  // 由左到右依序算（同一般計算機）：351−15÷2 ＝ (351−15)÷2 ＝ 168，方便先算總額再除以 2 分帳（2026-11-08 Sin）
  function _evaluate(expr) {
    const tokens = expr.match(/\d+\.?\d*|\.\d+|[+−×÷]/g) || [];
    if (!tokens.length) return 0;
    if (OPS[tokens[tokens.length - 1]]) tokens.pop();   // 結尾多打的運算子忽略
    let result = parseFloat(tokens[0]);
    for (let i = 1; i < tokens.length; i += 2) result = OPS[tokens[i]](result, parseFloat(tokens[i + 1]));
    return result;
  }

  // 顯示用：乘除前面有加減時補括號，看得出是先算加減（351−15÷2 → (351−15)÷2）
  function _pretty(expr) {
    const tokens = expr.match(/\d+\.?\d*|\.\d+|[+−×÷]/g) || [];
    let out = '', low = false;
    for (const t of tokens) {
      if (t === '×' || t === '÷') { if (low) out = `(${out})`; low = false; out += t; }
      else if (t === '+' || t === '−') { low = true; out += t; }
      else out += t;
    }
    return out;
  }

  function _build() {
    if (document.getElementById('calc-modal')) return;
    const el = document.createElement('div');
    el.id = 'calc-modal';
    el.className = 'modal-overlay hidden';
    el.innerHTML = `
      <div class="modal-sheet calc-sheet">
        <div class="modal-header">
          <span class="modal-title">🧮 計算機</span>
          <button class="modal-close" id="calc-close">✕</button>
        </div>
        <div class="modal-body">
          <div class="calc-display">
            <div class="calc-expr" id="calc-expr"></div>
            <div class="calc-result" id="calc-result">0</div>
          </div>
          <div class="calc-keys">
            ${KEYS.flat().map(k => `<button type="button" class="calc-key${OPS[k] || k === '=' ? ' op' : ''}${k === 'C' || k === '⌫' ? ' fn' : ''}${k === '0' ? ' wide' : ''}" data-key="${k}">${k}</button>`).join('')}
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn-secondary" id="calc-cancel">取消</button>
          <button class="btn-primary" id="calc-apply">帶入</button>
        </div>
      </div>`;
    document.body.appendChild(el);
    document.addEventListener('keydown', _onKeydown, true);

    el.querySelectorAll('.calc-key').forEach(btn => btn.addEventListener('click', () => _press(btn.dataset.key)));
    document.getElementById('calc-close').addEventListener('click', close);
    document.getElementById('calc-cancel').addEventListener('click', close);
    el.addEventListener('click', e => { if (e.target === el) close(); });
    document.getElementById('calc-apply').addEventListener('click', () => {
      const v = Math.round(_evaluate(_expr));
      if (_onApply && isFinite(v)) _onApply(v);
      close();
    });
  }

  // 電腦鍵盤（含數字鍵盤）：Enter 按一下＝「=」、快速按兩下＝帶入（2026-11-08 Sin）、Esc＝取消；攔在捕捉階段，不讓按鍵打進後面的輸入框
  const _ENTER_DOUBLE_MS = 500;
  let _lastEnter = 0;
  const _KEY_MAP = { '+': '+', '-': '−', '*': '×', '/': '÷', x: '×', X: '×', '=': '=', '.': '.', Backspace: '⌫', Delete: 'C', c: 'C', C: 'C' };
  function _onKeydown(e) {
    const modal = document.getElementById('calc-modal');
    if (!modal || modal.classList.contains('hidden') || e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Enter') {
      const now = Date.now();
      if (now - _lastEnter <= _ENTER_DOUBLE_MS) { _lastEnter = 0; document.getElementById('calc-apply').click(); }
      else { _lastEnter = now; _press('='); }
    }
    else if (e.key === 'Escape') close();
    else if (/^[0-9]$/.test(e.key)) _press(e.key);
    else if (_KEY_MAP[e.key]) _press(_KEY_MAP[e.key]);
    else return;
    e.preventDefault();
    e.stopPropagation();
  }

  function _press(k) {
    const last = _expr.slice(-1);
    if (k === 'C') _expr = '0';
    else if (k === '⌫') _expr = _expr.slice(0, -1) || '0';
    else if (k === '=') { const v = _evaluate(_expr); _expr = isFinite(v) ? String(Math.round(v * 100) / 100) : '0'; }
    else if (OPS[k]) {
      _expr = OPS[last] ? _expr.slice(0, -1) + k : _expr + k;   // 連按運算子＝替換
    } else if (k === '.') {
      const cur = _expr.split(/[+−×÷]/).pop();
      if (cur.includes('.')) return;
      _expr += cur ? '.' : '0.';
    } else {
      // 開頭的 0 直接被取代（預設 0 再按 5 是 5，不是 05）
      const cur = _expr.split(/[+−×÷]/).pop();
      if (cur === '0') {
        if (k === '00') return;
        _expr = _expr.slice(0, -1);
      }
      _expr += k;
    }
    _render();
  }

  function _render() {
    document.getElementById('calc-expr').textContent = _pretty(_expr);
    const v = _evaluate(_expr);
    document.getElementById('calc-result').textContent =
      isFinite(v) ? '$' + (Math.round(v * 100) / 100).toLocaleString('zh-TW') : '—';
  }

  function open(initial, onApply) {
    _build();
    // 帶入欄位原本的金額；沒有就從 0 開始
    _expr = initial && parseFloat(initial) > 0 ? String(parseFloat(initial)) : '0';
    _onApply = onApply;
    _lastEnter = 0;
    _render();
    document.activeElement?.blur?.();   // 避免按鍵同時打進原本的輸入框
    document.getElementById('calc-modal').classList.remove('hidden');
  }

  // 把金額帶回輸入框；發 input 事件讓各頁面原本的狀態同步（如 customAmountMap）
  function openFor(input) {
    open(input.value, v => {
      input.value = v;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  // 「部分」的 Bear 金額欄：選了就跳計算機（已有金額就不打擾）
  function promptFor(input) {
    if (input && !input.value) openFor(input);
  }

  // 在 .amount-wrap 裡的金額欄加 🧮（重複呼叫不會重複加）
  function attach(input) {
    if (!input || input.dataset.calcAttached) return;
    input.dataset.calcAttached = '1';
    input.style.paddingRight = '44px';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'amount-calc-btn';
    btn.setAttribute('aria-label', '計算機');
    btn.textContent = '🧮';
    btn.addEventListener('click', e => { e.stopPropagation(); openFor(input); });
    input.after(btn);
  }

  function close() {
    document.getElementById('calc-modal')?.classList.add('hidden');
  }

  return { open, close, openFor, promptFor, attach };
})();

window.Calculator = Calculator;
