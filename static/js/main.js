// Init Flatpickr on all date inputs
var fpConfig = {
  dateFormat: 'Y-m-d',
  altInput: true,
  altFormat: 'j M Y',
  maxDate: 'today',
  allowInput: true,
  disableMobile: true,
  monthSelectorType: 'dropdown',
  parseDate: function(dateStr, format) {
    var d = flatpickr.parseDate(dateStr, format);
    if (d) return d;
    d = flatpickr.parseDate(dateStr, 'j M Y');
    if (d) return d;
    d = flatpickr.parseDate(dateStr, 'd-m-Y');
    if (d) return d;
    d = flatpickr.parseDate(dateStr, 'd/m/Y');
    if (d) return d;
    return new Date(dateStr);
  }
};
var fpFutureConfig = Object.assign({}, fpConfig, { maxDate: null });
document.querySelectorAll('.datepicker').forEach(function(el) {
  flatpickr(el, (el.id === 'fdMaturity' || el.id === 'editInvFdMaturity') ? fpFutureConfig : fpConfig);
});

// Init
loadPortfolio();
loadHistorical();
// Values arrive in the page's own currency; switch to the one picked last time once its rate is in
if (savedCurrency() && savedCurrency() !== currency) setCurrency(savedCurrency());
