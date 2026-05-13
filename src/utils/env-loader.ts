/**
 * Minimal .env file loader.
 *
 * Reads KEY=VALUE lines from a .env file and sets them on process.env.
 * Does NOT override values already present in the environment.
 */

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

/** Fixed config directory for all opencode-lark configs */
export const CONFIG_DIR = path.join(os.homedir(), ".config", "opencode-lark")
export const DEFAULT_SERVER_URL = "http://localhost:4096"
export const DEFAULT_LAUNCHER_COMMAND = "opencode serve"

/** Create CONFIG_DIR recursively if it doesn't exist */
export function ensureConfigDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true })
  }
}

/**
 * Scan CONFIG_DIR for `.env.*` files and extract appId from filenames.
 * E.g. `.env.cli_abc123` → appId "cli_abc123"
 */
export function listEnvFiles(): Array<{ appId: string, filePath: string }> {
  if (!fs.existsSync(CONFIG_DIR)) return []

  const entries = fs.readdirSync(CONFIG_DIR)
  const results: Array<{ appId: string, filePath: string }> = []

  for (const entry of entries) {
    if (entry.startsWith(".env.") && entry.length > 5) {
      const appId = entry.slice(5) // strip ".env."
      results.push({ appId, filePath: path.join(CONFIG_DIR, entry) })
    }
  }

  return results
}

export function loadEnvFile(filePath?: string): void {
  if (!filePath) return

  if (!fs.existsSync(filePath)) return

  const content = fs.readFileSync(filePath, "utf-8")

  for (const line of content.split("\n")) {
    const trimmed = line.trim()

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith("#")) continue

    const eqIndex = trimmed.indexOf("=")
    if (eqIndex === -1) continue

    const key = trimmed.slice(0, eqIndex).trim()
    let value = trimmed.slice(eqIndex + 1).trim()

    // Strip surrounding quotes (single or double)
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }

    // Don't override existing env vars
    if (process.env[key] === undefined) {
      process.env[key] = value
    }
  }
}

function isLocalServerUrl(serverUrl: string): boolean {
  try {
    const { hostname } = new URL(serverUrl)
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"
  } catch {
    return false
  }
}

export function shouldBootstrapLauncher(serverUrl: string): boolean {
  return isLocalServerUrl(serverUrl)
}

export function buildLauncherEnvLines(serverUrl: string): string[] {
  if (!shouldBootstrapLauncher(serverUrl)) return []

  return [
    "OPENCODE_LAUNCHER_ENABLED=true",
    "OPENCODE_AUTO_START_SERVER=true",
    `OPENCODE_SERVER_COMMAND=${DEFAULT_LAUNCHER_COMMAND}`,
  ]
}

export function bootstrapLauncherEnv(serverUrl?: string): void {
  const resolvedServerUrl = serverUrl || process.env.OPENCODE_SERVER_URL || DEFAULT_SERVER_URL
  if (!shouldBootstrapLauncher(resolvedServerUrl)) return

  if (process.env.OPENCODE_LAUNCHER_ENABLED === undefined) {
    process.env.OPENCODE_LAUNCHER_ENABLED = "true"
  }
  if (process.env.OPENCODE_AUTO_START_SERVER === undefined) {
    process.env.OPENCODE_AUTO_START_SERVER = "true"
  }
  if (process.env.OPENCODE_SERVER_COMMAND === undefined) {
    process.env.OPENCODE_SERVER_COMMAND = DEFAULT_LAUNCHER_COMMAND
  }
}
