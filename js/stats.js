const Stats = (() => {
  const PALETTE = [
    '#00C9A7','#FF6B6B','#FFD166','#6BCB77',
    '#4D96FF','#C77DFF','#FF9F43','#FF6BB5',
  ];
  const UNCAT = '✘';            // 未分類的顯示標籤 + 篩選 sentinel（與明細 tab 一致；深色 x，跟隨文字色）
  const now  = new Date();
  let _year  = now.getFullYear();
  let _month = now.getMonth() + 1;
  let _mode         = 'month';   // 'month' | 'year'
  let _memberFilter   = 'all';   // 'all' | 'sin' | 'bear' —— 算誰的負擔額
  let _sharedSelected = new Set(); // 空=全部；值 '是'/'部分'/'否'/'-'（對齊明細 tab）
  let _chartType    = 'donut';   // 'donut' | 'bar'
  let _rows         = [];        // 供分類下鑽用

  function _fmt(n) { return '$' + Math.abs(n).toLocaleString('zh-TW'); }
  function _fmtK(n) {
    if (n >= 10000) return Math.round(n / 1000) + 'k';
    if (n >= 1000)  return (n / 1000).toFixed(1) + 'k';
    return String(Math.round(n));
  }

  // 回傳該列依「成員 + 是否共用」篩選後的負擔額貢獻（0=不納入統計）
  //   成員 all→總金額、sin→sinShare、bear→bearShare；是否共用複選篩列（空=全部）
  function _rowContribution(r) {
    if (r.shared === 'x') return 0;
    if (_sharedSelected.size > 0 && !_sharedSelected.has(r.shared)) return 0;
    if (_memberFilter === 'sin')  return r.sinShare  || 0;
    if (_memberFilter === 'bear') return r.bearShare || 0;
    return r.amount || 0;   // all：兩人總額
  }

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
        fill="${PALETTE[i % PALETTE.length]}" data-cat="${g.cat || UNCAT}" class="donut-slice"/>`;
      angle += sweep;
    });
    return `
      <svg viewBox="0 0 240 240" width="220" height="220" class="donut-chart">
        ${paths}
        <g class="donut-total-jump" role="button" tabindex="0" aria-label="查看總支出明細">
          <circle class="donut-total-hit" cx="120" cy="120" r="60"/>
          <text x="120" y="112" text-anchor="middle" class="chart-sub">總支出</text>
          <text x="120" y="136" text-anchor="middle" class="chart-main">${_fmt(total)}</text>
        </g>
      </svg>`;
  }

  function _buildLegend(groups, total) {
    if (!groups.length) return '';
    return groups.map((g, i) => {
      const pct = ((g.amount / total) * 100).toFixed(1);
      return `
        <div class="legend-item legend-item-clickable" data-cat="${g.cat || UNCAT}">
          <span class="legend-dot" style="background:${PALETTE[i % PALETTE.length]}"></span>
          <span class="legend-cat">${g.cat || UNCAT}</span>
          <span class="legend-pct">${pct}%</span>
          <span class="legend-amt">${_fmt(g.amount)}</span>
        </div>`;
    }).join('');
  }

  // ── Horizontal bar chart (month/category) ────────────────────

  function _buildBarChart(groups, total) {
    if (!groups.length) {
      return '<div class="empty-state"><span>📊</span><p>本期尚無支出記錄</p></div>';
    }
    const maxAmt = groups[0].amount;
    return `<div class="bar-chart-wrap">
      ${groups.map((g, i) => {
        const fillPct  = (g.amount / maxAmt * 100).toFixed(1);
        const sharePct = ((g.amount / total) * 100).toFixed(1);
        return `
          <div class="bar-row bar-row-clickable" data-cat="${g.cat || UNCAT}">
            <div class="bar-cat-label">${g.cat || UNCAT}</div>
            <div class="bar-track">
              <div class="bar-fill" style="width:${fillPct}%;background:${PALETTE[i % PALETTE.length]}"></div>
            </div>
            <div class="bar-right">
              <span class="bar-amt">${_fmt(g.amount)}</span>
              <span class="bar-pct">${sharePct}%</span>
            </div>
          </div>`;
      }).join('')}
    </div>`;
  }

  // ── Vertical bar chart (year/monthly trend) ───────────────────

  function _buildYearBarChart(monthMap, maxAmt) {
    const LABELS = ['1','2','3','4','5','6','7','8','9','10','11','12'];
    const colW = 26, gap = 4, chartH = 100, padTop = 20, padBot = 18;
    const svgW = 12 * (colW + gap) - gap;
    const svgH = chartH + padTop + padBot;
    const bars = Array.from({ length: 12 }, (_, i) => {
      const m   = i + 1;
      const amt = monthMap[m] || 0;
      const barH = maxAmt > 0 && amt > 0 ? Math.max(amt / maxAmt * chartH, 2) : 0;
      const x    = i * (colW + gap);
      const barY = padTop + chartH - barH;
      return `
        <rect x="${x}" y="${barY}" width="${colW}" height="${barH}" rx="3"
              fill="${PALETTE[i % PALETTE.length]}" opacity="${amt > 0 ? 0.9 : 0}"/>
        ${amt > 0 ? `<text x="${x + colW / 2}" y="${barY - 3}" text-anchor="middle" class="bar-year-amt">${_fmtK(amt)}</text>` : ''}
        <text x="${x + colW / 2}" y="${svgH - 2}" text-anchor="middle" class="bar-year-label">${LABELS[i]}</text>
      `;
    }).join('');
    return `<svg viewBox="0 0 ${svgW} ${svgH}" width="100%" class="bar-chart-year">${bars}</svg>`;
  }

  function _bindCatClicks() {
    const sharedVals = [..._sharedSelected];
    const jump = cat => window.Ledger?.jumpTo({ category: cat, member: _memberFilter, sharedValues: sharedVals });
    const jumpTotal = () => window.Ledger?.jumpTo({ member: _memberFilter, sharedValues: sharedVals });
    document.querySelectorAll('#stats-chart .donut-slice').forEach(el => {
      el.addEventListener('click', () => jump(el.dataset.cat));
    });
    document.querySelectorAll('#stats-chart .donut-total-jump').forEach(el => {
      el.addEventListener('click', jumpTotal);
      el.addEventListener('keydown', e => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        jumpTotal();
      });
    });
    document.querySelectorAll('#stats-chart .bar-row-clickable').forEach(el => {
      el.addEventListener('click', () => jump(el.dataset.cat));
    });
    document.querySelectorAll('#stats-legend .legend-item-clickable').forEach(el => {
      el.addEventListener('click', () => jump(el.dataset.cat));
    });
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
      _rows = rows;

      // Year + bar: monthly trend
      if (_mode === 'year' && _chartType === 'bar') {
        const monthMap = {};
        rows.forEach(r => {
          const amt = _rowContribution(r);
          if (amt <= 0) return;
          const m = parseInt(r.date.slice(5, 7), 10);
          monthMap[m] = (monthMap[m] || 0) + amt;
        });
        const maxAmt = Math.max(...Object.values(monthMap), 1);
        document.getElementById('stats-chart').innerHTML = _buildYearBarChart(monthMap, maxAmt);
        return;
      }

      // Category breakdown
      const map = {};
      rows.forEach(r => {
        const amt = _rowContribution(r);
        if (amt <= 0) return;
        const key = r.category || '';
        map[key] = (map[key] || 0) + amt;
      });
      const groups = Object.entries(map)
        .map(([cat, amount]) => ({ cat, amount }))
        .sort((a, b) => b.amount - a.amount);
      const total = groups.reduce((s, g) => s + g.amount, 0);

      if (_chartType === 'bar') {
        document.getElementById('stats-chart').innerHTML  = _buildBarChart(groups, total);
        document.getElementById('stats-legend').innerHTML = '';
      } else {
        document.getElementById('stats-chart').innerHTML  = _buildChart(groups, total);
        document.getElementById('stats-legend').innerHTML = _buildLegend(groups, total);
      }

      _bindCatClicks();
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
      <div class="home-nav">
        <button class="month-btn" id="stats-prev">◀</button>
        <span id="stats-label"></span>
        <button class="month-btn" id="stats-next">▶</button>
        <button class="month-btn refresh-btn" id="stats-refresh" title="重新載入">↺</button>
      </div>

      <div class="stats-header">
        <div class="stats-top-row">
          <div class="chip-row">
            <button class="chip active" data-mode="month">本月</button>
            <button class="chip" data-mode="year">本年</button>
          </div>
        </div>
        <div class="stats-filter-bar">
          <div class="chip-row">
            <button class="chip active" data-member="all">全部</button>
            <button class="chip" data-member="sin">🌟 Sin</button>
            <button class="chip" data-member="bear">🐨 Bear</button>
          </div>
          <div class="chip-row">
            <button class="chip active" data-shared-filter="all">全部</button>
            <button class="chip" data-shared-filter="是">是</button>
            <button class="chip" data-shared-filter="部分">部分</button>
            <button class="chip" data-shared-filter="否">否</button>
            <button class="chip" data-shared-filter="-">-</button>
          </div>
          <div class="chip-row">
            <button class="chip active" data-chart-type="donut">圓環</button>
            <button class="chip" data-chart-type="bar">長條</button>
          </div>
        </div>
      </div>

      <div class="card stats-chart-card" id="stats-chart"></div>
      <div class="card stats-legend-card" id="stats-legend"></div>
    `;

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

    document.querySelectorAll('#tab-stats .chip[data-member]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#tab-stats .chip[data-member]')
          .forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        _memberFilter = btn.dataset.member;
        _load();
      });
    });

    document.querySelectorAll('#tab-stats .chip[data-shared-filter]').forEach(btn => {
      btn.addEventListener('click', () => {
        const val = btn.dataset.sharedFilter;
        if (val === 'all') {
          _sharedSelected.clear();
        } else if (_sharedSelected.has(val)) {
          _sharedSelected.delete(val);
        } else {
          _sharedSelected.add(val);
        }
        // 空集合 → 「全部」亮；否則亮選中的（對齊明細 tab）
        document.querySelectorAll('#tab-stats .chip[data-shared-filter]').forEach(b => {
          if (b.dataset.sharedFilter === 'all') {
            b.classList.toggle('active', _sharedSelected.size === 0);
          } else {
            b.classList.toggle('active', _sharedSelected.has(b.dataset.sharedFilter));
          }
        });
        _load();
      });
    });

    document.querySelectorAll('#tab-stats .chip[data-chart-type]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#tab-stats .chip[data-chart-type]')
          .forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        _chartType = btn.dataset.chartType;
        _load();
      });
    });

    document.getElementById('stats-prev').addEventListener('click', () => {
      if (_mode === 'month') {
        _month--; if (_month < 1)  { _month = 12; _year--; }
        window.AppMonth.set(_year, _month);
      } else { _year--; }
      _updateLabel(); _load();
    });
    document.getElementById('stats-next').addEventListener('click', () => {
      if (_mode === 'month') {
        _month++; if (_month > 12) { _month = 1;  _year++; }
        window.AppMonth.set(_year, _month);
      } else { _year++; }
      _updateLabel(); _load();
    });
    document.getElementById('stats-refresh').addEventListener('click', () => {
      if (_mode === 'month') {
        Sheets.invalidateMonth(`${_year}-${String(_month).padStart(2,'0')}`);
      } else {
        Array.from({ length: 12 }, (_, i) =>
          Sheets.invalidateMonth(`${_year}-${String(i+1).padStart(2,'0')}`)
        );
      }
      _load();
    });
  }

  function activate({ year, month }) {
    if (_mode === 'month' && (year !== _year || month !== _month)) {
      _year = year; _month = month;
      _updateLabel();
      _load();
    }
  }

  function init() {
    _buildShell();
    _updateLabel();
    _load();
  }

  return { init, activate, reload: _load };
})();

window.Stats = Stats;
