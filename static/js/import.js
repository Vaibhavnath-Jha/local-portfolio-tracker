// --- Import Modal ---
function toggleImportType() {
  var t = document.getElementById('importType').value;
  var desc = document.getElementById('importDesc');
  var fileInput = document.getElementById('importFiles');
  if (t === 'pf') {
    desc.textContent = 'Upload your EPFO passbook PDF files. Download from EPFO Member Portal. Multiple files supported.';
    fileInput.accept = '.pdf';
  } else {
    desc.textContent = 'Upload your Zerodha tradebook CSV files. You can upload multiple files at once (EQ and MF segments).';
    fileInput.accept = '.csv';
  }
}

function openImportModal() {
  document.getElementById('importModal').classList.add('show');
  document.getElementById('importFiles').value = '';
  document.getElementById('importStatus').style.display = 'none';
  document.getElementById('importType').value = 'zerodha';
  toggleImportType();
}

function closeImportModal() {
  document.getElementById('importModal').classList.remove('show');
}

async function submitImport() {
  var files = document.getElementById('importFiles').files;
  if (files.length === 0) return;

  var importType = document.getElementById('importType').value;
  var btn = document.getElementById('importBtn');
  var status = document.getElementById('importStatus');
  btn.innerHTML = '<span class="spinner"></span> Importing...';
  btn.disabled = true;
  status.style.display = 'block';
  status.style.color = 'var(--muted)';
  status.textContent = 'Processing files...';

  var totalImported = 0;
  var errors = [];

  if (importType === 'pf') {
    var formData = new FormData();
    for (var i = 0; i < files.length; i++) {
      formData.append('file', files[i]);
    }
    try {
      var resp = await fetch('/api/import/pf', { method: 'POST', body: formData });
      checkLoggedIn(resp);
      var data = await resp.json();
      if (data.status === 'ok') {
        totalImported = data.imported;
      } else {
        errors.push(data.message || 'Unknown error');
      }
    } catch(e) {
      errors.push(e.message);
    }
  } else {
    for (var i = 0; i < files.length; i++) {
      var formData = new FormData();
      formData.append('file', files[i]);
      try {
        var resp = await fetch('/api/import', { method: 'POST', body: formData });
        checkLoggedIn(resp);
        var data = await resp.json();
        if (data.status === 'ok') {
          totalImported += data.imported;
        } else {
          errors.push(files[i].name + ': ' + (data.message || 'Unknown error'));
        }
      } catch(e) {
        errors.push(files[i].name + ': ' + e.message);
      }
    }
  }

  btn.textContent = 'Import';
  btn.disabled = false;

  if (errors.length > 0) {
    status.style.color = 'var(--red)';
    status.textContent = 'Errors: ' + errors.join('; ');
  } else {
    status.style.color = 'var(--green)';
    status.textContent = 'Imported ' + totalImported + ' entries successfully.';
    setTimeout(function() { closeImportModal(); }, 1500);
  }

  await loadPortfolio();
  loadHistorical();
}
