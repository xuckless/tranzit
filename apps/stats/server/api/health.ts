import { execFile } from 'child_process'
import { promisify } from 'util'
import { SERVICES, type ServiceDef } from '../utils/services'

const execFileAsync = promisify(execFile)

const PROBE_TIMEOUT_MS = 6000

export interface HealthResult {
  key: string
  label: string
  container: string
  kind: ServiceDef['kind']
  healthy: boolean
  /** HTTP status code (http services), or null for docker / unreachable. */
  httpStatus: number | null
  /** Round-trip time of the probe in ms. */
  latencyMs: number | null
  /** Short human note: ok / docker health status / error message. */
  detail: string
}

async function probeHttp(svc: ServiceDef): Promise<HealthResult> {
  const ok = svc.okStatuses ?? [200]
  const started = Date.now()
  try {
    const res = await fetch(svc.url!, {
      method: 'GET',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    const latencyMs = Date.now() - started
    const healthy = ok.includes(res.status)
    return {
      key: svc.key,
      label: svc.label,
      container: svc.container,
      kind: svc.kind,
      healthy,
      httpStatus: res.status,
      latencyMs,
      detail: healthy ? 'ok' : `unexpected HTTP ${res.status}`,
    }
  } catch (error: any) {
    const latencyMs = Date.now() - started
    const detail =
      error?.name === 'TimeoutError' || error?.name === 'AbortError'
        ? `timeout after ${PROBE_TIMEOUT_MS}ms`
        : error?.message || 'unreachable'
    return {
      key: svc.key,
      label: svc.label,
      container: svc.container,
      kind: svc.kind,
      healthy: false,
      httpStatus: null,
      latencyMs,
      detail,
    }
  }
}

async function probeDocker(svc: ServiceDef): Promise<HealthResult> {
  const started = Date.now()
  try {
    // Prefer the container's healthcheck state; fall back to running state for
    // containers without a HEALTHCHECK (template yields "<no value>").
    const { stdout } = await execFileAsync('docker', [
      'inspect',
      '-f',
      '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}',
      svc.container,
    ])
    const state = stdout.trim()
    const healthy = state === 'healthy' || state === 'running'
    return {
      key: svc.key,
      label: svc.label,
      container: svc.container,
      kind: svc.kind,
      healthy,
      httpStatus: null,
      latencyMs: Date.now() - started,
      detail: state || 'unknown',
    }
  } catch (error: any) {
    return {
      key: svc.key,
      label: svc.label,
      container: svc.container,
      kind: svc.kind,
      healthy: false,
      httpStatus: null,
      latencyMs: Date.now() - started,
      detail: error?.message?.includes('No such object')
        ? 'container not found'
        : error?.message || 'docker inspect failed',
    }
  }
}

export default defineEventHandler(async () => {
  const data = await Promise.all(
    SERVICES.map((svc) =>
      svc.kind === 'http' ? probeHttp(svc) : probeDocker(svc),
    ),
  )

  return {
    status: 'success',
    checkedAt: new Date().toISOString(),
    healthy: data.filter((d) => d.healthy).length,
    total: data.length,
    data,
  }
})
