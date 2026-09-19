{{/*
Basis-Name des Charts (kann per nameOverride ueberschrieben werden)
*/}}
{{- define "pacman.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Voller Name des Objekts. fullnameOverride hat Vorrang,
sonst Release-Name + Chart-Name.
*/}}
{{- define "pacman.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name (include "pacman.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{/*
Gemeinsame Labels
*/}}
{{- define "pacman.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
app.kubernetes.io/name: {{ include "pacman.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{/*
Selector-Labels (nur die stabilen, fuer matchLabels/selector)
*/}}
{{- define "pacman.selectorLabels" -}}
app.kubernetes.io/name: {{ include "pacman.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
