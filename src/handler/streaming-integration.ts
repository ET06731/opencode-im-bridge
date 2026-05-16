
import type { CardKitClient } from "../feishu/cardkit-client.js"
import type { FeishuApiClient } from "../feishu/api-client.js"
import type { SubAgentTracker } from "../streaming/subagent-tracker.js"
import type { Logger } from "../utils/logger.js"
import type { EventProcessor } from "../streaming/event-processor.js"
import type { QuestionAsked, PermissionRequested } from "../streaming/event-processor.js"
import type { EventListenerMap } from "../utils/event-listeners.js"
import { addListener, removeListener } from "../utils/event-listeners.js"
import { StreamingCardSession } from "../streaming/streaming-card.js"
import { buildResponseCard } from "../feishu/card-builder.js"
import type { OutboundMediaHandler } from "./outbound-media.js"
import { createTelegramInlineCard } from "../channel/telegram/telegram-interactive.js"
import type { StreamingSession } from "../channel/types.js"

// ── Types ──

export interface StreamingBridgeDeps {
  cardkitClient?: CardKitClient
  feishuClient?: FeishuApiClient
  subAgentTracker: SubAgentTracker
  logger: Logger
  seenInteractiveIds: Set<string>
  outboundMedia?: OutboundMediaHandler
  channelManager?: any // ChannelManager
}

export interface StreamingBridge {
  handleMessage(
    chatId: string,
    sessionId: string,
    eventListeners: EventListenerMap,
    eventProcessor: EventProcessor,
    sendMessage: () => Promise<string>,
    onComplete: (text: string) => void,
    messageId: string,
    reactionId: string | null,
    channelId?: string,
  ): Promise<void>
}

// ── Constants ──


const FIRST_EVENT_TIMEOUT_MS = 5 * 60 * 1_000 // 5 minutes — long tasks may take minutes before first SSE event

// ── Factory ──

export function createStreamingBridge(
  deps: StreamingBridgeDeps,
): StreamingBridge {
  const { cardkitClient, feishuClient, subAgentTracker, logger, seenInteractiveIds, channelManager } = deps

  return {
    async handleMessage(
      chatId: string,
      sessionId: string,
      eventListeners: EventListenerMap,
      eventProcessor: EventProcessor,
      sendMessage: () => Promise<string>,
      onComplete: (text: string) => void,
      messageId: string,
      reactionId: string | null,
      channelId: string = "feishu",
    ): Promise<void> {
      let card: StreamingCardSession | null = null
      let cardStartPromise: Promise<void> | null = null
      let streamSession: StreamingSession | null = null

      const plugin = channelManager?.getChannel(channelId)
      logger.info(`@@@@@ STREAMING BRIDGE V2 @@@@@ channelId=${channelId} plugin=${!!plugin}`)
      logger.info(`StreamingBridge handleMessage: sessionId=${sessionId}, channelId=${channelId}, pluginFound=${!!plugin}, outboundFound=${!!plugin?.outbound}`)

      if (deps.outboundMedia) {
        await deps.outboundMedia.snapshotAttachments(chatId)
      }

      const sendInteractiveCard = async (cardData: Record<string, unknown>): Promise<void> => {
        if (channelId === "telegram") {
          const keyboard = (cardData.reply_markup as { inline_keyboard?: unknown[] } | undefined)?.inline_keyboard
          if (Array.isArray(keyboard) && keyboard.length > 0 && plugin?.outbound?.sendCard) {
            await plugin.outbound.sendCard({ address: chatId }, cardData)
            return
          }
          if (plugin?.outbound?.sendText && typeof cardData.text === "string") {
            await plugin.outbound.sendText({ address: chatId }, cardData.text)
            return
          }
        }
        if (plugin?.outbound?.sendCard) {
          await plugin.outbound.sendCard({ address: chatId }, cardData)
          return
        }
        if (feishuClient) {
          await feishuClient.sendMessage(chatId, {
            msg_type: "interactive",
            content: JSON.stringify(cardData),
          })
          return
        }
        throw new Error(`No channel card sender available for ${channelId}`)
      }

      const ensureCard = (): void => {
        if (channelId !== "feishu") {
          if (!streamSession && plugin?.streaming) {
            streamSession = plugin.streaming.createStreamingSession({
              address: chatId,
              context: {
                messageId,
                streamMode: "edit",
              },
            })
          }
          return
        }
        if (card || cardStartPromise) return
        if (!cardkitClient || !feishuClient) {
          logger.warn(`Cannot start streaming card for session ${sessionId}: missing cardkitClient or feishuClient`)
          return
        }
        card = new StreamingCardSession({
          cardkitClient,
          feishuClient,
          chatId,
        })
        cardStartPromise = card.start().then(() => {
          logger.info(
            `Streaming card started for session ${sessionId} in chat ${chatId}`,
          )
        })
      }

      return new Promise<void>((resolve, reject) => {
        let textBuffer = ""
        let gotFirstEvent = false
        let settled = false
        let syncResponseBody = ""
        let typingInterval: ReturnType<typeof setInterval> | null = null

        const startTyping = (): void => {
          if (typingInterval) return // 防止重复启动

          if (channelId === "telegram") {
            const sendTypingAction = async (): Promise<void> => {
              try {
                const cfg = plugin?.config?.resolveAccount?.()
                const token = cfg?.botToken
                if (!token) return
                await fetch(`https://api.telegram.org/bot${token}/sendChatAction`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ chat_id: chatId, action: "typing" }),
                })
              } catch {}
            }
            void sendTypingAction()
            typingInterval = setInterval(() => void sendTypingAction(), 4000)
          } else if (channelId === "wechat" && plugin?.outbound?.sendTyping) {
            // WeChat: 发送"正在输入"状态
            logger.info(`[StreamingBridge] Calling WeChat sendTyping for ${chatId}`)
            plugin.outbound.sendTyping({ address: chatId }).catch((err: unknown) => {
              logger.error(`[StreamingBridge] WeChat sendTyping failed: ${err}`)
            })
          }
        }

        const stopTyping = (): void => {
          if (typingInterval) {
            clearInterval(typingInterval)
            typingInterval = null
          }
        }

        // Helper: send text reply and clean up reaction
        const sendFinalResponse = async (text: string, skipMessage = false): Promise<void> => {
          logger.info(`[StreamingBridge] sendFinalResponse called: text.length=${text.length}, skipMessage=${skipMessage}`)
          if (streamSession?.close) {
            await streamSession.close(text)
            skipMessage = true
          }
          if (!skipMessage) {
            if (plugin?.outbound?.sendText) {
              await plugin.outbound.sendText({ address: chatId }, text)
              logger.info(`[StreamingBridge] Final response sent via plugin ${channelId}`)
            } else if (feishuClient) {
              logger.info(`[StreamingBridge] Sending final response via Feishu API fallback to ${chatId}`)
              await feishuClient.replyMessage(messageId, {
                msg_type: "interactive",
                content: JSON.stringify(buildResponseCard(text)),
              })
              logger.info(`[StreamingBridge] Final response sent via Feishu API fallback`)
            } else {
              logger.warn(`No plugin outbound and no feishuClient available to send response for channel ${channelId}`)
            }
          }
          if (reactionId && channelId === "feishu" && feishuClient) {
            try {
              await feishuClient.deleteReaction(messageId, reactionId)
            } catch (err) {
              logger.warn(`deleteReaction failed: ${err}`)
            }
          }

          if (deps.outboundMedia && plugin?.outbound) {
            try {
              await deps.outboundMedia.sendDetectedFiles({ address: chatId }, text, plugin.outbound)
            } catch (err) {
              logger.warn(`StreamingBridge sendDetectedFiles failed: ${err}`)
            }
          }
        }

        // Named listener reference — stored for removeListener calls
        const myListener = (rawEvent: unknown): void => {
          const action = eventProcessor.processEvent(rawEvent)
          if (!action) return
          if (action.sessionId !== sessionId) return

          gotFirstEvent = true
          startTyping()

          switch (action.type) {
            case "TextDelta": {
              textBuffer += action.text
              if (textBuffer.length > 102_400) {
                textBuffer = textBuffer.slice(0, 102_400) + "\n\n...(内容过长，已截断)"
              }
              ensureCard()
              if (streamSession) {
                streamSession.pendingUpdates = [textBuffer]
                streamSession.flush().catch((err) => {
                  logger.warn(`streamSession.flush failed: ${err}`)
                })
              }
              if (card) {
                card.updateText(textBuffer).catch((err) => {
                  logger.warn(`card.updateText failed: ${err}`)
                })
              }
              break
            }



            case "ToolStateChange":
              ensureCard()
              if (cardStartPromise) {
                cardStartPromise.then(() => {
                  card!
                    .setToolStatus(
                      action.toolName,
                      action.state as "running" | "completed" | "error",
                      action.title,
                    )
                    .catch((err) => {
                      logger.warn(`setToolStatus failed: ${err}`)
                    })
                }).catch((err) => {
                  logger.warn(`card start for tool failed: ${err}`)
                })
              }
              break

            case "SubtaskDiscovered": {
              subAgentTracker
                .onSubtaskDiscovered(action)
                .then(async (tracked) => {
                  const childSessionId = tracked.childSessionId ?? action.sessionId
                  // Build and send a separate card for this sub-agent
                  const cardData = buildSubAgentNotificationCard(
                    action.description,
                    action.agent ?? "sub-agent",
                    childSessionId,
                  )
                  if (plugin?.outbound) {
                    await plugin.outbound.sendText({ address: chatId }, `[Subtask] ${action.description} (${action.agent})`)
                  } else if (feishuClient) {
                    await feishuClient.sendMessage(chatId, {
                      msg_type: "interactive",
                      content: JSON.stringify(cardData),
                    })
                  } else {
                    logger.warn(`No feishuClient or plugin outbound to send SubtaskDiscovered notification`)
                  }
                })
                .catch((err) => {
                  logger.warn(`SubtaskDiscovered handling failed: ${err}`)
                })
              break
            }

            case "QuestionAsked": {
              if (seenInteractiveIds.has(action.requestId)) break
              seenInteractiveIds.add(action.requestId)
              logger.info(`Question event received in bridge for session ${sessionId}, requestId=${action.requestId}`)
              const questionCard = channelId === "telegram"
                ? buildTelegramQuestionCard(action)
                : buildQuestionCard(action)
              sendInteractiveCard(questionCard).catch((err) => {
                logger.warn(`Question card send failed: ${err}`)
              })
              break
            }

            case "PermissionRequested": {
              if (seenInteractiveIds.has(action.requestId)) break
              seenInteractiveIds.add(action.requestId)
              logger.info(`Permission event received in bridge for session ${sessionId}, requestId=${action.requestId}`)
              const permissionCard = channelId === "telegram"
                ? buildTelegramPermissionCard(action)
                : buildPermissionCard(action)
              sendInteractiveCard(permissionCard).catch((err) => {
                logger.warn(`Permission card send failed: ${err}`)
              })
              break
            }

            case "SessionIdle": {
              logger.info(`[StreamingBridge] SessionIdle event received: sessionId=${sessionId}, settled=${settled}, textBuffer.length=${textBuffer.length}`)
              if (settled) {
                return
              }
              settled = true
              stopTyping()
              clearTimeout(firstEventTimer)
              removeListener(eventListeners, sessionId, myListener)
              const responseText = textBuffer.trim() || "（无回复）"
              logger.info(`[StreamingBridge] SessionIdle: responseText="${responseText.substring(0, 100)}..."`)
              const closeCard = card
                ? (cardStartPromise ?? Promise.resolve()).then(() => card!.close(responseText))
                : Promise.resolve()
              closeCard
                .then(async () => {
                  try {
                    await sendFinalResponse(responseText, !!card)
                  } catch (err) {
                    logger.warn(`sendFinalResponse failed: ${err}`)
                  }
                  onComplete(responseText)
                  resolve()
                })
                .catch(async (err) => {
                  logger.warn(`card.close() failed: ${err}`)
                  try {
                    await sendFinalResponse(responseText, false)
                  } catch (replyErr) {
                    logger.warn(`sendFinalResponse failed after card.close error: ${replyErr}`)
                  }
                  onComplete(responseText)
                  resolve()
                })
              break
            }

            default:
              break
          }
        }

        const firstEventTimer = setTimeout(async () => {
          if (gotFirstEvent || settled) return
          settled = true
          stopTyping()
          removeListener(eventListeners, sessionId, myListener)
          logger.warn(
            `No SSE events received within ${FIRST_EVENT_TIMEOUT_MS}ms for ${sessionId}, falling back to sync response`,
          )
          const fallbackText = parseSyncResponse(syncResponseBody, logger)
          try {
            if (card) await card.close(fallbackText)
          } catch (err) {
            logger.warn(`card.close() in timeout fallback failed: ${err}`)
          }
          // Send fallback text as reply
          try {
            await sendFinalResponse(fallbackText, !!card || !!streamSession)
          } catch (err) {
            logger.warn(`sendFinalResponse in timeout fallback failed: ${err}`)
          }
          if (deps.outboundMedia) {
            try {
              await deps.outboundMedia.sendDetectedFiles({ address: chatId }, fallbackText, plugin?.outbound)
            } catch (mediaErr) {
              logger.warn(`outboundMedia.sendDetectedFiles in timeout fallback failed: ${mediaErr}`)
            }
          }
          onComplete(fallbackText)
          resolve()
        }, FIRST_EVENT_TIMEOUT_MS)

        // Register event listener BEFORE the POST to avoid race condition
        addListener(eventListeners, sessionId, myListener)


        sendMessage()
          .then((responseBody) => {
            syncResponseBody = responseBody
            logger.info(
              `POST completed for session ${sessionId} (${responseBody.length} bytes)`,
            )
            // prompt_async returns empty body — skip sync fallback, wait for SSE
            if (!responseBody.length) {
              logger.debug(`[StreamingBridge] Empty response body (prompt_async), waiting for SSE events for ${sessionId}`)
              return
            }
            // 如果没有流式事件，直接发送同步响应（仅 WeChat 需要特殊处理以防止重复）
            if (!gotFirstEvent && !textBuffer.length) {
              if (settled) return
              // WeChat 同步响应后需要立即 resolve 并设置 settled 防止 SessionIdle 重复发送
              if (channelId === "wechat") {
                settled = true
                const finalText = parseSyncResponse(responseBody, logger)
                sendFinalResponse(finalText, false)
                  .then(() => {
                    onComplete(finalText)
                    resolve()
                  })
                  .catch((err) => {
                    logger.error(`Failed to send sync response: ${err}`)
                    onComplete(finalText)
                    resolve()
                  })
                return
              }
              // 其他渠道保持原有逻辑
              startTyping()
              const finalText = parseSyncResponse(responseBody, logger)
              sendFinalResponse(finalText, false).catch((err) => {
                logger.error(`Failed to send sync response: ${err}`)
              })
            }
          })
          .catch((err) => {
            if (settled) return
            // If SSE events have been flowing, the POST timeout is expected
            // (e.g. agent blocked on question/permission). Keep the listener alive.
            if (gotFirstEvent) {
              logger.info(`POST timed out for session ${sessionId} but SSE events are flowing — keeping listener active`)
              return
            }
            settled = true
            clearTimeout(firstEventTimer)
            removeListener(eventListeners, sessionId, myListener)
            if (card) card.close().catch(() => { })
            reject(err)
          })
      })
    },
  }
}

// ── Helpers ──

function parseSyncResponse(rawText: string, logger: Logger): string {
  if (!rawText.trim()) return "（无回复）"
  try {
    const data = JSON.parse(rawText) as {
      parts?: Array<{ type: string; text?: string }>
    }
    return (
      data.parts
        ?.filter((p) => p.type === "text" && p.text)
        .map((p) => p.text ?? "")
        .join("\n")
        .trim() || "（无回复）"
    )
  } catch (e) {
    logger.warn(`Failed to parse sync response: ${e}`)
    return rawText.trim() || "（无回复）"
  }
}

function buildSubAgentNotificationCard(
  description: string,
  agent: string,
  childSessionId: string,
): Record<string, unknown> {
  return {
    schema: "2.0",
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: `🤖 ${agent}` },
      template: "indigo",
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content: description,
        },
        {
          tag: "actions",
          actions: [
            {
              tag: "button",
              text: { tag: "plain_text", content: "🔍 View Details" },
              type: "primary",
              value: { action: "view_subagent", childSessionId },
            },
          ],
        },
      ],
    },
  }
}


export function buildQuestionCard(
  action: QuestionAsked,
): Record<string, unknown> {
  const elements: Record<string, unknown>[] = []

  // Render each question (support multi-question requests)
  for (let qi = 0; qi < action.questions.length; qi++) {
    const question = action.questions[qi]!
    if (qi > 0) {
      elements.push({ tag: "hr" })
    }
    elements.push({
      tag: "markdown",
      content: question.question,
    })
    elements.push({
      tag: "button",
      text: { tag: "plain_text", content: question.options[0]?.label ?? "Yes" },
      type: "primary",
      value: {
        action: "question_answer",
        requestId: action.requestId,
        answers: JSON.stringify([[question.options[0]?.label]]),
      },
    })
    // Add other options if any, for simplicity in V2 just append them
    for (let i = 1; i < question.options.length; i++) {
      const opt = question.options[i]!
      elements.push({
        tag: "button",
        text: { tag: "plain_text", content: opt.label },
        type: "default",
        value: {
          action: "question_answer",
          requestId: action.requestId,
          answers: JSON.stringify([[opt.label]]),
        },
      })
    }
  }

  const header = action.questions[0]?.header ?? "Question"

  return {
    schema: "2.0",
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: `❓ ${header}` },
      template: "orange",
    },
    body: {
      elements,
    },
  }
}

export function buildPermissionCard(
  action: PermissionRequested,
): Record<string, unknown> {
  return {
    schema: "2.0",
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: `🔐 Permission: ${action.permissionType}` },
      template: "yellow",
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content: action.title,
        },
        {
          tag: "button",
          text: { tag: "plain_text", content: "✅ Allow Once" },
          type: "primary",
          value: { action: "permission_reply", requestId: action.requestId, reply: "once" },
        },
        {
          tag: "button",
          text: { tag: "plain_text", content: "✅ Always Allow" },
          type: "default",
          value: { action: "permission_reply", requestId: action.requestId, reply: "always" },
        },
        {
          tag: "button",
          text: { tag: "plain_text", content: "❌ Reject" },
          type: "danger",
          value: { action: "permission_reply", requestId: action.requestId, reply: "reject" },
        },
      ],
    },
  }
}

export function buildTelegramQuestionCard(
  action: QuestionAsked,
): Record<string, unknown> {
  const question = action.questions[0]
  const text = question
    ? `${question.header}\n${question.question}`
    : "Question"

  const rows = (question?.options ?? []).slice(0, 3).map((option) => [{
    text: option.label,
    payload: {
      action: "qa" as const,
      requestId: action.requestId,
      answers: [[option.label]],
    },
  }])

  return ((createTelegramInlineCard(text, rows) ?? {
    text,
    reply_markup: { inline_keyboard: [] },
  }) as unknown) as Record<string, unknown>
}

export function buildTelegramPermissionCard(
  action: PermissionRequested,
): Record<string, unknown> {
  return ((createTelegramInlineCard(
    `Permission: ${action.permissionType}\n${action.title}`,
    [[
      { text: "Allow Once", payload: { action: "pr" as const, requestId: action.requestId, reply: "once" } },
      { text: "Always Allow", payload: { action: "pr" as const, requestId: action.requestId, reply: "always" } },
      { text: "Reject", payload: { action: "pr" as const, requestId: action.requestId, reply: "reject" } },
    ]],
  ) ?? {
    text: action.title,
    reply_markup: { inline_keyboard: [] },
  }) as unknown) as Record<string, unknown>
}
