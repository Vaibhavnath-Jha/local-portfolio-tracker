// Combined view: every region's portfolio in one display currency.
// The server converts all amounts, so values arrive ready to format (fxRate stays 1).

const REGION_COLORS = { in: '#a855f7', de: '#06b6d4' };
let combinedData = null;
let combinedHistory = null;
let _loadId = 0;

function setCurrency(c) {
  currency = c;
  saveCurrency(c);
  showCurrency();
  loadCombined();
}

function setLoading(id, on) {
  document.getElementById(id).style.display = on ? 'flex' : 'none';
}

function loadCombined() {
  // A currency switch while loading makes earlier responses stale
  const loadId = ++_loadId;
  const query = '?currency=' + encodeURIComponent(currency);
  setLoading('summaryLoading', true);
  setLoading('histLoading', true);

  api('/api/combined' + query).then(data => {
    if (loadId !== _loadId) return;
    combinedData = data;
    renderSummary();
  }).catch(e => {
    if (loadId === _loadId) alert('Could not load the combined portfolio: ' + e.message);
  }).finally(() => {
    if (loadId === _loadId) setLoading('summaryLoading', false);
  });

  api('/api/combined/history' + query).then(data => {
    if (loadId !== _loadId) return;
    combinedHistory = data;
    renderCombinedHistory();
  }).catch(e => {
    console.error('Error loading combined history:', e);
  }).finally(() => {
    if (loadId === _loadId) setLoading('histLoading', false);
  });
}

function signed(pct) {
  return (pct >= 0 ? '+' : '') + pct + '%';
}

function renderSummary() {
  const d = combinedData;
  document.getElementById('totalValue').textContent = fmt(d.total_value);
  document.getElementById('totalInvested').textContent = fmt(d.total_invested);

  const glClass = d.total_gain_loss >= 0 ? 'positive' : 'negative';
  const glEl = document.getElementById('totalGainLoss');
  glEl.textContent = fmt(d.total_gain_loss);
  glEl.className = 'card-value ' + glClass;
  const glPctEl = document.getElementById('totalGainLossPct');
  glPctEl.textContent = signed(d.total_gain_loss_pct);
  glPctEl.className = 'card-sub ' + glClass;

  const xirrEl = document.getElementById('xirrValue');
  xirrEl.textContent = d.xirr !== null ? signed(d.xirr) : '--';
  xirrEl.className = 'card-value' + (d.xirr !== null ? (d.xirr >= 0 ? ' positive' : ' negative') : '');

  renderRegionPie(d.regions);
  renderRegionTable(d.regions);
}

function renderRegionPie(regions) {
  if (pieChart) pieChart.destroy();
  pieChart = null;
  const shown = regions.filter(r => r.value > 0);
  if (shown.length === 0) return;
  pieChart = new Chart(document.getElementById('pieChart').getContext('2d'), {
    type: 'doughnut',
    data: {
      labels: shown.map(r => r.name),
      datasets: [{ data: shown.map(r => r.value), backgroundColor: shown.map(r => REGION_COLORS[r.id] || '#666'), borderWidth: 0 }]
    },
    options: {
      responsive: true,
      onClick: (evt, elements) => {
        if (elements.length) window.location.href = PAGE.regions.find(r => r.id === shown[elements[0].index].id).url;
      },
      onHover: (evt, elements) => { evt.native.target.style.cursor = elements.length ? 'pointer' : 'default'; },
      plugins: {
        legend: { position: 'bottom', labels: { color: '#9ca3af', font: { size: 11 } } },
        tooltip: {
          callbacks: {
            label: ctx => {
              const total = ctx.dataset.data.reduce((a, b) => a + b, 0);
              return ctx.label + ': ' + fmtAmount(ctx.parsed) + ' (' + (ctx.parsed / total * 100).toFixed(1) + '%)';
            }
          }
        }
      }
    }
  });
}

function renderRegionTable(regions) {
  const total = regions.reduce((sum, r) => sum + Math.max(r.value, 0), 0);
  let html = '';
  for (const r of regions) {
    const glClass = r.gain_loss >= 0 ? 'positive' : 'negative';
    const xirrClass = r.xirr !== null ? (r.xirr >= 0 ? 'positive' : 'negative') : '';
    const page = PAGE.regions.find(p => p.id === r.id);
    const share = total > 0 ? (Math.max(r.value, 0) / total * 100).toFixed(1) + '%' : '--';
    html += `<tr>
      <td><a href="${esc(page.url)}" style="color:var(--text);"><strong>${esc(r.name)}</strong></a>
        <span style="color:var(--muted);font-size:0.75rem;">${esc(r.currency)}</span></td>
      <td>${esc(r.count)}</td>
      <td>${fmtDetailed(r.invested)}</td>
      <td>${fmtDetailed(r.value)}</td>
      <td class="${glClass}">${fmtDetailed(r.gain_loss)} (${signed(r.gain_loss_pct)})</td>
      <td class="${xirrClass}">${r.xirr !== null ? signed(r.xirr) : '--'}</td>
      <td style="text-align:right;">${share}</td>
    </tr>`;
  }
  document.getElementById('regionBody').innerHTML = html;
}

function renderCombinedHistory() {
  if (lineChart) lineChart.destroy();
  lineChart = null;
  if (!combinedHistory || combinedHistory.dates.length === 0) return;
  const data = filterByTimeRange(combinedHistory);

  // Region values stack into the total; the invested line sits in its own stack so it isn't added on top
  const datasets = PAGE.regions.filter(r => data.regions[r.id]).map((r, i) => ({
    label: r.name,
    data: data.regions[r.id],
    stack: 'value',
    borderColor: REGION_COLORS[r.id] || '#666',
    backgroundColor: (REGION_COLORS[r.id] || '#666666') + '33',
    fill: i === 0 ? 'origin' : '-1',
    tension: 0.3,
    pointRadius: 0,
    borderWidth: 2
  }));
  if (document.getElementById('investedToggle').checked) {
    datasets.push({
      label: 'Amount Invested',
      data: data.invested,
      stack: 'invested',
      borderColor: '#f59e0b',
      borderDash: [6, 3],
      backgroundColor: 'transparent',
      fill: false,
      tension: 0.3,
      pointRadius: 0,
      borderWidth: 2
    });
  }

  lineChart = new Chart(document.getElementById('lineChart').getContext('2d'), {
    type: 'line',
    data: { labels: data.dates, datasets },
    options: {
      responsive: true,
      interaction: { intersect: false, mode: 'index' },
      scales: {
        x: { ticks: { color: '#9ca3af', maxTicksLimit: 10, font: { size: 10 } }, grid: { color: '#2e3348' } },
        y: { stacked: true, beginAtZero: true, ticks: { color: '#9ca3af', font: { size: 10 }, callback: fmtAxis }, grid: { color: '#2e3348' } }
      },
      plugins: {
        legend: { labels: { color: '#d1d5db', usePointStyle: true, pointStyle: 'line', font: { size: 11 } } },
        tooltip: {
          callbacks: {
            label: ctx => ctx.dataset.label + ': ' + fmtAmount(ctx.parsed.y),
            footer: items => {
              const total = items.filter(i => i.dataset.stack === 'value').reduce((sum, i) => sum + i.parsed.y, 0);
              return 'Total: ' + fmtAmount(total);
            }
          }
        }
      }
    }
  });
}

function setTimeRange(range, btn) {
  histTimeRange = range;
  btn.parentElement.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  renderCombinedHistory();
}

async function refreshPrices() {
  const btn = document.getElementById('refreshBtn');
  btn.innerHTML = '<span class="spinner"></span> Refreshing...';
  btn.disabled = true;
  try {
    await api('/api/refresh', { method: 'POST' });
    loadCombined();
  } catch (e) {
    alert('Could not refresh prices: ' + e.message);
  } finally {
    btn.textContent = 'Refresh Prices';
    btn.disabled = false;
  }
}

// Init
currency = savedCurrency() || currency;
showCurrency();
loadCombined();
