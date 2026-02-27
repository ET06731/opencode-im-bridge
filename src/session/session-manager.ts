import { type Database, type Statement } from "bun:sqlite"
import { createLogger } from "../utils/logger.js"
import type { SessionMapping } from "../types.js"

const logger = createLogger("session-manager")

interface SessionManagerOptions {
  serverUrl: string
  db: Database
  defaultAgent: string
}

export interface SessionManager {
  getOrCreate(feishuKey: string, agent?: string): Promise<string>
  getSession(feishuKey: string): SessionMapping | null
  deleteMapping(feishuKey: string): boolean
  cleanup(maxAgeMs?: number): number
}

function getWorkingDirectory(): string {
  return process.env.OPENCODE_CWD || process.cwd()
}

interface TuiSession {
  id: string
  title?: string
  directory?: string
  time?: { created: number; updated: number }
}

export function createSessionManager(
  options: SessionManagerOptions,
): SessionManager {
  const { serverUrl, db, defaultAgent } = options

  db.exec(`
    CREATE TABLE IF NOT EXISTS feishu_sessions (
      feishu_key  TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL,
      agent       TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      last_active INTEGER NOT NULL,
      is_bound    INTEGER DEFAULT 0
    )
  `)

  try {
    db.exec("ALTER TABLE feishu_sessions ADD COLUMN is_bound INTEGER DEFAULT 0")
  } catch {
    // Column already exists — safe to ignore
  }

  const getStmt = db.prepare(
    "SELECT * FROM feishu_sessions WHERE feishu_key = ?",
  )

  const upsertStmt = db.prepare(
    `INSERT OR REPLACE INTO feishu_sessions
       (feishu_key, session_id, agent, created_at, last_active, is_bound)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )

  const updateActiveStmt = db.prepare(
    "UPDATE feishu_sessions SET last_active = ? WHERE feishu_key = ?",
  )

  const cleanupStmt = db.prepare(
    "DELETE FROM feishu_sessions WHERE last_active < ?",
  )

  const deleteMappingStmt = db.prepare(
    "DELETE FROM feishu_sessions WHERE feishu_key = ?",
  )

  async function discoverTuiSession(): Promise<TuiSession | null> {
    const cwd = getWorkingDirectory()
    const url = `${serverUrl}/session?roots=true&limit=1&directory=${encodeURIComponent(cwd)}`

    try {
      const resp = await fetch(url)
      if (!resp.ok) return null

      const sessions = (await resp.json()) as TuiSession[]
      return sessions[0] ?? null
    } catch {
      return null
    }
  }

  async function createNewSession(feishuKey: string): Promise<string> {
    const resp = await fetch(`${serverUrl}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: `Feishu chat ${feishuKey}` }),
    })

    if (!resp.ok) {
      throw new Error(`Failed to create session: HTTP ${resp.status}`)
    }

    const data = (await resp.json()) as { id: string }
    return data.id
  }

  return {
    async getOrCreate(feishuKey, agent) {
      const existing = getStmt.get(feishuKey) as SessionMapping | null

      if (existing) {
        updateActiveStmt.run(Date.now(), feishuKey)
        return existing.session_id
      }

      const agentName = agent ?? defaultAgent
      logger.info(`Resolving session for ${feishuKey} (agent: ${agentName})`)

      const discovered = await discoverTuiSession()

      if (discovered) {
        const now = Date.now()
        upsertStmt.run(feishuKey, discovered.id, agentName, now, now, 1)
        logger.info(`Bound to TUI session: ${feishuKey} → ${discovered.id}`)
        return discovered.id
      }

      const sessionId = await createNewSession(feishuKey)
      const now = Date.now()
      upsertStmt.run(feishuKey, sessionId, agentName, now, now, 0)
      logger.info(`Session created: ${feishuKey} → ${sessionId}`)
      return sessionId
    },

    getSession(feishuKey) {
      return (getStmt.get(feishuKey) as SessionMapping | undefined) ?? null
    },

    deleteMapping(feishuKey) {
      const result = deleteMappingStmt.run(feishuKey)
      if (result.changes > 0) {
        logger.info(`Deleted session mapping for ${feishuKey}`)
      }
      return result.changes > 0
    },

    cleanup(maxAgeMs = 30 * 60 * 1000) {
      const cutoff = Date.now() - maxAgeMs
      const result = cleanupStmt.run(cutoff)
      if (result.changes > 0) {
        logger.info(`Cleaned up ${result.changes} expired session mappings`)
      }
      return result.changes
    },
  }
}
