const CACHE_TTL_MS = 30_000;

let healthCache = { fetchedAt: 0, byJob: null, error: null };
let statsCache = { fetchedAt: 0, nodes: null, error: null };

let nodeLabels = null;
function getNodeLabels() {
  if (nodeLabels) return nodeLabels;
  try {
    nodeLabels = JSON.parse(process.env.GRAFANA_NODE_LABELS || '{}');
  } catch {
    nodeLabels = {};
  }
  return nodeLabels;
}

// Ordnet ein Prometheus-`instance`-Label (z.B. "192.168.178.94:9100") einem
// lesbaren Namen zu, ueber den Praefix vor dem Port - faellt auf das
// Rohlabel zurueck, wenn nichts konfiguriert ist.
function labelForInstance(instance) {
  const labels = getNodeLabels();
  const host = instance.split(':')[0];
  return labels[host] || instance;
}

function isConfigured() {
  return Boolean(process.env.GRAFANA_URL && process.env.GRAFANA_DATASOURCE_UID && process.env.GRAFANA_TOKEN);
}

async function queryInstant(promql) {
  const url = `${process.env.GRAFANA_URL}/api/datasources/proxy/uid/${process.env.GRAFANA_DATASOURCE_UID}/api/v1/query?query=${encodeURIComponent(promql)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.GRAFANA_TOKEN}` },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) {
    throw new Error(`Grafana antwortete mit ${res.status}`);
  }
  const body = await res.json();
  return body?.data?.result ?? [];
}

async function queryUp() {
  const result = await queryInstant('up');

  const byJob = {};
  for (const series of result) {
    const job = series.metric?.job;
    if (!job) continue;
    const value = Number(series.value?.[1]);
    const up = value === 1;
    // Ein Job ist "up", wenn mindestens eine Instanz up ist.
    byJob[job] = byJob[job] || up;
  }
  return byJob;
}

// Liefert { job: boolean } fuer alle bekannten Jobs, gecached fuer CACHE_TTL_MS.
// Wirft nie - bei Fehlern/fehlender Konfiguration wird ein leeres Mapping
// zurueckgegeben, Aufrufer behandeln fehlende Jobs als "unknown".
async function getHealthByJob() {
  if (!isConfigured()) {
    return { byJob: {}, error: 'not_configured' };
  }

  const now = Date.now();
  if (healthCache.byJob && now - healthCache.fetchedAt < CACHE_TTL_MS) {
    return { byJob: healthCache.byJob, error: healthCache.error };
  }

  try {
    const byJob = await queryUp();
    healthCache = { fetchedAt: now, byJob, error: null };
  } catch (err) {
    healthCache = { fetchedAt: now, byJob: healthCache.byJob || {}, error: err.message };
  }

  return { byJob: healthCache.byJob, error: healthCache.error };
}

const STATS_QUERIES = {
  cpu: '100 - (avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)',
  ram: '(node_memory_MemTotal_bytes - node_memory_MemAvailable_bytes) / node_memory_MemTotal_bytes * 100',
  disk:
    '(node_filesystem_size_bytes{mountpoint="/",fstype!~"tmpfs|overlay"} - node_filesystem_avail_bytes{mountpoint="/",fstype!~"tmpfs|overlay"}) / node_filesystem_size_bytes{mountpoint="/",fstype!~"tmpfs|overlay"} * 100',
  temp: 'avg by (instance) (node_hwmon_temp_celsius)',
};

async function queryStats() {
  const byInstance = {};

  await Promise.all(
    Object.entries(STATS_QUERIES).map(async ([metric, promql]) => {
      const result = await queryInstant(promql);
      for (const series of result) {
        const instance = series.metric?.instance;
        if (!instance) continue;
        const value = Number(series.value?.[1]);
        if (Number.isNaN(value)) continue;
        byInstance[instance] = byInstance[instance] || {};
        byInstance[instance][metric] = Math.round(value * 10) / 10;
      }
    })
  );

  return Object.entries(byInstance)
    .map(([instance, metrics]) => ({
      key: instance,
      label: labelForInstance(instance),
      cpu: metrics.cpu ?? null,
      ram: metrics.ram ?? null,
      disk: metrics.disk ?? null,
      temp: metrics.temp ?? null,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

// Liefert CPU/RAM/Disk/Temperatur je Node, gecached fuer CACHE_TTL_MS.
// Wirft nie - bei Fehlern/fehlender Konfiguration wird eine leere Liste
// zurueckgegeben.
async function getSystemStats() {
  if (!isConfigured()) {
    return { nodes: [], error: 'not_configured' };
  }

  const now = Date.now();
  if (statsCache.nodes && now - statsCache.fetchedAt < CACHE_TTL_MS) {
    return { nodes: statsCache.nodes, error: statsCache.error };
  }

  try {
    const nodes = await queryStats();
    statsCache = { fetchedAt: now, nodes, error: null };
  } catch (err) {
    statsCache = { fetchedAt: now, nodes: statsCache.nodes || [], error: err.message };
  }

  return { nodes: statsCache.nodes, error: statsCache.error };
}

module.exports = { getHealthByJob, getSystemStats, isConfigured };
