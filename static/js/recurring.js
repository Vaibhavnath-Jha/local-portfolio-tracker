// --- Recurring / Bulk Add Modal ---
function renderScheduleList() {
  var container = document.getElementById('scheduleList');
  if (!portfolioData || !portfolioData.investments) {
    container.innerHTML = '<p style="color:var(--muted);font-size:0.85rem;">No investments yet.</p>';
    return;
  }

  var scheduled = portfolioData.investments.filter(function(inv) { return inv.schedule; });
  if (scheduled.length === 0) {
    container.innerHTML = '<p style="color:var(--muted);font-size:0.85rem;">No active recurring schedules. Set one up below.</p>';
    return;
  }

  var html = '<table style="width:100%;font-size:0.85rem;"><thead><tr style="color:var(--muted);text-align:left;">' +
    '<th style="padding:4px 8px;">Investment</th><th style="padding:4px 8px;">Amount</th><th style="padding:4px 8px;">Day</th>' +
    '<th style="padding:4px 8px;">Start</th><th style="padding:4px 8px;">End</th><th style="padding:4px 8px;"></th></tr></thead><tbody>';

  for (var inv of scheduled) {
    var s = inv.schedule;
    html += '<tr>' +
      '<td style="padding:4px 8px;">' + esc(inv.name) + '</td>' +
      '<td style="padding:4px 8px;">' + fmt(s.amount) + '/mo</td>' +
      '<td style="padding:4px 8px;">' + esc(s.day) + '</td>' +
      '<td style="padding:4px 8px;">' + esc(s.start_date) + '</td>' +
      '<td style="padding:4px 8px;">' + esc(s.end_date || 'Ongoing') + '</td>' +
      '<td style="padding:4px 8px;">' +
        '<button class="btn btn-sm" onclick="editSchedule(' + jsArg(inv.id) + ')">Edit</button> ' +
        '<button class="btn btn-sm btn-danger" onclick="deleteSchedule(' + jsArg(inv.id) + ')">Del</button>' +
      '</td></tr>';
  }
  html += '</tbody></table>';
  container.innerHTML = html;
}

function openRecurringModal() {
  document.getElementById('recurringModal').classList.add('show');
  document.getElementById('recurStatus').style.display = 'none';
  renderScheduleList();
  // Populate investment dropdown with PF and market investments
  var sel = document.getElementById('recurInvestment');
  sel.innerHTML = '';
  if (portfolioData && portfolioData.investments) {
    for (var inv of portfolioData.investments) {
      if (['pf', 'stock', 'etf', 'gold_etf', 'mutual_fund', 'crypto'].includes(inv.type)) {
        var opt = document.createElement('option');
        opt.value = inv.id;
        opt.textContent = inv.name + ' (' + (CATEGORY_LABELS[inv.type] || inv.type) + ')';
        opt.dataset.type = inv.type;
        sel.appendChild(opt);
      }
    }
  }
  onRecurInvestmentChange();
  flatpickr('#recurStart', { dateFormat: 'Y-m-d', allowInput: true, theme: 'dark' });
  flatpickr('#recurEnd', { dateFormat: 'Y-m-d', allowInput: true, theme: 'dark' });
}

function onRecurInvestmentChange() {
  var sel = document.getElementById('recurInvestment');
  var opt = sel.options[sel.selectedIndex];
  var type = opt ? opt.dataset.type : '';
  document.getElementById('recurBuyPriceGroup').style.display = (type !== 'pf') ? 'block' : 'none';
}

function closeRecurringModal() {
  document.getElementById('recurringModal').classList.remove('show');
}

function editSchedule(invId) {
  var inv = portfolioData.investments.find(function(i) { return i.id === invId; });
  if (!inv || !inv.schedule) return;
  // Pre-fill the form with existing schedule
  document.getElementById('recurInvestment').value = invId;
  onRecurInvestmentChange();
  document.getElementById('recurAmount').value = inv.schedule.amount;
  document.getElementById('recurDay').value = inv.schedule.day;
  document.getElementById('recurStart').value = inv.schedule.start_date;
  document.getElementById('recurEnd').value = inv.schedule.end_date || '';
  if (inv.schedule.buy_price) {
    document.getElementById('recurBuyPrice').value = inv.schedule.buy_price;
  }
}

async function deleteSchedule(invId) {
  if (!confirm('Remove recurring schedule?')) return;
  try {
    await api('/api/investment/' + encodeURIComponent(invId) + '/schedule', { method: 'DELETE' });
  } catch (e) {
    alert('Could not remove schedule: ' + e.message);
    return;
  }
  await loadPortfolio();
  renderScheduleList();
}

async function saveSchedule() {
  var sel = document.getElementById('recurInvestment');
  var invId = sel.value;
  if (!invId) return;

  var amount = document.getElementById('recurAmount').value;
  var day = document.getElementById('recurDay').value;
  var startDate = document.getElementById('recurStart').value;
  var endDate = document.getElementById('recurEnd').value;
  var buyPrice = document.getElementById('recurBuyPrice').value;

  if (!amount || !startDate) {
    alert('Amount and start date are required');
    return;
  }

  var status = document.getElementById('recurStatus');
  status.style.display = 'block';
  status.style.color = 'var(--muted)';
  status.textContent = 'Saving schedule...';

  try {
    var body = { amount: parseFloat(amount), day: parseInt(day), start_date: startDate };
    if (endDate) body.end_date = endDate;
    if (buyPrice) body.buy_price = parseFloat(buyPrice);

    await sendJSON('/api/investment/' + encodeURIComponent(invId) + '/schedule', 'POST', body);

    status.style.color = 'var(--green)';
    status.textContent = 'Schedule saved! Entries will auto-generate each time you open the app.';
    await loadPortfolio();
    renderScheduleList();
    loadHistorical();
  } catch(e) {
    status.style.color = 'var(--red)';
    status.textContent = 'Error: ' + e.message;
  }
}

async function submitRecurring() {
  var sel = document.getElementById('recurInvestment');
  var invId = sel.value;
  if (!invId) return;

  var amount = document.getElementById('recurAmount').value;
  var day = document.getElementById('recurDay').value;
  var startDate = document.getElementById('recurStart').value;
  var endDate = document.getElementById('recurEnd').value;
  var buyPrice = document.getElementById('recurBuyPrice').value;

  if (!amount || !startDate) {
    alert('Amount and start date are required');
    return;
  }

  var btn = document.getElementById('recurBtn');
  var status = document.getElementById('recurStatus');
  btn.innerHTML = '<span class="spinner"></span> Generating...';
  btn.disabled = true;
  status.style.display = 'block';
  status.style.color = 'var(--muted)';
  status.textContent = 'Generating entries...';

  try {
    var body = { amount: parseFloat(amount), day: parseInt(day), start_date: startDate };
    if (endDate) body.end_date = endDate;
    if (buyPrice) body.buy_price = parseFloat(buyPrice);

    var data = await sendJSON('/api/investment/' + encodeURIComponent(invId) + '/generate', 'POST', body);
    status.style.color = 'var(--green)';
    status.textContent = data.message;
  } catch(e) {
    status.style.color = 'var(--red)';
    status.textContent = 'Error: ' + e.message;
  }

  btn.textContent = 'Generate Past Entries';
  btn.disabled = false;

  await loadPortfolio();
  renderScheduleList();
  loadHistorical();
}
