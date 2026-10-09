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

  function _evaluate(expr) {
    const tokens = expr.match(/\d+\.?\d*|\.\d+|[+−×÷]/g) || [];
    if (!tokens.length) return 0;
    if (OPS[tokens[tokens.length - 1]]) tokens.pop();   // 結尾多打的運算子忽略
    // 第一輪：乘除
    const stack = [parseFloat(tokens[0])];
    for (let i = 1; i < tokens.length; i += 2) {
      const op = tokens[i], n = parseFloat(tokens[i + 1]);
      if (op === '×' || op === '÷') stack.push(OPS[op](stack.pop(), n));
      else stack.push(op, n);
    }
    // 第二輪：加減
    let result = stack[0];
    for (let i = 1; i < stack.length; i += 2) result = OPS[stack[i]](result, stack[i + 1]);
    return result;
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

  function _press(k) {
    const last = _expr.slice(-1);
    if (k === 'C') _expr = '';
    else if (k === '⌫') _expr = _expr.slice(0, -1);
    else if (k === '=') { const v = _evaluate(_expr); _expr = isFinite(v) ? String(Math.round(v * 100) / 100) : ''; }
    else if (OPS[k]) {
      if (!_expr) return;
      _expr = OPS[last] ? _expr.slice(0, -1) + k : _expr + k;   // 連按運算子＝替換
    } else if (k === '.') {
      const cur = _expr.split(/[+−×÷]/).pop();
      if (cur.includes('.')) return;
      _expr += cur ? '.' : '0.';
    } else _expr += k;
    _render();
  }

  function _render() {
    document.getElementById('calc-expr').textContent = _expr;
    const v = _evaluate(_expr);
    document.getElementById('calc-result').textContent =
      isFinite(v) ? '$' + (Math.round(v * 100) / 100).toLocaleString('zh-TW') : '—';
  }

  function open(initial, onApply) {
    _build();
    _expr = initial && parseFloat(initial) > 0 ? String(parseFloat(initial)) : '';
    _onApply = onApply;
    _render();
    document.getElementById('calc-modal').classList.remove('hidden');
  }

  function close() {
    document.getElementById('calc-modal')?.classList.add('hidden');
  }

  return { open, close };
})();

window.Calculator = Calculator;
