// Loading, rendering and refreshing the portfolio summary

const _fxRates = {};

async function setCurrency(c) {
  if (c !== PAGE.currency && !_fxRates[c]) {
    try {
      _fxRates[c] = (await api('/api/exchange-rate?to=' + c)).rate;
    } catch (e) {
      alert('Could not fetch the ' + c + ' exchange rate: ' + e.message);
      showCurrency();
      return;
    }
  }
  currency = c;
  fxRate = c === PAGE.currency ? 1 : _fxRates[c];
  saveCurrency(c);
  showCurrency();
  renderPortfolio();
  if (histDataCache) renderLineChart(filterByTimeRange(histDataCache));
}

async function loadPortfolio() {
  try {
    portfolioData = await api('/api/portfolio');
  } catch (e) {
    alert('Could not load portfolio: ' + e.message);
    return;
  }
  renderPortfolio();
  loadHistoricalAllocation();
}

function renderPortfolio() {
  if (!portfolioData) return;
  const d = portfolioData;

  document.getElementById('totalValue').textContent = fmt(d.total_value);
  document.getElementById('totalInvested').textContent = fmt(d.total_invested);

  const glEl = document.getElementById('totalGainLoss');
  glEl.textContent = fmt(d.total_gain_loss);
  glEl.className = 'card-value ' + (d.total_gain_loss >= 0 ? 'positive' : 'negative');
  document.getElementById('totalGainLossPct').textContent =
    (d.total_gain_loss >= 0 ? '+' : '') + d.total_gain_loss_pct + '%';
  document.getElementById('totalGainLossPct').className =
    'card-sub ' + (d.total_gain_loss >= 0 ? 'positive' : 'negative');

  const xirrEl = document.getElementById('xirrValue');
  if (d.xirr !== null && d.xirr !== undefined) {
    xirrEl.textContent = (d.xirr >= 0 ? '+' : '') + d.xirr + '%';
    xirrEl.className = 'card-value ' + (d.xirr >= 0 ? 'positive' : 'negative');
  } else {
    xirrEl.textContent = '--';
    xirrEl.className = 'card-value';
  }

  renderPieChart(d.investments);
  renderTable(d.investments);
}

async function refreshPrices() {
  const btn = document.getElementById('refreshBtn');
  btn.innerHTML = '<span class="spinner"></span> Refreshing...';
  btn.disabled = true;
  try {
    await api('/api/refresh', { method: 'POST' });
    _histAllocData = null;
    await loadPortfolio();
    await loadHistorical();
  } catch (e) {
    alert('Could not refresh prices: ' + e.message);
  } finally {
    btn.textContent = 'Refresh Prices';
    btn.disabled = false;
  }
}

// Reload everything after a successful change
async function afterChange() {
  try { await api('/api/refresh', { method: 'POST' }); } catch (e) { console.error(e); }
  await loadPortfolio();
  loadHistorical();
}
