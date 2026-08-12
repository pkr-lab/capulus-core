{{- define "immich.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- define "immich.fullname" -}}
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
{{- define "immich.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- define "immich.labels" -}}
helm.sh/chart: {{ include "immich.chart" . }}
{{ include "immich.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}
{{- define "immich.selectorLabels" -}}
app.kubernetes.io/name: {{ include "immich.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "immich.server.fullname" -}}
{{- printf "%s-server" (include "immich.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- define "immich.server.labels" -}}
{{- include "immich.labels" . }}
app.kubernetes.io/component: server
{{- end }}
{{- define "immich.server.selectorLabels" -}}
{{- include "immich.selectorLabels" . }}
app.kubernetes.io/component: server
{{- end }}

{{- define "immich.ml.fullname" -}}
{{- printf "%s-machine-learning" (include "immich.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- define "immich.ml.labels" -}}
{{- include "immich.labels" . }}
app.kubernetes.io/component: machine-learning
{{- end }}
{{- define "immich.ml.selectorLabels" -}}
{{- include "immich.selectorLabels" . }}
app.kubernetes.io/component: machine-learning
{{- end }}

{{- define "immich.postgresql.fullname" -}}
{{- printf "%s-postgresql" (include "immich.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- define "immich.postgresql.labels" -}}
{{- include "immich.labels" . }}
app.kubernetes.io/component: postgresql
{{- end }}
{{- define "immich.postgresql.selectorLabels" -}}
{{- include "immich.selectorLabels" . }}
app.kubernetes.io/component: postgresql
{{- end }}

{{- define "immich.redis.fullname" -}}
{{- printf "%s-redis" (include "immich.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- define "immich.redis.labels" -}}
{{- include "immich.labels" . }}
app.kubernetes.io/component: redis
{{- end }}
{{- define "immich.redis.selectorLabels" -}}
{{- include "immich.selectorLabels" . }}
app.kubernetes.io/component: redis
{{- end }}
