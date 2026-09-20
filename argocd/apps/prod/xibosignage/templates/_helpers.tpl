{{- define "xibosignage.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- define "xibosignage.fullname" -}}
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
{{- define "xibosignage.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- define "xibosignage.labels" -}}
helm.sh/chart: {{ include "xibosignage.chart" . }}
{{ include "xibosignage.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}
{{- define "xibosignage.selectorLabels" -}}
app.kubernetes.io/name: {{ include "xibosignage.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/* ---- cms-web ---- */}}
{{- define "xibosignage.cms.fullname" -}}
{{- printf "%s-cms" (include "xibosignage.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- define "xibosignage.cms.selectorLabels" -}}
app.kubernetes.io/name: {{ include "xibosignage.name" . }}-cms
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}
{{- define "xibosignage.cms.labels" -}}
helm.sh/chart: {{ include "xibosignage.chart" . }}
{{ include "xibosignage.cms.selectorLabels" . }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/* ---- mysql ---- */}}
{{- define "xibosignage.mysql.fullname" -}}
{{- printf "%s-mysql" (include "xibosignage.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- define "xibosignage.mysql.selectorLabels" -}}
app.kubernetes.io/name: {{ include "xibosignage.name" . }}-mysql
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}
{{- define "xibosignage.mysql.labels" -}}
helm.sh/chart: {{ include "xibosignage.chart" . }}
{{ include "xibosignage.mysql.selectorLabels" . }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/* ---- xmr ---- */}}
{{- define "xibosignage.xmr.fullname" -}}
{{- printf "%s-xmr" (include "xibosignage.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- define "xibosignage.xmr.selectorLabels" -}}
app.kubernetes.io/name: {{ include "xibosignage.name" . }}-xmr
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}
{{- define "xibosignage.xmr.labels" -}}
helm.sh/chart: {{ include "xibosignage.chart" . }}
{{ include "xibosignage.xmr.selectorLabels" . }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/* ---- memcached ---- */}}
{{- define "xibosignage.memcached.fullname" -}}
{{- printf "%s-memcached" (include "xibosignage.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- define "xibosignage.memcached.selectorLabels" -}}
app.kubernetes.io/name: {{ include "xibosignage.name" . }}-memcached
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}
{{- define "xibosignage.memcached.labels" -}}
helm.sh/chart: {{ include "xibosignage.chart" . }}
{{ include "xibosignage.memcached.selectorLabels" . }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/* ---- quickchart ---- */}}
{{- define "xibosignage.quickchart.fullname" -}}
{{- printf "%s-quickchart" (include "xibosignage.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- define "xibosignage.quickchart.selectorLabels" -}}
app.kubernetes.io/name: {{ include "xibosignage.name" . }}-quickchart
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}
{{- define "xibosignage.quickchart.labels" -}}
helm.sh/chart: {{ include "xibosignage.chart" . }}
{{ include "xibosignage.quickchart.selectorLabels" . }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}
