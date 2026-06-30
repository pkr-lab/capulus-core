(function () {
  var POLL_MS = 30000;
  var COUNT_MS = 700;

  var METRICS = [
    { key: 'cpu', label: 'CPU', unit: '%', max: 100, warn: 70, crit: 90 },
    { key: 'ram', label: 'RAM', unit: '%', max: 100, warn: 70, crit: 90 },
    { key: 'disk', label: 'Disk', unit: '%', max: 100, warn: 75, crit: 90 },
    { key: 'temp', label: 'Temp', unit: '°C', max: 100, warn: 70, crit: 85 },
  ];

  var grid = document.getElementById('stats-grid');
  var emptyEl = document.getElementById('stats-empty');
  var errorEl = document.getElementById('stats-error');
  if (!grid) return;

  var nodeCache = {}; // key -> { els, values }

  function levelFor(metric, value) {
    if (value === null || value === undefined) return 'unknown';
    if (value >= metric.crit) return 'crit';
    if (value >= metric.warn) return 'warn';
    return 'good';
  }

  function ringCircle(svg) {
    var circle = svg.querySelector('.metric__ring-fg');
    return circle;
  }

  function buildMetric(metric) {
    var wrap = document.createElement('div');
    wrap.className = 'metric';
    wrap.innerHTML =
      '<span class="metric__ring-wrap">' +
      '<svg class="metric__ring" viewBox="0 0 64 64" aria-hidden="true">' +
      '<circle class="metric__ring-bg" cx="32" cy="32" r="27"></circle>' +
      '<circle class="metric__ring-fg" cx="32" cy="32" r="27"></circle>' +
      '</svg>' +
      '<span class="metric__value"><span class="metric__num">–</span><small class="metric__unit">' + metric.unit + '</small></span>' +
      '</span>' +
      '<span class="metric__label">' + metric.label + '</span>';
    return wrap;
  }

  function buildNodeCard(node) {
    var card = document.createElement('article');
    card.className = 'node-card';

    var title = document.createElement('div');
    title.className = 'node-card__label';
    title.textContent = node.label;
    card.appendChild(title);

    var metricsRow = document.createElement('div');
    metricsRow.className = 'node-card__metrics';
    card.appendChild(metricsRow);

    var els = {};
    METRICS.forEach(function (metric) {
      var el = buildMetric(metric);
      metricsRow.appendChild(el);
      var circle = ringCircle(el);
      var circumference = circle.getTotalLength();
      circle.style.strokeDasharray = circumference + ' ' + circumference;
      circle.style.strokeDashoffset = circumference;
      els[metric.key] = {
        wrap: el,
        circle: circle,
        circumference: circumference,
        num: el.querySelector('.metric__num'),
      };
    });

    return { card: card, els: els, values: {} };
  }

  function animateValue(numEl, from, to, decimals) {
    var start = performance.now();
    function step(now) {
      var t = Math.min(1, (now - start) / COUNT_MS);
      var eased = 1 - Math.pow(1 - t, 3);
      var current = from + (to - from) * eased;
      numEl.textContent = current.toFixed(decimals);
      if (t < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  function applyMetric(entry, metric, value) {
    var info = entry.els[metric.key];
    var level = levelFor(metric, value);
    info.wrap.classList.remove('metric--good', 'metric--warn', 'metric--crit', 'metric--unknown');
    info.wrap.classList.add('metric--' + level);

    var clamped = Math.max(0, Math.min(metric.max, value === null || value === undefined ? 0 : value));
    var offset = info.circumference * (1 - clamped / metric.max);
    info.circle.style.strokeDashoffset = value === null || value === undefined ? info.circumference : offset;

    var prev = entry.values[metric.key];
    if (value === null || value === undefined) {
      info.num.textContent = '–';
    } else {
      animateValue(info.num, prev === undefined || prev === null ? value : prev, value, metric.unit === '%' ? 0 : 1);
    }
    entry.values[metric.key] = value;
  }

  function render(nodes) {
    if (nodes.length === 0) {
      emptyEl.hidden = false;
      emptyEl.textContent = 'Keine Live-Werte verfügbar';
    } else {
      emptyEl.hidden = true;
    }

    var seen = {};
    nodes.forEach(function (node) {
      seen[node.key] = true;
      var entry = nodeCache[node.key];
      if (!entry) {
        entry = buildNodeCard(node);
        nodeCache[node.key] = entry;
        grid.appendChild(entry.card);
      }
      METRICS.forEach(function (metric) {
        applyMetric(entry, metric, node[metric.key]);
      });
    });

    Object.keys(nodeCache).forEach(function (key) {
      if (!seen[key]) {
        nodeCache[key].card.remove();
        delete nodeCache[key];
      }
    });
  }

  function refresh() {
    fetch('/api/stats')
      .then(function (res) {
        return res.json();
      })
      .then(function (data) {
        errorEl.hidden = !data.error;
        render(data.nodes || []);
      })
      .catch(function () {
        errorEl.hidden = false;
      });
  }

  refresh();
  setInterval(refresh, POLL_MS);
})();
