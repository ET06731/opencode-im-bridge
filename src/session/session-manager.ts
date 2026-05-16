import { type Database } from "bun:sqlite"
import { createLogger } from "../utils/logger.js"
import type { SessionMapping } from "../types.js"

const logger = createLogger("session-manager")

interface SessionManagerOptions {
  serverUrl: string
  db: Database
  defaultAgent: string
  defaultModel?: string | null
}

export interface SessionManager {
  getOrCreate(feishuKey: string, agent?: string): Promise<string>
  getExisting(feishuKey: string): Promise<string | undefined>
  getSession(feishuKey: string): SessionMapping | null
  deleteMapping(feishuKey: string): boolean
  setMapping(feishuKey: string, sessionId: string, agent?: string): boolean
  setModel(feishuKey: string, model: string | null): boolean
  cleanup(maxAgeMs?: number): number
  validateAndCleanupStale(): Promise<number>
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
  const { serverUrl, db, defaultAgent, defaultModel = null } = options

  db.exec(`
    CREATE TABLE IF NOT EXISTS feishu_sessions (
      feishu_key  TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL,
      agent       TEXT NOT NULL,
      model       TEXT,
      created_at  INTEGER NOT NULL,
      last_active INTEGER NOT NULL,
      is_bound    INTEGER DEFAULT 0
    )
  `)

  try {
    db.exec("ALTER TABLE feishu_sessions ADD COLUMN is_bound INTEGER DEFAULT 0")
  } catch {
    // Column already exists.
  }

  try {
    db.exec("ALTER TABLE feishu_sessions ADD COLUMN model TEXT")
  } catch {

    // Column already exists — safe to ignore
  }

  const getStmt = db.prepare(
    "SELECT * FROM feishu_sessions WHERE feishu_key = ?",
  )

  const upsertStmt = db.prepare(
    `INSERT OR REPLACE INTO feishu_sessions
       (feishu_key, session_id, agent, model, created_at, last_active, is_bound)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
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

  const updateModelStmt = db.prepare(
    "UPDATE feishu_sessions SET model = ?, last_active = ? WHERE feishu_key = ?",
  )

  /** Check whether a session ID actually exists on the opencode server.
   *  Returns false ONLY on 404. All other errors (500, 429, network) return true (conservative). */

  async function sessionExistsOnServer(sessionId: string): Promise<boolean> {
    try {
      const resp = await fetch(`${serverUrl}/session/${sessionId}`)
      return resp.status !== 404
    } catch {
      return true
    }
  }

  async function discoverTuiSession(): Promise<TuiSession | null> {
    const cwd = getWorkingDirectory()
    const url = `${serverUrl}/session?roots=true&limit=1&directory=${encodeURIComponent(cwd)}`

    try {
      const resp = await fetch(url)
      if (!resp.ok) return null

      const sessions = (await resp.json()) as TuiSession[]
      const candidate = sessions[0] ?? null
      if (!candidate) return null

      const exists = await sessionExistsOnServer(candidate.id)
      if (!exists) {
        logger.warn(`Discovered TUI session ${candidate.id} returned 404, skipping`)
        return null
      }

      return candidate
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
        upsertStmt.run(feishuKey, discovered.id, agentName, defaultModel, now, now, 1)

        logger.info(`Bound to TUI session: ${feishuKey} → ${discovered.id}`)

        return discovered.id
      }

      const sessionId = await createNewSession(feishuKey)
      const now = Date.now()
      upsertStmt.run(feishuKey, sessionId, agentName, defaultModel, now, now, 0)

      logger.info(`Session created: ${feishuKey} → ${sessionId}`)

      return sessionId
    },

    async getExisting(feishuKey) {
      const existing = getStmt.get(feishuKey) as SessionMapping | null
      return existing?.session_id
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

    setMapping(feishuKey, sessionId, agent) {
      const existing = getStmt.get(feishuKey) as SessionMapping | null
      const sameSession = existing?.session_id === sessionId
      const agentName = agent ?? (sameSession ? existing?.agent : defaultAgent) ?? defaultAgent

      const now = Date.now()
      const nextModel = existing?.model ?? defaultModel

      const result = upsertStmt.run(feishuKey, sessionId, agentName, nextModel, now, now, 1)
      if (result.changes > 0) {
        logger.info(`Set session mapping: ${feishuKey} -> ${sessionId}`)
      }
      return result.changes > 0
    },

    setModel(feishuKey, model) {
      const now = Date.now()
      const result = updateModelStmt.run(model, now, feishuKey)
      if (result.changes > 0) {
        logger.info(`Updated model mapping for ${feishuKey}: ${model ?? "(cleared)"}`)
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

    async validateAndCleanupStale() {
      const allMappingsStmt = db.prepare("SELECT * FROM feishu_sessions")
      const allMappings = allMappingsStmt.all() as SessionMapping[]
      let cleaned = 0

      for (const mapping of allMappings) {
        try {
          const exists = await sessionExistsOnServer(mapping.session_id)
          if (!exists) {
            deleteMappingStmt.run(mapping.feishu_key)
            cleaned++
            logger.info(`Startup cleanup: removed stale mapping ${mapping.feishu_key} -> ${mapping.session_id}`)
          }
        } catch (err) {
          logger.warn(`Startup cleanup: failed to validate ${mapping.session_id}: ${err}`)
        }
      }

      if (cleaned > 0) {
        logger.info(`Startup cleanup: removed ${cleaned} stale session mapping(s)`)
      } else if (allMappings.length > 0) {
        logger.info(`Startup cleanup: all ${allMappings.length} session mapping(s) valid`)
      }

      return cleaned
    },
  }
}
