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
}

export async function executeScheduledTask(
  task: ScheduledTask,
  options: ExecutorOptions
): Promise<{ status: "success" | "error"; resultText?: string; errorMessage?: string; finishedAt: string; sessionId?: string }> {
  const { serverUrl, logger, timeoutMs = 5 * 60 * 1000 } = options
  const maxWaitMs = timeoutMs
  const pollInterval = 2_000

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

    const resultText = await waitForResponse(sessionId, serverUrl, maxWaitMs, pollInterval, logger)

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

async function waitForResponse(
  sessionId: string,
  serverUrl: string,
  maxWaitMs: number,
  pollInterval: number,
  logger: ExecutorOptions["logger"]
): Promise<string> {
  const start = Date.now()
  let lastUpdated = 0
  let stableCount = 0
  while (Date.now() - start < maxWaitMs) {
    await new Promise((r) => setTimeout(r, pollInterval))

    const statusResp = await fetch(`${serverUrl}/session/${sessionId}`)
    if (!statusResp.ok) {
      logger.debug(`[executor] Poll /session/${sessionId} returned HTTP ${statusResp.status}, retrying...`)
      continue
    }

    const session = (await statusResp.json()) as {
      status?: { type?: string }
      time?: { updated?: number }
      tokens?: { output?: number }
    }
    // Detect idle: opencode v1.14+ no longer returns status.type,
    // use time.updated stability + token output as idle signal
    const currentUpdated = session.time?.updated ?? 0
    if (currentUpdated === lastUpdated && session.tokens?.output && session.tokens.output > 0) {
      stableCount++
      if (stableCount >= 2) {
        const msgResp = await fetch(`${serverUrl}/session/${sessionId}/message?limit=50`)
        if (msgResp.ok) {
          type MsgPart = { type?: string; text?: string }
          type Message = { role?: string; parts?: MsgPart[] }
          const messages = (await msgResp.json()) as Message[]
          // 跳过第一条（用户 prompt），取最后一条有 text 的消息
          const responseMsgs = messages.slice(1)
          const last = responseMsgs[responseMsgs.length - 1]
          if (last?.parts) {
            const text = last.parts
              .filter((p) => p.type === "text" && p.text)
              .map((p) => p.text!)
              .join("")
            return text || "(no response)"
          }
        }
        return "(failed to retrieve response)"
      }
    } else {
      if (currentUpdated !== lastUpdated) stableCount = 0
      lastUpdated = currentUpdated
    }
  }

  return "(timed out waiting for response)"
}
