// Shared state, constants, formatting and API helpers

let portfolioData = null;
let currency = 'INR';
let usdRate = 83;
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
const CATEGORY_LABELS = {
  stock: 'Stocks', etf: 'ETFs', gold_etf: 'Gold ETFs',
  mutual_fund: 'Mutual Funds', crypto: 'Crypto', pf: 'Provident Fund', fd: 'Fixed Deposits'
};
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

function fmt(val) {
  val = toNumber(val);
  if (currency === 'USD') val = val / usdRate;
  const sym = currency === 'INR' ? '\u20B9' : '$';
  return sym + val.toLocaleString('en-IN', { maximumFractionDigits: 0 });
}

function fmtDetailed(val) {
  val = toNumber(val);
  if (currency === 'USD') val = val / usdRate;
  const sym = currency === 'INR' ? '\u20B9' : '$';
  return sym + val.toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

// Escape a value for use as HTML text or inside a quoted attribute
function esc(val) {
  return String(val ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

// Encode a value as a JS string literal for an inline onclick="fn(...)" attribute
function jsArg(val) {
  return esc(JSON.stringify(String(val ?? '')));
}

// fetch wrapper that throws with the server's message on any failure
async function api(url, options) {
  const resp = await fetch(url, options);
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
