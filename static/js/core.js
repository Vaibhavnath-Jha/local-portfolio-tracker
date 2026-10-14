// Shared state, constants, formatting and API helpers

// Set by the page template: the region's config, or just a default currency on the combined page
const PAGE = window.PAGE;

let portfolioData = null;
// Display currency, and the rate converting the page's own currency into it
let currency = PAGE.currency;
let fxRate = 1;
let pieChart = null;
let lineChart = null;
let histView = 'value';
let histTimeRange = 'MAX';
let histDataCache = null;
let invFilter = 'current';
let classFilter = 'all';
let searchTimeout = null;

const CATEGORY_COLORS = {
  stock: '#3b82f6', etf: '#a855f7', gold_etf: '#eab308',
  mutual_fund: '#06b6d4', crypto: '#f97316', pf: '#22c55e', fd: '#ec4899'
};
const CATEGORY_LABELS = Object.assign({
  stock: 'Stocks', etf: 'ETFs', gold_etf: 'Gold ETFs',
  mutual_fund: 'Mutual Funds', crypto: 'Crypto', pf: 'Provident Fund', fd: 'Fixed Deposits'
}, PAGE.categoryLabels);
const BROAD_CATEGORY_MAP = {
  stock: 'equity', etf: 'equity', mutual_fund: 'equity',
  gold_etf: 'commodities', crypto: 'crypto', pf: 'debt', fd: 'debt'
};
const BROAD_CATEGORY_LABELS = {
  equity: 'Equity', debt: 'Debt', commodities: 'Commodities', crypto: 'Crypto'
};
const BROAD_CATEGORY_COLORS = {
  equity: '#3b82f6', debt: '#22c55e', commodities: '#eab308', crypto: '#f97316'
};
let allocView = 'category';
let _lastPieInvestments = [];
let pieDrillCategory = null;
let _histAllocData = null;
let _histAllocLoading = false;

function computeXirrJS(flows) {
  // flows: [[date_str, amount], ...] where negative = outflow
  if (!flows || flows.length < 2) return null;
  const parsed = flows.map(([d, a]) => [new Date(d + 'T00:00:00'), a]).sort((a, b) => a[0] - b[0]);
  const d0 = parsed[0][0];
  const dayMs = 86400000;
  function npv(rate) {
    let s = 0;
    for (const [dt, amt] of parsed) s += amt / Math.pow(1 + rate, (dt - d0) / dayMs / 365.25);
    return s;
  }
  function dnpv(rate) {
    let s = 0;
    for (const [dt, amt] of parsed) {
      const y = (dt - d0) / dayMs / 365.25;
      s += -y * amt / Math.pow(1 + rate, y + 1);
    }
    return s;
  }
  let rate = 0.1;
  for (let i = 0; i < 200; i++) {
    const n = npv(rate), d = dnpv(rate);
    if (Math.abs(d) < 1e-12) break;
    let nr = rate - n / d;
    nr = Math.max(nr, -0.99);
    if (Math.abs(nr - rate) < 1e-9) return parseFloat((nr * 100).toFixed(2));
    rate = nr;
  }
  if (Math.abs(npv(rate)) < 1.0) return parseFloat((rate * 100).toFixed(2));
  return null;
}

function toNumber(val) {
  const n = Number(val);
  return isFinite(n) ? n : 0;
}

const CURRENCY_SYMBOLS = { INR: '\u20B9', EUR: '\u20AC', USD: '$' };

// Convert an amount in the page's currency into the display currency
function toDisplay(val) {
  return toNumber(val) * fxRate;
}

// Format an amount that is already in the display currency
function fmtAmount(val, digits = 0) {
  const locale = currency === 'INR' ? 'en-IN' : 'en-US';
  return CURRENCY_SYMBOLS[currency] + toNumber(val).toLocaleString(locale, { maximumFractionDigits: digits });
}

// Compact chart-axis label for an amount in the display currency (lakhs for INR, k/M otherwise)
function fmtAxis(v) {
  const sym = CURRENCY_SYMBOLS[currency];
  if (currency === 'INR') return sym + (v >= 100000 ? (v / 100000).toFixed(1) + 'L' : v.toLocaleString('en-IN'));
  if (Math.abs(v) >= 1e6) return sym + (v / 1e6).toFixed(1) + 'M';
  if (Math.abs(v) >= 1e3) return sym + (v / 1e3).toFixed(0) + 'k';
  return sym + v.toLocaleString('en-US');
}

function fmt(val) {
  return fmtAmount(toDisplay(val), 0);
}

function fmtDetailed(val) {
  return fmtAmount(toDisplay(val), 2);
}

// The display currency is shared by all pages
function savedCurrency() {
  try {
    const c = localStorage.getItem('displayCurrency');
    return CURRENCY_SYMBOLS[c] ? c : null;
  } catch (e) { return null; }
}

function saveCurrency(c) {
  try { localStorage.setItem('displayCurrency', c); } catch (e) { /* storage blocked */ }
}

function showCurrency() {
  const radio = document.querySelector(`input[name="currency"][value="${currency}"]`);
  if (radio) radio.checked = true;
}

// Keep only the points in the selected time range (every array in data runs parallel to data.dates)
function filterByTimeRange(data, range = histTimeRange) {
  if (!data || !data.dates || data.dates.length === 0 || range === 'MAX') return data;
  const now = new Date();
  const rangeMap = { '1M': 1, '3M': 3, '6M': 6, '1Y': 12, '3Y': 36, '5Y': 60 };
  const cutoff = new Date(now.getFullYear(), now.getMonth() - rangeMap[range], now.getDate());
  const startIdx = data.dates.findIndex(d => new Date(d) >= cutoff);
  if (startIdx <= 0) return data;
  const slice = obj => {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = Array.isArray(v) ? v.slice(startIdx) : (v && typeof v === 'object') ? slice(v) : v;
    }
    return out;
  };
  return slice(data);
}

// Escape a value for use as HTML text or inside a quoted attribute
function esc(val) {
  return String(val ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

// Encode a value as a JS string literal for an inline onclick="fn(...)" attribute
function jsArg(val) {
  return esc(JSON.stringify(String(val ?? '')));
}

// Send the user back to the login page once their session has expired
function checkLoggedIn(resp) {
  if (resp.status === 401) {
    window.location.href = '/login';
    throw new Error('Session expired, please log in again');
  }
}

// fetch wrapper that throws with the server's message on any failure
// Point an API URL at this page's region portfolio
function regionUrl(url) {
  if (!PAGE.region) return url;
  return url + (url.includes('?') ? '&' : '?') + 'region=' + encodeURIComponent(PAGE.region);
}

async function api(url, options) {
  const resp = await fetch(regionUrl(url), options);
  checkLoggedIn(resp);
  let data = null;
  try { data = await resp.json(); } catch (e) { /* non-JSON body */ }
  if (!resp.ok || (data && data.status === 'error')) {
    throw new Error((data && data.message) || ('Request failed (HTTP ' + resp.status + ')'));
  }
  return data;
}

function sendJSON(url, method, body) {
  return api(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
