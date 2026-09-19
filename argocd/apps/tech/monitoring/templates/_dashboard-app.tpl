{{/*
Renders one Grafana dashboard (as raw JSON) for an app entry from
values.yaml `dashboardApps` (fields: name, namespace, folder, hasIngress).
Used by templates/dashboards-apps.yaml. Panels: pod-ready count, pod
restarts, CPU, RAM, and — only when hasIngress — Traefik-derived HTTP
request rate, error rate, requests-by-status-code and p95 latency.
Time range is fixed to the last 3h (dashboard default, still adjustable
in the UI).
*/}}
{{- define "monitoring.appDashboardJSON" -}}
{{- $app := . -}}
{
  "annotations": {"list": []},
  "description": "Auto-generated: Pods, CPU/RAM{{ if $app.hasIngress }}, User Requests{{ end }} für {{ $app.name }} (Namespace {{ $app.namespace }})",
  "editable": true,
  "graphTooltip": 1,
  "links": [],
  "panels": [
    {
      "datasource": {"type": "prometheus", "uid": "${datasource}"},
      "fieldConfig": {
        "defaults": {
          "color": {"mode": "thresholds"},
          "mappings": [
            {"options": {"0": {"color": "red", "index": 0, "text": "Down"}}, "type": "value"},
            {"options": {"from": 1, "to": 1e+99, "result": {"color": "green", "index": 1, "text": "Running"}}, "type": "range"}
          ],
          "thresholds": {"mode": "absolute", "steps": [{"color": "red", "value": null}, {"color": "green", "value": 1}]},
          "unit": "short"
        }
      },
      "gridPos": {"h": 4, "w": 6, "x": 0, "y": 0},
      "id": 1,
      "options": {"colorMode": "background", "graphMode": "none", "justifyMode": "center", "orientation": "auto", "reduceOptions": {"calcs": ["lastNotNull"], "fields": "", "values": false}, "textMode": "auto"},
      "targets": [
        {
          "datasource": {"type": "prometheus", "uid": "${datasource}"},
          "expr": "sum(kube_pod_status_ready{namespace=\"{{ $app.namespace }}\", condition=\"true\"})",
          "instant": true,
          "refId": "A"
        }
      ],
      "title": "Pods bereit",
      "type": "stat"
    },
    {
      "datasource": {"type": "prometheus", "uid": "${datasource}"},
      "fieldConfig": {
        "defaults": {
          "color": {"mode": "thresholds"},
          "thresholds": {"mode": "absolute", "steps": [{"color": "green", "value": null}, {"color": "yellow", "value": 1}, {"color": "red", "value": 5}]},
          "unit": "short"
        }
      },
      "gridPos": {"h": 4, "w": 6, "x": 6, "y": 0},
      "id": 2,
      "options": {"colorMode": "background", "graphMode": "none", "justifyMode": "center", "orientation": "auto", "reduceOptions": {"calcs": ["lastNotNull"], "fields": "", "values": false}, "textMode": "auto"},
      "targets": [
        {
          "datasource": {"type": "prometheus", "uid": "${datasource}"},
          "expr": "sum(increase(kube_pod_container_status_restarts_total{namespace=\"{{ $app.namespace }}\"}[1h]))",
          "instant": true,
          "refId": "A"
        }
      ],
      "title": "Pod-Neustarts (1h)",
      "type": "stat"
    },
{{- if $app.hasIngress }}
    {
      "datasource": {"type": "prometheus", "uid": "${datasource}"},
      "fieldConfig": {
        "defaults": {
          "color": {"mode": "thresholds"},
          "thresholds": {"mode": "absolute", "steps": [{"color": "blue", "value": null}]},
          "unit": "reqps"
        }
      },
      "gridPos": {"h": 4, "w": 6, "x": 12, "y": 0},
      "id": 3,
      "options": {"colorMode": "value", "graphMode": "area", "justifyMode": "center", "orientation": "auto", "reduceOptions": {"calcs": ["lastNotNull"], "fields": "", "values": false}, "textMode": "auto"},
      "targets": [
        {
          "datasource": {"type": "prometheus", "uid": "${datasource}"},
          "expr": "sum(rate(traefik_service_requests_total{service=~\"^{{ $app.namespace }}-.*\"}[5m]))",
          "instant": true,
          "refId": "A"
        }
      ],
      "title": "User Requests/s",
      "type": "stat"
    },
    {
      "datasource": {"type": "prometheus", "uid": "${datasource}"},
      "fieldConfig": {
        "defaults": {
          "color": {"mode": "thresholds"},
          "thresholds": {"mode": "absolute", "steps": [{"color": "green", "value": null}, {"color": "yellow", "value": 1}, {"color": "red", "value": 5}]},
          "unit": "percent",
          "max": 100,
          "min": 0
        }
      },
      "gridPos": {"h": 4, "w": 6, "x": 18, "y": 0},
      "id": 4,
      "options": {"colorMode": "background", "graphMode": "none", "justifyMode": "center", "orientation": "auto", "reduceOptions": {"calcs": ["lastNotNull"], "fields": "", "values": false}, "textMode": "auto"},
      "targets": [
        {
          "datasource": {"type": "prometheus", "uid": "${datasource}"},
          "expr": "100 * sum(rate(traefik_service_requests_total{service=~\"^{{ $app.namespace }}-.*\", code=~\"5..\"}[5m])) / clamp_min(sum(rate(traefik_service_requests_total{service=~\"^{{ $app.namespace }}-.*\"}[5m])), 1e-9)",
          "instant": true,
          "refId": "A"
        }
      ],
      "title": "Fehlerrate 5xx (%)",
      "type": "stat"
    },
{{- end }}
    {
      "datasource": {"type": "prometheus", "uid": "${datasource}"},
      "fieldConfig": {
        "defaults": {
          "color": {"mode": "palette-classic"},
          "custom": {
            "drawStyle": "line",
            "fillOpacity": 10,
            "lineInterpolation": "smooth",
            "lineWidth": 1,
            "showPoints": "never",
            "spanNulls": false
          },
          "unit": "short"
        }
      },
      "gridPos": {"h": 8, "w": 12, "x": 0, "y": 4},
      "id": 5,
      "options": {
        "legend": {"calcs": ["mean", "max", "last"], "displayMode": "table", "placement": "bottom"},
        "tooltip": {"mode": "multi", "sort": "desc"}
      },
      "targets": [
        {
          "datasource": {"type": "prometheus", "uid": "${datasource}"},
          "expr": "sum by (pod) (rate(container_cpu_usage_seconds_total{namespace=\"{{ $app.namespace }}\", container!=\"\", container!=\"POD\", image!=\"\"}[5m]))",
          "legendFormat": "{{ "{{pod}}" }}",
          "refId": "A"
        }
      ],
      "title": "CPU Auslastung (Kerne)",
      "type": "timeseries"
    },
    {
      "datasource": {"type": "prometheus", "uid": "${datasource}"},
      "fieldConfig": {
        "defaults": {
          "color": {"mode": "palette-classic"},
          "custom": {
            "drawStyle": "line",
            "fillOpacity": 10,
            "lineInterpolation": "smooth",
            "lineWidth": 1,
            "showPoints": "never",
            "spanNulls": false
          },
          "unit": "bytes"
        }
      },
      "gridPos": {"h": 8, "w": 12, "x": 12, "y": 4},
      "id": 6,
      "options": {
        "legend": {"calcs": ["mean", "max", "last"], "displayMode": "table", "placement": "bottom"},
        "tooltip": {"mode": "multi", "sort": "desc"}
      },
      "targets": [
        {
          "datasource": {"type": "prometheus", "uid": "${datasource}"},
          "expr": "sum by (pod) (container_memory_working_set_bytes{namespace=\"{{ $app.namespace }}\", container!=\"\", container!=\"POD\", image!=\"\"})",
          "legendFormat": "{{ "{{pod}}" }}",
          "refId": "A"
        }
      ],
      "title": "RAM Auslastung",
      "type": "timeseries"
    }{{ if $app.hasIngress }},
    {
      "datasource": {"type": "prometheus", "uid": "${datasource}"},
      "fieldConfig": {
        "defaults": {
          "color": {"mode": "palette-classic"},
          "custom": {
            "drawStyle": "line",
            "fillOpacity": 10,
            "lineInterpolation": "smooth",
            "lineWidth": 1,
            "showPoints": "never",
            "spanNulls": false
          },
          "unit": "reqps"
        }
      },
      "gridPos": {"h": 8, "w": 12, "x": 0, "y": 12},
      "id": 7,
      "options": {
        "legend": {"calcs": ["mean", "max", "last"], "displayMode": "table", "placement": "bottom"},
        "tooltip": {"mode": "multi", "sort": "desc"}
      },
      "targets": [
        {
          "datasource": {"type": "prometheus", "uid": "${datasource}"},
          "expr": "sum by (code) (rate(traefik_service_requests_total{service=~\"^{{ $app.namespace }}-.*\"}[5m]))",
          "legendFormat": "{{ "{{code}}" }}",
          "refId": "A"
        }
      ],
      "title": "User Requests nach Status-Code",
      "type": "timeseries"
    },
    {
      "datasource": {"type": "prometheus", "uid": "${datasource}"},
      "fieldConfig": {
        "defaults": {
          "color": {"mode": "palette-classic"},
          "custom": {
            "drawStyle": "line",
            "fillOpacity": 10,
            "lineInterpolation": "smooth",
            "lineWidth": 1,
            "showPoints": "never",
            "spanNulls": false
          },
          "unit": "s"
        }
      },
      "gridPos": {"h": 8, "w": 12, "x": 12, "y": 12},
      "id": 8,
      "options": {
        "legend": {"calcs": ["mean", "max", "last"], "displayMode": "table", "placement": "bottom"},
        "tooltip": {"mode": "multi", "sort": "desc"}
      },
      "targets": [
        {
          "datasource": {"type": "prometheus", "uid": "${datasource}"},
          "expr": "histogram_quantile(0.95, sum by (le) (rate(traefik_service_request_duration_seconds_bucket{service=~\"^{{ $app.namespace }}-.*\"}[5m])))",
          "legendFormat": "p95",
          "refId": "A"
        }
      ],
      "title": "Latenz p95",
      "type": "timeseries"
    }{{ end }}
  ],
  "refresh": "30s",
  "schemaVersion": 38,
  "tags": ["homelab", "{{ $app.folder | lower }}", "{{ $app.name }}"],
  "templating": {
    "list": [
      {
        "current": {},
        "hide": 0,
        "includeAll": false,
        "label": "Datasource",
        "multi": false,
        "name": "datasource",
        "options": [],
        "query": "prometheus",
        "refresh": 1,
        "type": "datasource"
      }
    ]
  },
  "time": {"from": "now-3h", "to": "now"},
  "timepicker": {},
  "timezone": "browser",
  "title": "{{ $app.name }}",
  "uid": "app-{{ $app.name }}",
  "version": 1
}
{{- end -}}
