import { spawn } from "node:child_process"
import type { LauncherConfig } from "../utils/config.js"
import type { Logger } from "../utils/logger.js"

export interface ServiceLauncher {
  ensureServerReady(reason: string): Promise<EnsureServerReadyResult>
  probeServer(): Promise<boolean>
}

export interface EnsureServerReadyResult {
  healthy: boolean
  started: boolean
}

export interface ServiceLauncherOptions {
  config?: LauncherConfig
  serverUrl: string
  logger: Logger
}

export function createServiceLauncher(
  options: ServiceLauncherOptions,
): ServiceLauncher {
  const { config, serverUrl, logger } = options
  let startPromise: Promise<boolean> | null = null

  async function probeServer(): Promise<boolean> {
    const timeoutMs = config?.probeTimeoutMs ?? 4000
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const resp = await fetch(`${serverUrl}/global/health`, {
        signal: controller.signal,
      })
      if (!resp.ok) return false
      const data = await resp.json().catch(() => ({})) as { healthy?: boolean }
      return data.healthy !== false
    } catch {
      return false
    } finally {
      clearTimeout(timer)
    }
  }

  async function waitForServer(timeoutMs: number): Promise<boolean> {
    const startedAt = Date.now()

    while (Date.now() - startedAt < timeoutMs) {
      if (await probeServer()) {
        return true
      }
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }

    return false
  }

  async function startServerProcess(reason: string): Promise<boolean> {
    if (!config?.enabled || !config.autoStartServer || !config.serverCommand) {
      return false
    }

    logger.warn(`[launcher] opencode server unavailable, starting process (${reason})`)

    const child = spawn(config.serverCommand, {
      cwd: config.serverCwd || process.cwd(),
      detached: true,
      shell: true,
      stdio: "ignore",
    })

    child.unref()

    const timeoutMs = config.serverStartTimeoutMs ?? 30000
    const healthy = await waitForServer(timeoutMs)
    if (!healthy) {
      logger.error(`[launcher] opencode server did not become ready within ${timeoutMs}ms`)
      return false
    }

    logger.info("[launcher] opencode server is ready")
    return true
  }

  async function ensureServerReady(reason: string): Promise<EnsureServerReadyResult> {
    if (await probeServer()) {
      return { healthy: true, started: false }
    }

    if (!config?.enabled || !config.autoStartServer || !config.serverCommand) {
      return { healthy: false, started: false }
    }

    if (!startPromise) {
      startPromise = startServerProcess(reason).finally(() => {
        startPromise = null
      })
    } else {
      logger.info(`[launcher] waiting for in-flight server start (${reason})`)
    }

    const started = await startPromise
    const healthy = started || await probeServer()
    return { healthy, started }
  }

  return {
    ensureServerReady,
    probeServer,
  }
}
