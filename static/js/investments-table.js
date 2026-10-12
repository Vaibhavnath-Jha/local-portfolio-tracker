// Investments table: filters, rows and expandable sub-rows

function isCurrentInvestment(inv) {
  // Keep broken entries visible so they can be fixed
  if (inv.error) return true;
  if (inv.type === 'fd') {
    // FD is past if maturity date has passed
    return !inv.maturity_date || inv.maturity_date >= new Date().toISOString().slice(0, 10);
  }
  if (inv.type === 'pf') {
    // PF is current if it has contributions
    return (inv.contributions || []).length > 0;
  }
  // Market assets: current if total quantity > 0
  return (inv.total_quantity || 0) > 0.001;
}

function setInvFilter(filter, btn) {
  invFilter = filter;
  btn.parentElement.querySelectorAll('.toggle-btn').forEach(function(b) { b.classList.remove('active'); });
  btn.classList.add('active');
  renderPortfolio();
}

function setClassFilter(filter, btn) {
  classFilter = filter;
  btn.parentElement.querySelectorAll('.toggle-btn').forEach(function(b) { b.classList.remove('active'); });
  btn.classList.add('active');
  renderPortfolio();
}

function renderTable(investments) {
  const tbody = document.getElementById('invBody');
  const empty = document.getElementById('emptyState');

  // Filter investments based on selected view and asset class
  const filtered = investments.filter(function(inv) {
    if (invFilter !== 'all') {
      var isCurrent = isCurrentInvestment(inv);
      if (invFilter === 'current' ? !isCurrent : isCurrent) return false;
    }
    if (classFilter !== 'all') {
      const broad = BROAD_CATEGORY_MAP[inv.category || inv.type];
      if (broad !== classFilter) return false;
    }
    return true;
  });

  if (filtered.length === 0) {
    tbody.innerHTML = '';
    empty.style.display = 'block';
    empty.textContent = invFilter === 'past' ? 'No past investments.' :
                        invFilter === 'current' ? 'No current investments.' :
                        'No investments yet. Click "+ Add Investment" to get started.';
    return;
  }
  empty.style.display = 'none';

  let html = '';
  let totInvested = 0, totValue = 0, totGL = 0;
  // Collect XIRR cash flows for filtered total
  const totalXirrFlows = [];
  const today = new Date().toISOString().slice(0, 10);

  for (const inv of filtered) {
    const gl = inv.gain_loss || 0;
    const glClass = gl >= 0 ? 'positive' : 'negative';
    const glPct = inv.gain_loss_pct || 0;
    const qtyLabel = inv.type === 'fd' ? fmtDetailed(inv.principal) :
                     inv.type === 'pf' ? (inv.contributions||[]).length + ' contributions' :
                     parseFloat(inv.total_quantity || 0).toFixed(2);
    const xirrStr = inv.xirr !== null && inv.xirr !== undefined ? (inv.xirr >= 0 ? '+' : '') + inv.xirr + '%' : '--';
    const xirrClass = inv.xirr !== null && inv.xirr !== undefined ? (inv.xirr >= 0 ? 'positive' : 'negative') : '';

    totInvested += inv.invested || 0;
    totValue += inv.current_value || 0;
    totGL += gl;

    // Collect cash flows for filtered XIRR
    if (inv.error) {
      // Broken entries are excluded from totals server-side too
    } else if (inv.type === 'fd') {
      if (inv.current_value > 0) {
        totalXirrFlows.push([inv.start_date, -parseFloat(inv.principal)]);
        totalXirrFlows.push([today, inv.current_value]);
      }
    } else if (inv.type === 'pf') {
      for (const c of (inv.contributions || [])) totalXirrFlows.push([c.date, -parseFloat(c.amount)]);
      if (inv.current_value > 0) totalXirrFlows.push([today, inv.current_value]);
    } else {
      for (const t of (inv.transactions || [])) {
        const amt = parseFloat(t.quantity) * parseFloat(t.buy_price);
        if (amt > 0) totalXirrFlows.push([t.date, -amt]);
      }
      if (inv.current_value > 0) totalXirrFlows.push([today, inv.current_value]);
    }

    const schedBadge = inv.schedule ? ' <span style="font-size:0.65rem;background:#22c55e;color:#000;padding:1px 5px;border-radius:3px;vertical-align:middle;">recurring</span>' : '';
    const errorBadge = inv.error ? ` <span title="${esc(inv.error)}" style="font-size:0.65rem;background:#ef4444;color:#fff;padding:1px 5px;border-radius:3px;vertical-align:middle;cursor:help;">invalid data</span>
      <div class="negative" style="font-size:0.75rem;margin-top:2px;">${esc(inv.error)}</div>` : '';
    html += `<tr class="expandable" onclick="toggleTxns(${jsArg(inv.id)})">
      <td><strong>${esc(inv.name)}</strong>${schedBadge}${errorBadge}</td>
      <td><span class="type-badge type-${esc(inv.type)}">${esc(CATEGORY_LABELS[inv.type]||inv.type)}</span></td>
      <td>${esc(qtyLabel)}</td>
      <td>${fmtDetailed(inv.invested)}</td>
      <td>${fmtDetailed(inv.current_value)}</td>
      <td class="${glClass}">${fmtDetailed(gl)} (${glPct >= 0 ? '+' : ''}${glPct}%)</td>
      <td class="${xirrClass}">${xirrStr}</td>
      <td style="white-space:nowrap;text-align:right;">
        ${inv.type !== 'fd' ? `<button class="btn btn-sm" onclick="event.stopPropagation();openTxnModal(${jsArg(inv.id)},${jsArg(inv.type)},${jsArg(inv.name)})">+ Add</button>` : ''}
        <button class="btn btn-sm" onclick="event.stopPropagation();openEditInvModal(${jsArg(inv.id)})">Edit</button>
        <button class="btn btn-sm btn-danger" onclick="event.stopPropagation();deleteInvestment(${jsArg(inv.id)})">Del</button>
      </td>
    </tr>`;

    // Transaction sub-rows (newest first)
    if (inv.type === 'pf') {
      for (const c of (inv.contributions || []).slice().sort((a,b) => String(b.date).localeCompare(String(a.date)))) {
        html += `<tr class="txn-row" data-parent="${esc(inv.id)}">
          <td colspan="6">${esc(c.date)} &mdash; ${esc(fmtDetailed(parseFloat(c.amount).toFixed(2)))}</td>
          <td></td>
          <td>
            <button class="btn btn-sm" onclick="openEditTxnModal(${jsArg(inv.id)},${jsArg(c.id)},'pf',${jsArg(c.date)},'','',${jsArg(c.amount)})">Edit</button>
            <button class="btn btn-sm btn-danger" onclick="deleteTxn(${jsArg(inv.id)},${jsArg(c.id)})">Del</button>
          </td>
        </tr>`;
      }
    } else if (inv.type === 'fd') {
      html += `<tr class="txn-row" data-parent="${esc(inv.id)}">
          <td colspan="8">${fdDetails(inv)}</td>
        </tr>`;
    } else {
      for (const t of (inv.transactions || []).slice().sort((a,b) => String(b.date).localeCompare(String(a.date)))) {
        html += `<tr class="txn-row" data-parent="${esc(inv.id)}">
          <td colspan="6">${esc(t.date)} &mdash; ${esc(parseFloat(t.quantity).toFixed(2))} units @ ${esc(fmtDetailed(t.buy_price))}</td>
          <td></td>
          <td>
            <button class="btn btn-sm" onclick="openEditTxnModal(${jsArg(inv.id)},${jsArg(t.id)},'market',${jsArg(t.date)},${jsArg(t.quantity)},${jsArg(t.buy_price)},'')">Edit</button>
            <button class="btn btn-sm btn-danger" onclick="deleteTxn(${jsArg(inv.id)},${jsArg(t.id)})">Del</button>
          </td>
        </tr>`;
      }
    }
  }

  // Compute XIRR for filtered total (client-side Newton's method)
  const filteredXirr = computeXirrJS(totalXirrFlows);
  const totGLPct = totInvested > 0 ? ((totGL / totInvested) * 100).toFixed(2) : 0;
  const totGLClass = totGL >= 0 ? 'positive' : 'negative';
  const totXirrStr = filteredXirr !== null ? (filteredXirr >= 0 ? '+' : '') + filteredXirr + '%' : '--';
  const totXirrClass = filteredXirr !== null ? (filteredXirr >= 0 ? 'positive' : 'negative') : '';

  html += `<tr style="border-top:2px solid var(--border);font-weight:600;">
    <td>Total</td>
    <td></td>
    <td></td>
    <td>${fmtDetailed(totInvested)}</td>
    <td>${fmtDetailed(totValue)}</td>
    <td class="${totGLClass}">${fmtDetailed(totGL)} (${totGLPct >= 0 ? '+' : ''}${totGLPct}%)</td>
    <td class="${totXirrClass}">${totXirrStr}</td>
    <td></td>
  </tr>`;

  tbody.innerHTML = html;
}

const COMPOUNDING_PERIODS = { monthly: 12, quarterly: 4, half_yearly: 2, yearly: 1 };
const COMPOUNDING_LABELS = { monthly: 'Monthly', quarterly: 'Quarterly', half_yearly: 'Half-Yearly', yearly: 'Yearly' };

// Sub-row text for an FD: opening/maturity dates, terms, and maturity value (same formula as calculate_fd_value)
function fdDetails(inv) {
  const parts = [`Opened ${esc(inv.start_date || '--')}`, `Matures ${esc(inv.maturity_date || '--')}`];
  const compounding = inv.compounding || 'quarterly';
  if (inv.interest_rate !== undefined && inv.interest_rate !== '') {
    parts.push(`${esc(inv.interest_rate)}% p.a., ${esc(COMPOUNDING_LABELS[compounding] || compounding)} compounding`);
  }
  const start = Date.parse(inv.start_date), maturity = Date.parse(inv.maturity_date);
  const principal = parseFloat(inv.principal), rate = parseFloat(inv.interest_rate) / 100;
  if (!isNaN(start) && !isNaN(maturity) && !isNaN(principal) && !isNaN(rate)) {
    const n = COMPOUNDING_PERIODS[compounding] || 4;
    const years = (maturity - start) / 86400000 / 365.25;
    parts.push(`Maturity value ${esc(fmtDetailed(principal * Math.pow(1 + rate / n, n * years)))}`);
    const daysLeft = Math.ceil((maturity - Date.parse(new Date().toISOString().slice(0, 10))) / 86400000);
    parts.push(daysLeft >= 0 ? `${daysLeft} days to maturity` : 'Matured');
  }
  return parts.join(' &mdash; ');
}

function toggleTxns(invId) {
  document.querySelectorAll(`.txn-row[data-parent="${CSS.escape(invId)}"]`).forEach(r => r.classList.toggle('show'));
}
