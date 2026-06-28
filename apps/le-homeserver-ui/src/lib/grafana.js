const CACHE_TTL_MS = 30_000;

let cache = { fetchedAt: 0, byJob: null, error: null };

function isConfigured() {
  return Boolean(process.env.GRAFANA_URL && process.env.GRAFANA_DATASOURCE_UID && process.env.GRAFANA_TOKEN);
}

async function queryUp() {
  const url = `${process.env.GRAFANA_URL}/api/datasources/proxy/uid/${process.env.GRAFANA_DATASOURCE_UID}/api/v1/query?query=up`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.GRAFANA_TOKEN}` },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) {
    throw new Error(`Grafana antwortete mit ${res.status}`);
  }
  const body = await res.json();
  const result = body?.data?.result ?? [];

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
  if (cache.byJob && now - cache.fetchedAt < CACHE_TTL_MS) {
    return { byJob: cache.byJob, error: cache.error };
  }

  try {
    const byJob = await queryUp();
    cache = { fetchedAt: now, byJob, error: null };
  } catch (err) {
    cache = { fetchedAt: now, byJob: cache.byJob || {}, error: err.message };
  }

  return { byJob: cache.byJob, error: cache.error };
}

module.exports = { getHealthByJob, isConfigured };
