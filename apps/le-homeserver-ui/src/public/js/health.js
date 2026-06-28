(function () {
  var POLL_MS = 30000;

  function applyStatus(el, status) {
    el.classList.remove('badge--up', 'badge--down', 'badge--unknown');
    var label = el.querySelector('.badge__label');
    if (status === true) {
      el.classList.add('badge--up');
      if (label) label.textContent = 'online';
    } else if (status === false) {
      el.classList.add('badge--down');
      if (label) label.textContent = 'offline';
    } else {
      el.classList.add('badge--unknown');
      if (label) label.textContent = 'unbekannt';
    }
  }

  function refresh() {
    fetch('/api/health')
      .then(function (res) {
        return res.json();
      })
      .then(function (data) {
        var errorEl = document.getElementById('health-error');
        if (errorEl) errorEl.hidden = !data.error;

        document.querySelectorAll('.badge[data-job]').forEach(function (el) {
          var job = el.getAttribute('data-job');
          var status = Object.prototype.hasOwnProperty.call(data.byJob, job) ? data.byJob[job] : null;
          applyStatus(el, status);
        });
      })
      .catch(function () {
        var errorEl = document.getElementById('health-error');
        if (errorEl) errorEl.hidden = false;
      });
  }

  refresh();
  setInterval(refresh, POLL_MS);
})();
