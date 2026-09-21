{{- define "omnirush-ee.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "omnirush-ee.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "omnirush-ee.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "omnirush-ee.selectorLabels" -}}
app.kubernetes.io/name: {{ include "omnirush-ee.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "omnirush-ee.labels" -}}
helm.sh/chart: {{ include "omnirush-ee.chart" . }}
{{ include "omnirush-ee.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "omnirush-ee.componentSelectorLabels" -}}
{{ include "omnirush-ee.selectorLabels" .root }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "omnirush-ee.componentLabels" -}}
{{ include "omnirush-ee.labels" .root }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "omnirush-ee.configName" -}}
{{ include "omnirush-ee.fullname" . }}-config
{{- end -}}

{{- define "omnirush-ee.allowPrivateMcpUrls" -}}
{{- $value := .Values.config.public.allowPrivateMcpUrls | default "" | toString | trim | lower -}}
{{- if eq $value "1" -}}
1
{{- else if or (eq $value "") (eq $value "0") (eq $value "false") -}}
{{- else -}}
{{- fail "config.public.allowPrivateMcpUrls must be blank, 0, false, or \"1\"" -}}
{{- end -}}
{{- end -}}

{{- define "omnirush-ee.secretName" -}}
{{- if .Values.secret.existingSecret -}}
{{- .Values.secret.existingSecret -}}
{{- else -}}
{{- include "omnirush-ee.fullname" . }}-secret
{{- end -}}
{{- end -}}

{{- define "omnirush-ee.denApiServiceName" -}}
{{ include "omnirush-ee.fullname" . }}-den-api
{{- end -}}

{{- define "omnirush-ee.denWebServiceName" -}}
{{ include "omnirush-ee.fullname" . }}-den-web
{{- end -}}

{{- define "omnirush-ee.inferenceServiceName" -}}
{{ include "omnirush-ee.fullname" . }}-inference
{{- end -}}

{{- define "omnirush-ee.denApiInternalUrl" -}}
{{- default (printf "http://%s:%v" (include "omnirush-ee.denApiServiceName" .) .Values.denApi.service.port) .Values.config.internal.apiBaseUrl -}}
{{- end -}}

{{- define "omnirush-ee.authFallbackInternalUrl" -}}
{{- default (include "omnirush-ee.denApiInternalUrl" .) .Values.config.internal.authFallbackBaseUrl -}}
{{- end -}}

{{- define "omnirush-ee.inferenceInternalUrl" -}}
{{- default (printf "http://%s:%v" (include "omnirush-ee.inferenceServiceName" .) .Values.inference.service.port) .Values.config.internal.inferenceProxyBaseUrl -}}
{{- end -}}

{{- define "omnirush-ee.customCa.mountPath" -}}
/etc/omnirush/custom-ca
{{- end -}}

{{- define "omnirush-ee.customCa.filePath" -}}
{{ include "omnirush-ee.customCa.mountPath" . }}/ca-bundle.pem
{{- end -}}

{{- define "omnirush-ee.customCa.validate" -}}
{{- if .Values.customCa.enabled -}}
{{- if and .Values.customCa.existingSecret .Values.customCa.existingConfigMap -}}
{{- fail "customCa.existingSecret and customCa.existingConfigMap are mutually exclusive when customCa.enabled=true" -}}
{{- end -}}
{{- if not (or .Values.customCa.existingSecret .Values.customCa.existingConfigMap) -}}
{{- fail "customCa.existingSecret or customCa.existingConfigMap is required when customCa.enabled=true" -}}
{{- end -}}
{{- if not .Values.customCa.key -}}
{{- fail "customCa.key is required when customCa.enabled=true" -}}
{{- end -}}
{{- if hasKey .Values.denApi.env "NODE_EXTRA_CA_CERTS" -}}
{{- fail "denApi.env.NODE_EXTRA_CA_CERTS conflicts with customCa.enabled=true; remove it and use customCa instead" -}}
{{- end -}}
{{- if hasKey .Values.denWeb.env "NODE_EXTRA_CA_CERTS" -}}
{{- fail "denWeb.env.NODE_EXTRA_CA_CERTS conflicts with customCa.enabled=true; remove it and use customCa instead" -}}
{{- end -}}
{{- if hasKey .Values.inference.env "NODE_EXTRA_CA_CERTS" -}}
{{- fail "inference.env.NODE_EXTRA_CA_CERTS conflicts with customCa.enabled=true; remove it and use customCa instead" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "omnirush-ee.customCa.volume" -}}
- name: custom-ca
  {{- if .Values.customCa.existingSecret }}
  secret:
    secretName: {{ .Values.customCa.existingSecret | quote }}
    items:
      - key: {{ .Values.customCa.key | quote }}
        path: ca-bundle.pem
  {{- else }}
  configMap:
    name: {{ .Values.customCa.existingConfigMap | quote }}
    items:
      - key: {{ .Values.customCa.key | quote }}
        path: ca-bundle.pem
  {{- end }}
{{- end -}}

{{- define "omnirush-ee.customCa.volumeMount" -}}
- name: custom-ca
  mountPath: {{ include "omnirush-ee.customCa.mountPath" . | quote }}
  readOnly: true
{{- end -}}

{{- define "omnirush-ee.customCa.env" -}}
- name: NODE_EXTRA_CA_CERTS
  value: {{ include "omnirush-ee.customCa.filePath" . | quote }}
{{- end -}}

{{- define "omnirush-ee.observabilityBackend" -}}
{{- $backend := default "none" .Values.observability.backend -}}
{{- if not (has $backend (list "none" "otel" "sentry")) -}}
{{- fail "observability.backend must be one of none, otel, sentry" -}}
{{- end -}}
{{- $backend -}}
{{- end -}}

{{- define "omnirush-ee.observabilityOtelExporter" -}}
{{- $exporter := default "otlp" .value -}}
{{- if not (has $exporter (list "otlp" "none")) -}}
{{- fail (printf "observability.otel.exporters.%s must be otlp or none" .signal) -}}
{{- end -}}
{{- $exporter -}}
{{- end -}}

{{- define "omnirush-ee.observabilityOtelSampler" -}}
{{- $sampler := default "parentbased_always_on" . -}}
{{- if not (has $sampler (list "always_on" "always_off" "traceidratio" "parentbased_always_on" "parentbased_always_off" "parentbased_traceidratio")) -}}
{{- fail "observability.otel.tracesSampler must be a standard OpenTelemetry sampler" -}}
{{- end -}}
{{- $sampler -}}
{{- end -}}

{{- define "omnirush-ee.observabilityEnv" -}}
{{- $root := .root -}}
{{- $serviceName := .serviceName -}}
{{- $backend := include "omnirush-ee.observabilityBackend" $root -}}
{{- $otel := $root.Values.observability.otel -}}
{{- $sentry := $root.Values.observability.sentry -}}
- name: DEN_OBSERVABILITY_BACKEND
  value: {{ $backend | quote }}
- name: OTEL_SERVICE_NAME
  value: {{ $serviceName | quote }}
{{- if eq $backend "otel" }}
{{- $otelSampler := include "omnirush-ee.observabilityOtelSampler" $otel.tracesSampler -}}
{{- $otelProtocol := default "http/protobuf" $otel.protocol -}}
{{- if ne $otelProtocol "http/protobuf" }}
{{- fail "observability.otel.protocol must be http/protobuf" -}}
{{- end }}
- name: OTEL_EXPORTER_OTLP_PROTOCOL
  value: {{ $otelProtocol | quote }}
{{- with $otel.endpoint }}
- name: OTEL_EXPORTER_OTLP_ENDPOINT
  value: {{ . | quote }}
{{- end }}
{{- with $otel.tracesEndpoint }}
- name: OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
  value: {{ . | quote }}
{{- end }}
{{- with $otel.metricsEndpoint }}
- name: OTEL_EXPORTER_OTLP_METRICS_ENDPOINT
  value: {{ . | quote }}
{{- end }}
{{- with $otel.logsEndpoint }}
- name: OTEL_EXPORTER_OTLP_LOGS_ENDPOINT
  value: {{ . | quote }}
{{- end }}
- name: OTEL_TRACES_EXPORTER
  value: {{ include "omnirush-ee.observabilityOtelExporter" (dict "signal" "traces" "value" $otel.exporters.traces) | quote }}
- name: OTEL_METRICS_EXPORTER
  value: {{ include "omnirush-ee.observabilityOtelExporter" (dict "signal" "metrics" "value" $otel.exporters.metrics) | quote }}
- name: OTEL_LOGS_EXPORTER
  value: {{ include "omnirush-ee.observabilityOtelExporter" (dict "signal" "logs" "value" $otel.exporters.logs) | quote }}
- name: OTEL_TRACES_SAMPLER
  value: {{ $otelSampler | quote }}
{{- if has $otelSampler (list "traceidratio" "parentbased_traceidratio") }}
- name: OTEL_TRACES_SAMPLER_ARG
  value: {{ default "1" $otel.tracesSamplerArg | quote }}
{{- else if and $otel.tracesSamplerArg (ne (toString $otel.tracesSamplerArg) "1") }}
{{- fail "observability.otel.tracesSamplerArg is only supported for traceidratio samplers" -}}
{{- end }}
{{- with $otel.headers.existingSecret }}
- name: OTEL_EXPORTER_OTLP_HEADERS
  valueFrom:
    secretKeyRef:
      name: {{ . | quote }}
      key: {{ $otel.headers.key | quote }}
{{- end }}
{{- else if eq $backend "sentry" }}
{{- if and $sentry.dsn $sentry.dsnSecret.existingSecret }}
{{- fail "observability.sentry.dsn and observability.sentry.dsnSecret.existingSecret are mutually exclusive" -}}
{{- end }}
{{- if not (or $sentry.dsn $sentry.dsnSecret.existingSecret) }}
{{- fail "observability.sentry.dsn or observability.sentry.dsnSecret.existingSecret is required when observability.backend=sentry" -}}
{{- end }}
- name: SENTRY_DSN
{{- if $sentry.dsn }}
  value: {{ $sentry.dsn | quote }}
{{- else }}
  valueFrom:
    secretKeyRef:
      name: {{ $sentry.dsnSecret.existingSecret | quote }}
      key: {{ $sentry.dsnSecret.key | quote }}
{{- end }}
- name: SENTRY_TRACES_SAMPLE_RATE
  value: {{ $sentry.tracesSampleRate | quote }}
{{- with $sentry.environment }}
- name: SENTRY_ENVIRONMENT
  value: {{ . | quote }}
{{- end }}
{{- with $sentry.release }}
- name: SENTRY_RELEASE
  value: {{ . | quote }}
{{- end }}
{{- with $sentry.dist }}
- name: SENTRY_DIST
  value: {{ . | quote }}
{{- end }}
{{- end }}
{{- end -}}
