{{- define "authentik.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "authentik.fullname" -}}
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

{{- define "authentik.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "authentik.labels" -}}
helm.sh/chart: {{ include "authentik.chart" . }}
{{ include "authentik.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "authentik.selectorLabels" -}}
app.kubernetes.io/name: {{ include "authentik.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "authentik.serverSelectorLabels" -}}
{{ include "authentik.selectorLabels" . }}
app.kubernetes.io/component: server
{{- end }}

{{- define "authentik.workerSelectorLabels" -}}
{{ include "authentik.selectorLabels" . }}
app.kubernetes.io/component: worker
{{- end }}

{{- define "authentik.postgresSelectorLabels" -}}
{{ include "authentik.selectorLabels" . }}
app.kubernetes.io/component: postgres
{{- end }}

{{- define "authentik.redisSelectorLabels" -}}
{{ include "authentik.selectorLabels" . }}
app.kubernetes.io/component: redis
{{- end }}

{{- define "authentik.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "authentik.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Gemeinsame Env-Vars für Server + Worker — beide Prozesse brauchen dieselbe
DB-/Secret-Konfiguration (Muster wie beim offiziellen goauthentik/helm-Chart).
*/}}
{{- define "authentik.commonEnv" -}}
- name: AUTHENTIK_POSTGRESQL__HOST
  value: {{ include "authentik.fullname" . }}-postgres
- name: AUTHENTIK_POSTGRESQL__NAME
  value: {{ .Values.postgresql.database | quote }}
- name: AUTHENTIK_POSTGRESQL__USER
  value: {{ .Values.postgresql.username | quote }}
- name: AUTHENTIK_POSTGRESQL__PASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ .Values.credentials.secretName }}
      key: db-password
- name: AUTHENTIK_SECRET_KEY
  valueFrom:
    secretKeyRef:
      name: {{ .Values.credentials.secretName }}
      key: secret-key
- name: AUTHENTIK_BOOTSTRAP_PASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ .Values.credentials.secretName }}
      key: bootstrap-password
- name: AUTHENTIK_BOOTSTRAP_EMAIL
  valueFrom:
    secretKeyRef:
      name: {{ .Values.credentials.secretName }}
      key: bootstrap-email
- name: AUTHENTIK_LDAP_BIND_PASSWORD
  # Kein offizieller AUTHENTIK_*-Reserved-Name — frei gewählt, nur damit die
  # Blueprints (blueprints/00-ldap-source.yaml) per !Env darauf zugreifen
  # können, ohne das Passwort im Blueprint-YAML selbst im Klartext zu haben.
  valueFrom:
    secretKeyRef:
      name: {{ .Values.credentials.secretName }}
      key: ldap-bind-password
- name: AUTHENTIK_ERROR_REPORTING__ENABLED
  value: "false"
- name: AUTHENTIK_AVATARS
  value: "none"
- name: AUTHENTIK_LOG_LEVEL
  value: {{ .Values.logLevel | quote }}
- name: AUTHENTIK_REDIS__HOST
  value: {{ include "authentik.fullname" . }}-redis
{{- end }}
