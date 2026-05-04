const Stats = (() => {
  const PALETTE = [
    '#00C9A7','#FF6B6B','#FFD166','#6BCB77',
    '#4D96FF','#C77DFF','#FF9F43','#FF6BB5',
  ];
  const now  = new Date();
  let _year  = now.getFullYear();
  let _month = now.getMonth() + 1;
  let _mode  = 'month';  // 'month' | 'year'

  function _fmt(n) { return '$' + Math.abs(n).toLocaleString('zh-TW'); }

  // ── SVG donut chart ───────────────────────────────────────────

  function _polar(cx, cy, r, a) {
    return {
      x: +(cx + r * Math.cos(a - Math.PI / 2)).toFixed(2),
      y: +(cy + r * Math.sin(a - Math.PI / 2)).toFixed(2),
    };
  }

  function _slice(cx, cy, oR, iR, a0, a1) {
    const p1 = _polar(cx, cy, oR, a0);
    const p2 = _polar(cx, cy, oR, a1);
    const p3 = _polar(cx, cy, iR, a1);
    const p4 = _polar(cx, cy, iR, a0);
    const lg = a1 - a0 > Math.PI ? 1 : 0;
    return `M${p1.x} ${p1.y} A${oR} ${oR} 0 ${lg} 1 ${p2.x} ${p2.y}`
         + ` L${p3.x} ${p3.y} A${iR} ${iR} 0 ${lg} 0 ${p4.x} ${p4.y}Z`;
  }

  function _buildChart(groups, total) {
    if (!groups.length) {
      return '<div class="empty-state"><span>📊</span><p>本期尚無支出記錄</p></div>';
    }

    const cx = 120, cy = 120, oR = 100, iR = 62, GAP = 0.025;
    let paths = '';
    let angle = 0;
    const TWO_PI = Math.PI * 2;

    groups.forEach((g, i) => {
      const sweep = (g.amount / total) * TWO_PI;
      if (sweep < 0.01) return;
      paths += `<path d="${_slice(cx, cy, oR, iR, angle + GAP / 2, angle + sweep - GAP / 2)}"
        fill="${PALETTE[i % PALETTE.length]}"/>`;
      angle += sweep;
    });

    return `
      <svg viewBox="0 0 240 240" width="220" height="220" class="donut-chart">
        ${paths}
        <text x="120" y="112" text-anchor="middle" class="chart-sub">總支出</text>
        <text x="120" y="136" text-anchor="middle" class="chart-main">${_fmt(total)}</text>
      </svg>`;
  }

  function _buildLegend(groups, total) {
    if (!groups.length) return '';
    return groups.map((g, i) => {
      const pct = ((g.amount / total) * 100).toFixed(1);
      return `
        <div class="legend-item">
          <span class="legend-dot" style="background:${PALETTE[i % PALETTE.length]}"></span>
          <span class="legend-cat">${g.cat || '（未分類）'}</span>
          <span class="legend-pct">${pct}%</span>
          <span class="legend-amt">${_fmt(g.amount)}</span>
        </div>`;
    }).join('');
  }

  // ── Load data ─────────────────────────────────────────────────

  async function _load() {
    document.getElementById('stats-chart').innerHTML  = '<div class="spinner"></div>';
    document.getElementById('stats-legend').innerHTML = '';

    try {
      let rows;
      if (_mode === 'month') {
        rows = await Sheets.getMonthlyData(_year, _month);
      } else {
        const all = await Promise.all(
          Array.from({ length: 12 }, (_, i) =>
            Sheets.getMonthlyData(_year, i + 1).catch(() => [])
          )
        );
        rows = all.flat();
      }

      const map = {};
      rows.forEach(r => {
        if (r.amount <= 0 || r.shared === 'x') return;
        const key = r.category || '';
        map[key] = (map[key] || 0) + r.amount;
      });
      const groups = Object.entries(map)
        .map(([cat, amount]) => ({ cat, amount }))
        .sort((a, b) => b.amount - a.amount);
      const total = groups.reduce((s, g) => s + g.amount, 0);

      document.getElementById('stats-chart').innerHTML  = _buildChart(groups, total);
      document.getElementById('stats-legend').innerHTML = _buildLegend(groups, total);
    } catch (e) {
      if (e.message !== 'auth_expired') {
        document.getElementById('stats-chart').innerHTML =
          `<div class="empty-state"><span>⚠️</span><p>${e.message}</p></div>`;
      }
    }
  }

  function _updateLabel() {
    const el = document.getElementById('stats-label');
    if (!el) return;
    el.textContent = _mode === 'month'
      ? `${_year} 年 ${String(_month).padStart(2, '0')} 月`
      : `${_year} 年`;
  }

  // ── Shell ─────────────────────────────────────────────────────

  function _buildShell() {
    document.getElementById('tab-stats').innerHTML = `
      <div class="stats-header">
        <div class="stats-top-row">
          <div class="chip-row">
            <button class="chip active" data-mode="month">本月</button>
            <button class="chip" data-mode="year">本年</button>
          </div>
          <button class="settings-gear-btn" id="stats-settings-btn" title="設定">⚙️</button>
        </div>
        <div class="home-nav">
          <button class="month-btn" id="stats-prev">◀</button>
          <span id="stats-label"></span>
          <button class="month-btn" id="stats-next">▶</button>
        </div>
      </div>

      <div class="card stats-chart-card" id="stats-chart"></div>
      <div class="card stats-legend-card" id="stats-legend"></div>
    `;

    document.getElementById('stats-settings-btn').addEventListener('click', () => {
      window.Settings?.open();
    });

    document.querySelectorAll('#tab-stats .chip[data-mode]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#tab-stats .chip[data-mode]')
          .forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        _mode = btn.dataset.mode;
        _updateLabel();
        _load();
      });
    });

    document.getElementById('stats-prev').addEventListener('click', () => {
      if (_mode === 'month') { _month--; if (_month < 1)  { _month = 12; _year--; } }
      else                   { _year--; }
      _updateLabel(); _load();
    });
    document.getElementById('stats-next').addEventListener('click', () => {
      if (_mode === 'month') { _month++; if (_month > 12) { _month = 1;  _year++; } }
      else                   { _year++; }
      _updateLabel(); _load();
    });
  }

  function init() {
    _buildShell();
    _updateLabel();
    _load();
  }

  return { init };
})();
