import type { ScheduledTask } from "./types.js"
import { getAttachmentsDir } from "../utils/paths.js"

interface ExecutorOptions {
  serverUrl: string
  logger: {
    debug: (msg: string, ...args: any[]) => void
    info: (msg: string, ...args: any[]) => void
    error: (msg: string, ...args: any[]) => void
  }
  timeoutMs?: number
  /** Register an SSE listener for session.idle events */
  addSseListener?: (sessionId: string, fn: (event: unknown) => void) => void
  /** Remove a previously registered SSE listener */
  removeSseListener?: (sessionId: string, fn: (event: unknown) => void) => void
  /** Track owned sessions so EventProcessor doesn't filter them out */
  ownedSessions?: Set<string>
}

export async function executeScheduledTask(
  task: ScheduledTask,
  options: ExecutorOptions
): Promise<{ status: "success" | "error"; resultText?: string; errorMessage?: string; finishedAt: string; sessionId?: string }> {
  const { serverUrl, logger, timeoutMs = 5 * 60 * 1000 } = options
  const maxWaitMs = timeoutMs

  let sessionId: string | undefined

  try {
    logger.info(`[executor] Starting scheduled task "${task.name}" (id=${task.id})`)

    // 任务始终使用独立 session，不复用用户互动会话，避免污染用户上下文
    logger.debug(`[executor] Creating dedicated session for task`)
    const createResp = await fetch(`${serverUrl}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: task.projectId,
        worktree: task.projectWorktree,
      }),
    })

    if (!createResp.ok) {
      const errorText = await createResp.text()
      const error = `Failed to create session: HTTP ${createResp.status} - ${errorText}`
      logger.error(`[executor] ${error}`)
      return { status: "error", errorMessage: error, finishedAt: new Date().toISOString() }
    }

    const createData = (await createResp.json()) as { id?: string }
    sessionId = createData.id

    if (!sessionId) {
      const error = "No sessionId returned from opencode API"
      logger.error(`[executor] ${error}`)
      return { status: "error", errorMessage: error, finishedAt: new Date().toISOString() }
    }

    logger.info(`[executor] Dedicated session created: ${sessionId}`)

    // Register this session so EventProcessor accepts its SSE events
    options.ownedSessions?.add(sessionId)

    const attachmentsDir = getAttachmentsDir()
    const imContext = `[Task Context: ${task.channelId} (chatId: ${task.chatId})] Save files -> ${attachmentsDir} (auto-send to user). You can save files to this directory after task completed.

${task.prompt}`

    const resp = await fetch(`${serverUrl}/session/${sessionId}/prompt_async`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        parts: [{ type: "text", text: imContext }],
        modelId: task.model?.modelID || undefined,
        providerId: task.model?.providerID || undefined,
        agent: task.agent || undefined,
      }),
    })

    if (!resp.ok) {
      let errorMessage = `Failed to execute task: HTTP ${resp.status}`
      try {
        const errorData = await resp.json() as { data?: { providerID?: string; modelID?: string }; message?: string }
        if (errorData.data?.providerID && errorData.data?.modelID) {
          errorMessage = `Model not found: ${errorData.data.providerID}/${errorData.data.modelID}`
        } else if (errorData.message) {
          errorMessage = `Failed to execute task: ${errorData.message}`
        }
      } catch {
        const errorText = await resp.text()
        if (errorText) errorMessage += ` - ${errorText.slice(0, 200)}`
      }
      logger.error(`[executor] ${errorMessage}`)
      return { status: "error", errorMessage, finishedAt: new Date().toISOString() }
    }

    logger.debug(`[executor] Task posted to session: ${sessionId}`)

    const resultText = options.addSseListener && options.removeSseListener
      ? await waitForSseIdle(sessionId, serverUrl, maxWaitMs, logger, options.addSseListener, options.removeSseListener)
      : await waitForPolling(sessionId, serverUrl, maxWaitMs, logger)

    logger.info(`[executor] Scheduled task "${task.name}" completed`)

    return {
      status: "success",
      resultText,
      sessionId,
      finishedAt: new Date().toISOString(),
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err)
    logger.error(`[executor] Scheduled task "${task.name}" failed:`, err)
    return {
      status: "error",
      errorMessage,
      finishedAt: new Date().toISOString(),
    }
  }
}

/**
 * Wait for session.idle SSE event (opencode v1.14+).
 * Falls back to polling if no event within maxWaitMs.
 */
async function waitForSseIdle(
  sessionId: string,
  serverUrl: string,
  maxWaitMs: number,
  logger: ExecutorOptions["logger"],
  addSseListener: NonNullable<ExecutorOptions["addSseListener"]>,
  removeSseListener: NonNullable<ExecutorOptions["removeSseListener"]>,
): Promise<string> {
  return new Promise<string>((resolve) => {
    const pollInterval = 2_000
    let settled = false

    const onIdle = (rawEvent: unknown): void => {
      const event = rawEvent as Record<string, unknown>
      if (event.type === "session.idle") {
        const props = event.properties as Record<string, unknown> | undefined
        if (props?.sessionID === sessionId) {
          settled = true
          removeSseListener(sessionId, onIdle)
          fetchMessages(sessionId, serverUrl, logger).then(resolve)
        }
      }
    }

    addSseListener(sessionId, onIdle)

    // Polling fallback: if SSE event doesn't arrive in time, fall back to token stability
    const fallbackTimer = setTimeout(async () => {
      if (!settled) {
        removeSseListener(sessionId, onIdle)
        logger.debug(`[executor] SSE session.idle timeout for ${sessionId}, falling back to polling`)
        const result = await waitForPolling(sessionId, serverUrl, maxWaitMs, logger)
        resolve(result)
      }
    }, maxWaitMs)

    // Also poll periodically so we can resolve early if the event arrives
    // but the poll discovers the session is idle before maxWaitMs
    const pollTimer = setInterval(async () => {
      if (settled) {
        clearInterval(pollTimer)
        clearTimeout(fallbackTimer)
        return
      }
      // Quick check if session has output — if not yet, skip
      const statusResp = await fetch(`${serverUrl}/session/${sessionId}`)
      if (!statusResp.ok) return
      const session = (await statusResp.json()) as { tokens?: { output?: number } }
      if ((session.tokens?.output ?? 0) > 0) {
        // Agent has started — just wait for SSE, don't poll for completion
        return
      }
    }, pollInterval)
  })
}

/**
 * Poll session API for token output stability (fallback when SSE not available).
 * tokens.output is cumulative — when it stops increasing, the agent has finished.
 */
async function waitForPolling(
  sessionId: string,
  serverUrl: string,
  maxWaitMs: number,
  logger: ExecutorOptions["logger"],
): Promise<string> {
  const start = Date.now()
  let lastOutput = 0
  let stableCount = 0
  while (Date.now() - start < maxWaitMs) {
    await new Promise((r) => setTimeout(r, 2_000))

    const statusResp = await fetch(`${serverUrl}/session/${sessionId}`)
    if (!statusResp.ok) {
      logger.debug(`[executor] Poll /session/${sessionId} returned HTTP ${statusResp.status}, retrying...`)
      continue
    }

    const session = (await statusResp.json()) as {
      tokens?: { output?: number }
    }
    const currentOutput = session.tokens?.output ?? 0
    if (currentOutput > 0 && currentOutput === lastOutput) {
      stableCount++
      if (stableCount >= 3) {
        return fetchMessages(sessionId, serverUrl, logger)
      }
    } else {
      if (currentOutput !== lastOutput) stableCount = 0
      lastOutput = currentOutput
    }
  }

  return "(timed out waiting for response)"
}

/**
 * Fetch session messages and extract the last non-empty text response.
 */
async function fetchMessages(
  sessionId: string,
  serverUrl: string,
  logger: ExecutorOptions["logger"],
): Promise<string> {
  const msgResp = await fetch(`${serverUrl}/session/${sessionId}/message?limit=50`)
  if (!msgResp.ok) return "(failed to retrieve response)"

  type MsgPart = { type?: string; text?: string }
  type Message = { info?: { role?: string }; parts?: MsgPart[] }
  const messages = (await msgResp.json()) as Message[]
  const responseMsgs = messages.slice(1)

  for (let i = responseMsgs.length - 1; i >= 0; i--) {
    const msg = responseMsgs[i]
    if (msg?.parts) {
      const text = msg.parts
        .filter((p) => p.type === "text" && p.text)
        .map((p) => p.text!)
        .join("")
      if (text) return text
    }
  }

  return "(no response)"
}