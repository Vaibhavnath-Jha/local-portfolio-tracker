// Add / edit / delete investments and transactions

// --- Add Investment Modal ---
function openAddModal() {
  document.getElementById('addModal').classList.add('show');
  onTypeChange();
}
function closeModal() {
  document.getElementById('addModal').classList.remove('show');
  clearForm();
}

function onTypeChange() {
  const t = document.getElementById('invType').value;
  document.getElementById('marketFields').style.display = ['stock','etf','gold_etf','mutual_fund','crypto'].includes(t) ? 'block' : 'none';
  document.getElementById('pfFields').style.display = t === 'pf' ? 'block' : 'none';
  document.getElementById('fdFields').style.display = t === 'fd' ? 'block' : 'none';

  const sl = document.getElementById('searchLabel');
  if (t === 'mutual_fund') sl.textContent = 'Search Mutual Fund';
  else if (t === 'crypto') sl.textContent = 'Search Cryptocurrency';
  else sl.textContent = 'Search Ticker (e.g. RELIANCE, NIFTYBEES)';

  document.getElementById('searchResults').style.display = 'none';
  document.getElementById('searchInput').value = '';
  document.getElementById('assetName').value = '';
  document.getElementById('assetTicker').value = '';
}

function debounceSearch() {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(doSearch, 400);
}

async function doSearch() {
  const q = document.getElementById('searchInput').value.trim();
  const t = document.getElementById('invType').value;
  if (q.length < 2) { document.getElementById('searchResults').style.display = 'none'; return; }

  let url;
  if (t === 'mutual_fund') url = `/api/search/mf?q=${encodeURIComponent(q)}`;
  else if (t === 'crypto') url = `/api/search/crypto?q=${encodeURIComponent(q)}`;
  else url = `/api/search/stock?q=${encodeURIComponent(q)}`;

  try {
    const results = await api(url);
    const container = document.getElementById('searchResults');

    if (!Array.isArray(results) || results.length === 0) {
      container.innerHTML = '<div style="color:var(--muted)">No results found</div>';
      container.style.display = 'block';
      return;
    }

    let html = '';
    if (t === 'mutual_fund') {
      for (const r of results) {
        html += `<div onclick="selectMF(${jsArg(r.schemeCode)}, ${jsArg(r.schemeName)})">
          ${esc(r.schemeName)} <small>(${esc(r.schemeCode)})</small></div>`;
      }
    } else if (t === 'crypto') {
      for (const r of results) {
        html += `<div onclick="selectCrypto(${jsArg(r.id)}, ${jsArg(r.name)})">
          ${esc(r.name)} <small>(${esc(String(r.symbol || '').toUpperCase())})</small></div>`;
      }
    } else {
      for (const r of results) {
        html += `<div onclick="selectStock(${jsArg(r.ticker)}, ${jsArg(r.name)})">
          ${esc(r.name)} <small>(${esc(r.ticker)} - ${esc(r.exchange)})</small></div>`;
      }
    }
    container.innerHTML = html;
    container.style.display = 'block';
  } catch(e) {
    console.error(e);
  }
}

function selectStock(ticker, name) {
  document.getElementById('assetTicker').value = ticker;
  document.getElementById('assetName').value = name;
  document.getElementById('searchResults').style.display = 'none';
  document.getElementById('searchInput').value = ticker;
}
function selectMF(code, name) {
  document.getElementById('assetTicker').value = code;
  document.getElementById('assetName').value = name;
  document.getElementById('searchResults').style.display = 'none';
  document.getElementById('searchInput').value = name;
}
function selectCrypto(id, name) {
  document.getElementById('assetTicker').value = id;
  document.getElementById('assetName').value = name;
  document.getElementById('searchResults').style.display = 'none';
  document.getElementById('searchInput').value = name;
}

async function submitInvestment() {
  const t = document.getElementById('invType').value;
  let body = { type: t, category: t };

  if (['stock', 'etf', 'gold_etf'].includes(t)) {
    body.name = document.getElementById('assetName').value;
    body.ticker = document.getElementById('assetTicker').value || document.getElementById('searchInput').value.toUpperCase() + '.NS';
    body.transaction = {
      date: document.getElementById('txnDate').value,
      quantity: document.getElementById('txnQty').value,
      buy_price: document.getElementById('txnPrice').value
    };
  } else if (t === 'mutual_fund') {
    body.name = document.getElementById('assetName').value;
    body.scheme_code = document.getElementById('assetTicker').value;
    body.transaction = {
      date: document.getElementById('txnDate').value,
      quantity: document.getElementById('txnQty').value,
      buy_price: document.getElementById('txnPrice').value
    };
  } else if (t === 'crypto') {
    body.name = document.getElementById('assetName').value;
    body.coin_id = document.getElementById('assetTicker').value;
    body.transaction = {
      date: document.getElementById('txnDate').value,
      quantity: document.getElementById('txnQty').value,
      buy_price: document.getElementById('txnPrice').value
    };
  } else if (t === 'pf') {
    body.name = document.getElementById('pfName').value;
    body.interest_rate = parseFloat(document.getElementById('pfRate').value);
    body.contribution = {
      date: document.getElementById('pfDate').value,
      amount: document.getElementById('pfAmount').value
    };
  } else if (t === 'fd') {
    body.name = document.getElementById('fdName').value;
    body.principal = parseFloat(document.getElementById('fdPrincipal').value);
    body.interest_rate = parseFloat(document.getElementById('fdRate').value);
    body.start_date = document.getElementById('fdStart').value;
    body.maturity_date = document.getElementById('fdMaturity').value;
    body.compounding = document.getElementById('fdCompounding').value;
  }

  try {
    await sendJSON('/api/investment', 'POST', body);
  } catch (e) {
    alert('Could not add investment: ' + e.message);
    return;
  }
  closeModal();
  await afterChange();
}

// --- Transaction Modal ---
function openTxnModal(invId, invType, name) {
  document.getElementById('txnModal').classList.add('show');
  document.getElementById('txnInvId').value = invId;
  document.getElementById('txnInvType').value = invType;
  document.getElementById('txnModalTitle').textContent = 'Add to ' + name;
  document.getElementById('txnMarketFields').style.display = invType === 'pf' ? 'none' : 'block';
  document.getElementById('txnPfFields').style.display = invType === 'pf' ? 'block' : 'none';
}
function closeTxnModal() {
  document.getElementById('txnModal').classList.remove('show');
}

async function submitTransaction() {
  const invId = document.getElementById('txnInvId').value;
  const invType = document.getElementById('txnInvType').value;
  let body;
  if (invType === 'pf') {
    body = { date: document.getElementById('txnPfDate').value, amount: document.getElementById('txnPfAmount').value };
  } else {
    body = {
      date: document.getElementById('txnAddDate').value,
      quantity: document.getElementById('txnAddQty').value,
      buy_price: document.getElementById('txnAddPrice').value
    };
  }
  try {
    await sendJSON(`/api/investment/${encodeURIComponent(invId)}/transaction`, 'POST', body);
  } catch (e) {
    alert('Could not add transaction: ' + e.message);
    return;
  }
  closeTxnModal();
  await afterChange();
}

async function deleteInvestment(id) {
  if (!confirm('Delete this investment?')) return;
  try {
    await api(`/api/investment/${encodeURIComponent(id)}`, { method: 'DELETE' });
  } catch (e) {
    alert('Could not delete investment: ' + e.message);
    return;
  }
  await loadPortfolio();
  loadHistorical();
}

async function deleteTxn(invId, txnId) {
  if (!confirm('Delete this transaction?')) return;
  try {
    await api(`/api/investment/${encodeURIComponent(invId)}/transaction/${encodeURIComponent(txnId)}`, { method: 'DELETE' });
  } catch (e) {
    alert('Could not delete transaction: ' + e.message);
    return;
  }
  await loadPortfolio();
  loadHistorical();
}

// --- Edit Transaction Modal ---
function openEditTxnModal(invId, txnId, txnType, date, qty, price, amount) {
  document.getElementById('editTxnModal').classList.add('show');
  document.getElementById('editTxnInvId').value = invId;
  document.getElementById('editTxnId').value = txnId;
  document.getElementById('editTxnType').value = txnType;

  if (txnType === 'pf') {
    document.getElementById('editMarketFields').style.display = 'none';
    document.getElementById('editPfFields').style.display = 'block';
    document.getElementById('editPfAmount').value = amount;
    const fp = document.getElementById('editPfDate')._flatpickr;
    if (fp) fp.setDate(date, true);
  } else {
    document.getElementById('editMarketFields').style.display = 'block';
    document.getElementById('editPfFields').style.display = 'none';
    document.getElementById('editQty').value = qty;
    document.getElementById('editPrice').value = price;
    const fp = document.getElementById('editDate')._flatpickr;
    if (fp) fp.setDate(date, true);
  }
}

function closeEditTxnModal() {
  document.getElementById('editTxnModal').classList.remove('show');
}

async function submitEditTransaction() {
  const invId = document.getElementById('editTxnInvId').value;
  const txnId = document.getElementById('editTxnId').value;
  const txnType = document.getElementById('editTxnType').value;
  let body;
  if (txnType === 'pf') {
    body = { date: document.getElementById('editPfDate').value, amount: document.getElementById('editPfAmount').value };
  } else {
    body = {
      date: document.getElementById('editDate').value,
      quantity: document.getElementById('editQty').value,
      buy_price: document.getElementById('editPrice').value
    };
  }
  try {
    await sendJSON('/api/investment/' + encodeURIComponent(invId) + '/transaction/' + encodeURIComponent(txnId), 'PUT', body);
  } catch (e) {
    alert('Could not save transaction: ' + e.message);
    return;
  }
  closeEditTxnModal();
  await afterChange();
}

// --- Edit Investment Modal ---
function openEditInvModal(invId) {
  var inv = portfolioData.investments.find(function(i) { return i.id === invId; });
  if (!inv) return;

  document.getElementById('editInvModal').classList.add('show');
  document.getElementById('editInvId').value = invId;
  document.getElementById('editInvType').value = inv.type;
  document.getElementById('editInvName').value = inv.name;

  // Populate type-specific fields
  document.getElementById('editInvTicker').value = inv.ticker || '';
  document.getElementById('editInvSchemeCode').value = inv.scheme_code || '';
  document.getElementById('editInvCoinId').value = inv.coin_id || '';
  document.getElementById('editInvPfRate').value = inv.interest_rate || '';
  document.getElementById('editInvFdPrincipal').value = inv.principal || '';
  document.getElementById('editInvFdRate').value = inv.interest_rate || '';
  document.getElementById('editInvFdCompounding').value = inv.compounding || 'quarterly';
  var fpStart = document.getElementById('editInvFdStart')._flatpickr;
  var fpMat = document.getElementById('editInvFdMaturity')._flatpickr;
  if (fpStart) fpStart.setDate(inv.start_date || '', true);
  if (fpMat) fpMat.setDate(inv.maturity_date || '', true);

  onEditInvTypeChange();
}

function onEditInvTypeChange() {
  var t = document.getElementById('editInvType').value;
  ['editInvStockFields','editInvMfFields','editInvCryptoFields','editInvPfFields','editInvFdFields'].forEach(function(id) {
    document.getElementById(id).style.display = 'none';
  });
  if (['stock','etf','gold_etf'].includes(t)) {
    document.getElementById('editInvStockFields').style.display = 'block';
  } else if (t === 'mutual_fund') {
    document.getElementById('editInvMfFields').style.display = 'block';
  } else if (t === 'crypto') {
    document.getElementById('editInvCryptoFields').style.display = 'block';
  } else if (t === 'pf') {
    document.getElementById('editInvPfFields').style.display = 'block';
  } else if (t === 'fd') {
    document.getElementById('editInvFdFields').style.display = 'block';
  }
}

function closeEditInvModal() {
  document.getElementById('editInvModal').classList.remove('show');
}

async function submitEditInvestment() {
  var invId = document.getElementById('editInvId').value;
  var invType = document.getElementById('editInvType').value;
  var body = { name: document.getElementById('editInvName').value, type: invType, category: invType };

  if (['stock','etf','gold_etf'].includes(invType)) {
    body.ticker = document.getElementById('editInvTicker').value;
  } else if (invType === 'mutual_fund') {
    body.scheme_code = document.getElementById('editInvSchemeCode').value;
  } else if (invType === 'crypto') {
    body.coin_id = document.getElementById('editInvCoinId').value;
  } else if (invType === 'pf') {
    body.interest_rate = parseFloat(document.getElementById('editInvPfRate').value);
  } else if (invType === 'fd') {
    body.principal = parseFloat(document.getElementById('editInvFdPrincipal').value);
    body.interest_rate = parseFloat(document.getElementById('editInvFdRate').value);
    body.start_date = document.getElementById('editInvFdStart').value;
    body.maturity_date = document.getElementById('editInvFdMaturity').value;
    body.compounding = document.getElementById('editInvFdCompounding').value;
  }

  try {
    await sendJSON('/api/investment/' + encodeURIComponent(invId), 'PUT', body);
  } catch (e) {
    alert('Could not save investment: ' + e.message);
    return;
  }
  closeEditInvModal();
  await afterChange();
}

function clearForm() {
  // Restore each input's HTML default (e.g. PF name "EPF", rate 8.25) rather than blanking it
  document.querySelectorAll('.modal input[type="text"], .modal input[type="number"]').forEach(i => i.value = i.defaultValue);
  document.querySelectorAll('.modal .datepicker').forEach(el => {
    if (el._flatpickr) el._flatpickr.clear();
  });
  document.getElementById('searchResults').style.display = 'none';
}
