// Allocation pie chart and historical allocation slider

const DETAILED_ORDER = ['stock', 'etf', 'mutual_fund', 'gold_etf', 'crypto', 'pf', 'fd'];
const CATEGORY_ORDER = ['equity', 'commodities', 'crypto', 'debt'];

function renderPieChart(investments, isHistorical) {
  if (!isHistorical) _lastPieInvestments = investments;
  const totals = {};
  let labelMap, colorMap, order, isDrillDown = false;

  if (pieDrillCategory && allocView === 'category') {
    // Drill-down: show detailed types within the selected broad category
    isDrillDown = true;
    labelMap = CATEGORY_LABELS;
    colorMap = CATEGORY_COLORS;
    order = DETAILED_ORDER.filter(t => BROAD_CATEGORY_MAP[t] === pieDrillCategory);
    for (const inv of investments) {
      const type = inv.category || inv.type;
      if (BROAD_CATEGORY_MAP[type] === pieDrillCategory) {
        totals[type] = (totals[type] || 0) + (inv.current_value || 0);
      }
    }
  } else if (allocView === 'category') {
    labelMap = BROAD_CATEGORY_LABELS;
    colorMap = BROAD_CATEGORY_COLORS;
    order = CATEGORY_ORDER;
    for (const inv of investments) {
      const type = inv.category || inv.type;
      const key = BROAD_CATEGORY_MAP[type] || type;
      totals[key] = (totals[key] || 0) + (inv.current_value || 0);
    }
  } else {
    labelMap = CATEGORY_LABELS;
    colorMap = CATEGORY_COLORS;
    order = DETAILED_ORDER;
    for (const inv of investments) {
      const type = inv.category || inv.type;
      totals[type] = (totals[type] || 0) + (inv.current_value || 0);
    }
  }

  const keys = [], labels = [], data = [], colors = [];
  for (const key of order) {
    const val = totals[key];
    if (!val || val <= 0) continue;
    keys.push(key);
    labels.push(labelMap[key] || key);
    data.push(val);
    colors.push(colorMap[key] || '#666');
  }

  const ctx = document.getElementById('pieChart').getContext('2d');
  if (pieChart) pieChart.destroy();
  document.getElementById('pieBackBtn').style.display = isDrillDown ? '' : 'none';
  if (data.length === 0) { return; }
  pieChart = new Chart(ctx, {
    type: 'doughnut',
    data: { labels, datasets: [{ data, backgroundColor: colors, borderWidth: 0 }] },
    options: {
      responsive: true,
      onClick: function(evt, elements) {
        if (allocView !== 'category' || isDrillDown || elements.length === 0) return;
        const idx = elements[0].index;
        pieDrillCategory = keys[idx];
        renderPieChart(_lastPieInvestments);
      },
      onHover: function(evt, elements) {
        evt.native.target.style.cursor = (allocView === 'category' && !isDrillDown && elements.length > 0) ? 'pointer' : 'default';
      },
      plugins: {
        legend: { position: 'bottom', labels: { color: '#9ca3af', font: { size: 11 } } },
        tooltip: {
          callbacks: {
            label: function(ctx) {
              const total = ctx.dataset.data.reduce((a,b) => a+b, 0);
              const pct = ((ctx.parsed / total) * 100).toFixed(1);
              return ctx.label + ': ' + fmtAmount(ctx.parsed) + ' (' + pct + '%)';
            }
          }
        }
      }
    }
  });
}

function pieDrillBack() {
  pieDrillCategory = null;
  renderPieChart(_lastPieInvestments);
}

function setAllocView(view, btn) {
  allocView = view;
  pieDrillCategory = null;
  btn.parentElement.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  const slider = document.getElementById('timeSlider');
  if (slider.value == slider.max) {
    renderPieChart(_lastPieInvestments);
  } else {
    renderPieChartForDate(parseInt(slider.value));
  }
}

async function loadHistoricalAllocation() {
  if (_histAllocData || _histAllocLoading) return;
  _histAllocLoading = true;
  try {
    _histAllocData = await api('/api/historical-allocation');
    const container = document.getElementById('timeSliderContainer');
    const slider = document.getElementById('timeSlider');
    if (_histAllocData.dates && _histAllocData.dates.length > 1) {
      slider.max = _histAllocData.dates.length - 1;
      slider.value = slider.max;
      container.style.display = '';
      document.getElementById('timeSliderLabel').textContent = 'Today';
    }
  } catch(e) {
    console.error('Error loading historical allocation:', e);
  }
  _histAllocLoading = false;
}

function renderPieChartForDate(dateIdx) {
  if (!_histAllocData) return;
  const alloc = _histAllocData.allocations;
  // Build synthetic investments array from allocation data at this date index
  const investments = [];
  for (const cat of Object.keys(alloc)) {
    const val = alloc[cat][dateIdx] || 0;
    if (val > 0) {
      investments.push({ category: cat, type: cat, current_value: val });
    }
  }
  renderPieChart(investments, true);
}

document.getElementById('timeSlider').addEventListener('input', function() {
  const idx = parseInt(this.value);
  const label = document.getElementById('timeSliderLabel');
  if (idx == this.max) {
    label.textContent = 'Today';
    renderPieChart(_lastPieInvestments);
  } else if (_histAllocData && _histAllocData.dates) {
    const d = _histAllocData.dates[idx];
    label.textContent = new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { year: 'numeric', month: 'short', day: 'numeric' });
    renderPieChartForDate(idx);
  }
});
