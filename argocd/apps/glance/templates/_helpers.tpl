{{/*
Expand the name of the chart.
*/}}
{{- define "glance.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "glance.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Create chart label.
*/}}
{{- define "glance.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels.
*/}}
{{- define "glance.labels" -}}
helm.sh/chart: {{ include "glance.chart" . }}
{{ include "glance.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels.
*/}}
{{- define "glance.selectorLabels" -}}
app.kubernetes.io/name: {{ include "glance.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
ServiceAccount name.
*/}}
{{- define "glance.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "glance.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Glance custom-api widget templates below use Glance's OWN Go-template syntax
({{ .JSON... }}), which Helm would otherwise try to parse as its own template
actions. Wrapping each as a raw (backtick) string literal makes Helm treat
the content as an inert string that's emitted verbatim — Glance parses it at
its own runtime, Helm never looks inside. Do not add Helm `{{ }}` actions
inside these defines; hardcode any values instead (see docs/41-glance.md).
*/}}

{{- define "glance.weatherTomorrowTemplate" -}}
{{- `{{ $code := .JSON.Int "daily.weathercode.1" }}
<div class="widget-small-content-bounds">
  <div class="size-h2 color-highlight text-center">{{ if eq $code 0 }}Klar{{ else if or (eq $code 1) (eq $code 2) (eq $code 3) }}Bewölkt{{ else if or (eq $code 45) (eq $code 48) }}Nebel{{ else if or (eq $code 51) (eq $code 53) (eq $code 55) }}Nieselregen{{ else if or (eq $code 61) (eq $code 63) (eq $code 65) }}Regen{{ else if or (eq $code 71) (eq $code 73) (eq $code 75) }}Schnee{{ else if or (eq $code 80) (eq $code 81) (eq $code 82) }}Regenschauer{{ else if or (eq $code 95) (eq $code 96) (eq $code 99) }}Gewitter{{ else }}Wechselhaft{{ end }}</div>
  <div class="size-h4 text-center">{{ .JSON.Float "daily.temperature_2m_min.1" | printf "%.0f" }}° / {{ .JSON.Float "daily.temperature_2m_max.1" | printf "%.0f" }}°</div>
  <div class="size-h5 text-center color-base margin-top-5">Regenwahrscheinlichkeit {{ .JSON.Int "daily.precipitation_probability_max.1" }}%</div>
  <div class="flex items-center justify-center margin-top-15 gap-7 size-h5">
    <div class="location-icon"></div>
    <div class="text-truncate">Andernach, Deutschland</div>
  </div>
</div>` -}}
{{- end -}}

{{- define "glance.fuelPricesTemplate" -}}
{{- `<ul class="list list-gap-14">
  <li>
    <p class="color-highlight">Andernach — Buchenstraße 1a</p>
    {{ if eq (.JSON.String "prices.c40eefd2-1343-48f1-aafe-3e97f46222b0.status") "open" }}
    <ul class="list-horizontal-text">
      <li>Diesel {{ .JSON.Float "prices.c40eefd2-1343-48f1-aafe-3e97f46222b0.diesel" | printf "%.3f" }} €</li>
      <li>E5 {{ .JSON.Float "prices.c40eefd2-1343-48f1-aafe-3e97f46222b0.e5" | printf "%.3f" }} €</li>
      <li>E10 {{ .JSON.Float "prices.c40eefd2-1343-48f1-aafe-3e97f46222b0.e10" | printf "%.3f" }} €</li>
    </ul>
    {{ else }}
    <p class="color-negative">Geschlossen</p>
    {{ end }}
  </li>
  <li>
    <p class="color-highlight">Plaidt — An der B 256</p>
    {{ if eq (.JSON.String "prices.effdf24b-44b3-4ddc-9c38-feedb636b05e.status") "open" }}
    <ul class="list-horizontal-text">
      <li>Diesel {{ .JSON.Float "prices.effdf24b-44b3-4ddc-9c38-feedb636b05e.diesel" | printf "%.3f" }} €</li>
      <li>E5 {{ .JSON.Float "prices.effdf24b-44b3-4ddc-9c38-feedb636b05e.e5" | printf "%.3f" }} €</li>
      <li>E10 {{ .JSON.Float "prices.effdf24b-44b3-4ddc-9c38-feedb636b05e.e10" | printf "%.3f" }} €</li>
    </ul>
    {{ else }}
    <p class="color-negative">Geschlossen</p>
    {{ end }}
  </li>
  <li>
    <p class="color-highlight">Mülheim-Kärlich — Industriestraße 1</p>
    {{ if eq (.JSON.String "prices.40b99699-12d6-48b4-9a90-9d8a9db99ba0.status") "open" }}
    <ul class="list-horizontal-text">
      <li>Diesel {{ .JSON.Float "prices.40b99699-12d6-48b4-9a90-9d8a9db99ba0.diesel" | printf "%.3f" }} €</li>
      <li>E5 {{ .JSON.Float "prices.40b99699-12d6-48b4-9a90-9d8a9db99ba0.e5" | printf "%.3f" }} €</li>
      <li>E10 {{ .JSON.Float "prices.40b99699-12d6-48b4-9a90-9d8a9db99ba0.e10" | printf "%.3f" }} €</li>
    </ul>
    {{ else }}
    <p class="color-negative">Geschlossen</p>
    {{ end }}
  </li>
</ul>` -}}
{{- end -}}

{{- define "glance.serverStatusTemplate" -}}
{{- `{{ $mem := .Subrequest "mem" }}
<ul class="list list-gap-14">
  <li>
    <p class="color-highlight">homeserver (.94)</p>
    {{ if .JSON.Exists "data.result.#(metric.instance==\"homeserver\")" }}
    <ul class="list-horizontal-text">
      <li>CPU {{ .JSON.Float "data.result.#(metric.instance==\"homeserver\").value.1" | printf "%.0f" }}%</li>
      <li>RAM {{ $mem.JSON.Float "data.result.#(metric.instance==\"homeserver\").value.1" | printf "%.0f" }}%</li>
    </ul>
    {{ else }}
    <p class="color-base">Offline / keine Daten</p>
    {{ end }}
  </li>
  <li>
    <p class="color-highlight">worker-0 (.95)</p>
    {{ if .JSON.Exists "data.result.#(metric.instance==\"worker-0\")" }}
    <ul class="list-horizontal-text">
      <li>CPU {{ .JSON.Float "data.result.#(metric.instance==\"worker-0\").value.1" | printf "%.0f" }}%</li>
      <li>RAM {{ $mem.JSON.Float "data.result.#(metric.instance==\"worker-0\").value.1" | printf "%.0f" }}%</li>
    </ul>
    {{ else }}
    <p class="color-base">Offline / keine Daten</p>
    {{ end }}
  </li>
  <li>
    <p class="color-highlight">worker-1 (.96)</p>
    {{ if .JSON.Exists "data.result.#(metric.instance==\"worker-1\")" }}
    <ul class="list-horizontal-text">
      <li>CPU {{ .JSON.Float "data.result.#(metric.instance==\"worker-1\").value.1" | printf "%.0f" }}%</li>
      <li>RAM {{ $mem.JSON.Float "data.result.#(metric.instance==\"worker-1\").value.1" | printf "%.0f" }}%</li>
    </ul>
    {{ else }}
    <p class="color-base">Offline / keine Daten</p>
    {{ end }}
  </li>
  <li>
    <p class="color-highlight">ugreen-nas (.97)</p>
    {{ if .JSON.Exists "data.result.#(metric.instance==\"ugreen-nas\")" }}
    <ul class="list-horizontal-text">
      <li>CPU {{ .JSON.Float "data.result.#(metric.instance==\"ugreen-nas\").value.1" | printf "%.0f" }}%</li>
      <li>RAM {{ $mem.JSON.Float "data.result.#(metric.instance==\"ugreen-nas\").value.1" | printf "%.0f" }}%</li>
    </ul>
    {{ else }}
    <p class="color-base">Offline / keine Daten</p>
    {{ end }}
  </li>
</ul>` -}}
{{- end -}}
