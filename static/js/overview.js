// Overview: a quick summary of each region's portfolio, each in its own currency

const ALLOC_ORDER = ['equity', 'commodities', 'crypto', 'debt'];
const TOP_HOLDINGS = 5;

function signed(pct) {
  return (pct >= 0 ? '+' : '') + pct + '%';
}

function field(card, name) {
  return card.querySelector(`[data-field="${name}"]`);
}

function loadRegion(region) {
  const card = document.getElementById('region-' + region.id);
  const overlay = card.querySelector('.loading-overlay');
  overlay.style.display = 'flex';
  return api('/api/portfolio?region=' + encodeURIComponent(region.id))
    .then(data => renderRegion(card, region.currency, data))
    .catch(e => {
      field(card, 'value').textContent = '--';
      field(card, 'alloc').innerHTML = `<div class="negative" style="font-size:0.85rem;">Could not load: ${esc(e.message)}</div>`;
    })
    .finally(() => { overlay.style.display = 'none'; });
}

function renderRegion(card, cur, d) {
  const money = val => fmtAmount(val, 0, cur);
  field(card, 'value').textContent = money(d.total_value);
  field(card, 'invested').textContent = money(d.total_invested);

  const glClass = d.total_gain_loss >= 0 ? 'positive' : 'negative';
  const gain = field(card, 'gain');
  gain.textContent = money(d.total_gain_loss);
  gain.className = 'card-value ' + glClass;
  const gainPct = field(card, 'gainPct');
  gainPct.textContent = signed(d.total_gain_loss_pct);
  gainPct.className = 'card-sub ' + glClass;

  const xirr = field(card, 'xirr');
  xirr.textContent = d.xirr !== null ? signed(d.xirr) : '--';
  xirr.className = 'card-value' + (d.xirr !== null ? (d.xirr >= 0 ? ' positive' : ' negative') : '');

  const holdings = d.investments.filter(inv => !inv.error && inv.current_value > 0);
  field(card, 'alloc').innerHTML = allocationHtml(holdings, d.total_value);
  field(card, 'top').innerHTML = topHoldingsHtml(holdings, money);
}

function allocationHtml(holdings, total) {
  if (!holdings.length || total <= 0) return '<div class="empty-state" style="padding:12px;">No current investments.</div>';
  const totals = {};
  for (const inv of holdings) {
    const key = BROAD_CATEGORY_MAP[inv.category || inv.type] || inv.type;
    totals[key] = (totals[key] || 0) + inv.current_value;
  }
  const parts = ALLOC_ORDER.filter(k => totals[k] > 0).map(k => ({
    label: BROAD_CATEGORY_LABELS[k], color: BROAD_CATEGORY_COLORS[k], pct: totals[k] / total * 100
  }));
  const bar = parts.map(p => `<div style="width:${p.pct}%;background:${p.color};" title="${esc(p.label)}"></div>`).join('');
  const legend = parts.map(p => `<span style="--dot:${p.color};">${esc(p.label)} ${p.pct.toFixed(1)}%</span>`).join('');
  return `<div class="section-label">Allocation &middot; ${holdings.length} holding${holdings.length === 1 ? '' : 's'}</div>
    <div class="alloc-bar">${bar}</div><div class="alloc-legend">${legend}</div>`;
}

function topHoldingsHtml(holdings, money) {
  if (!holdings.length) return '';
  const top = [...holdings].sort((a, b) => b.current_value - a.current_value).slice(0, TOP_HOLDINGS);
  const rows = top.map(inv => {
    const glClass = inv.gain_loss >= 0 ? 'positive' : 'negative';
    return `<li><span class="name">${esc(inv.name)}</span>
      <span class="amt">${money(inv.current_value)} <span class="${glClass}">${signed(inv.gain_loss_pct)}</span></span></li>`;
  }).join('');
  return `<div class="section-label">Top holdings</div><ul class="top-list">${rows}</ul>`;
}

function loadAll() {
  return Promise.all(PAGE.regions.map(loadRegion));
}

async function refreshPrices() {
  const btn = document.getElementById('refreshBtn');
  btn.innerHTML = '<span class="spinner"></span> Refreshing...';
  btn.disabled = true;
  try {
    await api('/api/refresh', { method: 'POST' });
    await loadAll();
  } catch (e) {
    alert('Could not refresh prices: ' + e.message);
  } finally {
    btn.textContent = 'Refresh Prices';
    btn.disabled = false;
  }
}

// Init
loadAll();
