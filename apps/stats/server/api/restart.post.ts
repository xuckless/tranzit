import { execFile } from 'child_process'
import { promisify } from 'util'
import { RESTART_WHITELIST } from '../utils/services'

const execFileAsync = promisify(execFile)

/**
 * Restarts a single Tranzit container. This re-runs the manual netns-desync fix:
 * `docker restart <app-container>` re-attaches the app to its sidecar's current
 * network namespace, clearing the Funnel 502.
 *
 * Security: the container name is validated against RESTART_WHITELIST before use,
 * and we shell out with execFile (array args, no shell) so a crafted name cannot
 * inject commands.
 */
export default defineEventHandler(async (event) => {
  const body = await readBody<{ container?: string }>(event)
  const container = body?.container?.trim()

  if (!container || !RESTART_WHITELIST.has(container)) {
    setResponseStatus(event, 400)
    return {
      status: 'error',
      message: `Refusing to restart "${container ?? ''}": not a known Tranzit service`,
    }
  }

  try {
    const { stdout } = await execFileAsync('docker', ['restart', container], {
      timeout: 60_000,
    })
    return {
      status: 'success',
      container,
      message: `Restarted ${container}`,
      output: stdout.trim(),
    }
  } catch (error: any) {
    console.error(`Restart failed for ${container}:`, error)
    setResponseStatus(event, 500)
    return {
      status: 'error',
      container,
      message: error?.stderr?.trim() || error?.message || 'docker restart failed',
    }
  }
})
