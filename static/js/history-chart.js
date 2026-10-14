// Historical value / returns line chart

async function loadHistorical() {
  const loading = document.getElementById('histLoading');
  loading.style.display = 'flex';
  const inflation = document.getElementById('inflationToggle').checked;
  const benchmark = document.getElementById('benchmarkToggle').checked;
  try {
    const data = await api(`/api/historical?view=${histView}&inflation=${inflation}&benchmark=${benchmark}`);
    histDataCache = data;
    renderLineChart(filterByTimeRange(data));
  } catch(e) {
    console.error('Error loading historical:', e);
  }
  loading.style.display = 'none';
}

function setTimeRange(range, btn) {
  histTimeRange = range;
  btn.parentElement.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  if (histDataCache) {
    renderLineChart(filterByTimeRange(histDataCache));
  }
}

function renderLineChart(data) {
  const ctx = document.getElementById('lineChart').getContext('2d');
  if (lineChart) lineChart.destroy();
  if (!data.dates || data.dates.length === 0) return;

  const convert = toDisplay;
  const showInvested = document.getElementById('investedToggle').checked;
  const hasBenchmark = data.benchmark && data.benchmark.some(v => v !== null);

  // Benchmark = "what if all invested money went into the index (Nifty 50, MSCI World) instead"
  // Backend returns simulated portfolio value, so we can use it directly or derive returns
  function benchmarkReturnDataset() {
    if (!hasBenchmark) return null;
    const returns = data.benchmark.map((v, i) => {
      const inv = data.invested[i];
      if (v === null || !inv || inv <= 0) return null;
      return ((v - inv) / inv) * 100;
    });
    return {
      label: PAGE.benchmarkLabel,
      data: returns,
      borderColor: '#ef4444',
      backgroundColor: 'transparent',
      borderDash: [4, 4],
      fill: false,
      tension: 0.3,
      pointRadius: 0,
      borderWidth: 2,
      spanGaps: true
    };
  }

  function benchmarkValueDataset() {
    if (!hasBenchmark) return null;
    const values = data.benchmark.map(v => v !== null ? convert(v) : null);
    return {
      label: PAGE.benchmarkLabel,
      data: values,
      borderColor: '#ef4444',
      backgroundColor: 'transparent',
      borderDash: [4, 4],
      fill: false,
      tension: 0.3,
      pointRadius: 0,
      borderWidth: 2,
      spanGaps: true
    };
  }

  if (histView === 'returns') {
    const returns = data.values.map((v, i) => {
      const inv = data.invested[i];
      return inv > 0 ? ((v - inv) / inv) * 100 : 0;
    });
    const datasets = [{
      label: 'Return %',
      data: returns,
      borderColor: '#3b82f6',
      backgroundColor: 'rgba(59,130,246,0.1)',
      fill: true,
      tension: 0.3,
      pointRadius: 0,
      borderWidth: 2
    }, {
      label: '0%',
      data: returns.map(() => 0),
      borderColor: '#6b7280',
      borderDash: [5, 5],
      borderWidth: 1,
      pointRadius: 0,
      fill: false
    }];
    const bmDs = benchmarkReturnDataset();
    if (bmDs) datasets.push(bmDs);

    lineChart = new Chart(ctx, {
      type: 'line',
      data: { labels: data.dates, datasets },
      options: {
        responsive: true,
        interaction: { intersect: false, mode: 'index' },
        scales: {
          x: { ticks: { color: '#9ca3af', maxTicksLimit: 10, font: { size: 10 } }, grid: { color: '#2e3348' } },
          y: {
            ticks: { color: '#9ca3af', font: { size: 10 }, callback: v => v.toFixed(1) + '%' },
            grid: { color: '#2e3348' }
          }
        },
        plugins: {
          legend: { display: bmDs ? true : false, labels: { color: '#d1d5db', usePointStyle: true, pointStyle: 'line', font: { size: 11 } } },
          tooltip: {
            callbacks: {
              label: ctx => {
                if (ctx.dataset.label === '0%') return null;
                return ctx.dataset.label + ': ' + ctx.parsed.y.toFixed(2) + '%';
              }
            }
          }
        }
      }
    });
  } else if (histView === 'current') {
    const values = data.values.map(convert);
    const datasets = [{
      label: 'Current Holdings Value',
      data: values,
      borderColor: '#3b82f6',
      backgroundColor: 'rgba(59,130,246,0.1)',
      fill: true,
      tension: 0.3,
      pointRadius: 0,
      borderWidth: 2
    }];

    const hasMultiple = false;
    lineChart = new Chart(ctx, {
      type: 'line',
      data: { labels: data.dates, datasets },
      options: {
        responsive: true,
        interaction: { intersect: false, mode: 'index' },
        scales: {
          x: { ticks: { color: '#9ca3af', maxTicksLimit: 10, font: { size: 10 } }, grid: { color: '#2e3348' } },
          y: {
            ticks: {
              color: '#9ca3af', font: { size: 10 },
              callback: fmtAxis
            },
            grid: { color: '#2e3348' }
          }
        },
        plugins: {
          legend: { display: hasMultiple, labels: { color: '#d1d5db', usePointStyle: true, pointStyle: 'line', font: { size: 11 } } },
          tooltip: {
            callbacks: {
              label: ctx => ctx.dataset.label + ': ' + fmtAmount(ctx.parsed.y)
            }
          }
        }
      }
    });
  } else {
    // Portfolio Value view
    const values = data.values.map(convert);
    const invested = data.invested.map(convert);
    const datasets = [{
      label: 'Portfolio Value',
      data: values,
      borderColor: '#3b82f6',
      backgroundColor: 'rgba(59,130,246,0.08)',
      fill: true,
      tension: 0.3,
      pointRadius: 0,
      borderWidth: 2
    }];
    if (showInvested) {
      datasets.push({
        label: 'Amount Invested',
        data: invested,
        borderColor: '#f59e0b',
        borderDash: [6, 3],
        backgroundColor: 'transparent',
        fill: false,
        tension: 0.3,
        pointRadius: 0,
        borderWidth: 2
      });
    }
    const bmDs = benchmarkValueDataset();
    if (bmDs) datasets.push(bmDs);

    const hasMultiple = datasets.length > 1;
    lineChart = new Chart(ctx, {
      type: 'line',
      data: { labels: data.dates, datasets },
      options: {
        responsive: true,
        interaction: { intersect: false, mode: 'index' },
        scales: {
          x: { ticks: { color: '#9ca3af', maxTicksLimit: 10, font: { size: 10 } }, grid: { color: '#2e3348' } },
          y: {
            ticks: {
              color: '#9ca3af', font: { size: 10 },
              callback: fmtAxis
            },
            grid: { color: '#2e3348' }
          }
        },
        plugins: {
          legend: { display: hasMultiple, labels: { color: '#d1d5db', usePointStyle: true, pointStyle: 'line', font: { size: 11 } } },
          tooltip: {
            callbacks: {
              label: ctx => ctx.dataset.label + ': ' + fmtAmount(ctx.parsed.y)
            }
          }
        }
      }
    });
  }
}

function setHistView(view, btn) {
  histView = view;
  btn.parentElement.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  loadHistorical();
}
