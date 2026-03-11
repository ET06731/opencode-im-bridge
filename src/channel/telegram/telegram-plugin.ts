/**
 * TelegramPlugin — channel adapter for Telegram Bot API.
 *
 * Uses long polling (getUpdates) to receive messages and routes them
 * through the standard ChannelPlugin pipeline.
 */

import { BaseChannelPlugin } from "../base-plugin.js"
import type {
    ChannelId,
    ChannelMeta,
    ChannelConfigAdapter,
    ChannelGatewayAdapter,
    ChannelMessagingAdapter,
    ChannelOutboundAdapter,
    ChannelStreamingAdapter,
    ChannelThreadingAdapter,
    NormalizedMessage,
    OutboundMessage,
    OutboundTarget,
    StreamTarget,
    StreamingSession,
    ThreadKey,
} from "../types.js"
import type { AppConfig, TelegramConfig } from "../../utils/config.js"
import type { Logger } from "../../utils/logger.js"

// ── Telegram API Types ──

interface TelegramUpdate {
    update_id: number
    message?: {
        message_id: number
        chat: { id: number; first_name?: string; title?: string; username?: string }
        from?: { id: number; first_name: string; username?: string }
        text?: string
        date: number
    }
}

/** Telegram API 消息长度上限 */
const TELEGRAM_MAX_MESSAGE_LENGTH = 4096

const TELEGRAM_API_BASE = "https://api.telegram.org"

// ── Dependencies ──

export interface TelegramPluginDeps {
    appConfig: AppConfig
    logger: Logger
    onMessage?: (event: any) => Promise<void>
}

// ── Plugin ──

export class TelegramPlugin extends BaseChannelPlugin {
    override id = "telegram" as ChannelId
    override meta: ChannelMeta = {
        id: "telegram" as ChannelId,
        label: "Telegram",
        description: "Telegram Bot 桥接集成",
    }

    private readonly appConfig: AppConfig
    private readonly telegramConfig: TelegramConfig
    private readonly logger: Logger

    /** 长轮询中止控制器 */
    private abortController: AbortController | null = null

    // ── Adapters ──

    override config: ChannelConfigAdapter
    override gateway: ChannelGatewayAdapter
    override messaging: ChannelMessagingAdapter
    override outbound: ChannelOutboundAdapter
    override streaming: ChannelStreamingAdapter
    override threading: ChannelThreadingAdapter

    private readonly _threadMap = new Map<ThreadKey, string>()

    constructor(deps: TelegramPluginDeps) {
        super()
        this.appConfig = deps.appConfig
        this.logger = deps.logger

        if (!this.appConfig.telegram) {
            throw new Error("Telegram config is missing but TelegramPlugin was instantiated")
        }
        this.telegramConfig = this.appConfig.telegram

        // 1. Config adapter
        this.config = {
            listAccountIds: () => ["default"],
            resolveAccount: (_id: string) => this.telegramConfig,
        }

        // 2. Gateway adapter — 长轮询
        this.gateway = {
            startAccount: async (_accountId: string, signal: AbortSignal): Promise<void> => {
                this.abortController = new AbortController()

                // 将外部 signal 传递给内部 abort controller
                signal.addEventListener("abort", () => {
                    this.abortController?.abort()
                })

                // 在后台启动长轮询（不 await）
                this.startPolling(deps.onMessage).catch((err) => {
                    this.logger.error(`[TelegramPlugin] Poll loop crashed: ${err}`)
                })

                this.logger.info("[TelegramPlugin] Gateway started (long polling)")
            },

            stopAccount: async (_accountId: string): Promise<void> => {
                this.abortController?.abort()
                this.abortController = null
                this.logger.info("[TelegramPlugin] Gateway stopped")
            },
        }

        // 3. Messaging adapter
        this.messaging = {
            normalizeInbound: (raw: unknown): NormalizedMessage => {
                const update = raw as TelegramUpdate
                const m = update.message!
                const chatId = String(m.chat.id)
                const senderId = m.from ? String(m.from.id) : chatId
                const senderName = m.from?.username ?? m.from?.first_name

                return {
                    messageId: String(m.message_id),
                    senderId,
                    senderName,
                    text: m.text ?? "",
                    chatId,
                    timestamp: m.date * 1000,
                }
            },

            formatOutbound: (msg: OutboundMessage): unknown => {
                return msg.text
            },
        }

        // 4. Outbound adapter — 调用 Telegram sendMessage，超长自动切分
        this.outbound = {
            sendText: async (target: OutboundTarget, text: string): Promise<void> => {
                const chunks = splitMessage(text, TELEGRAM_MAX_MESSAGE_LENGTH)
                for (const chunk of chunks) {
                    await this.callApi("sendMessage", {
                        chat_id: target.address,
                        text: chunk,
                    })
                }
            },
        }

        // 5. Streaming adapter — flush 为 no-op，最终内容通过 sendText 发送
        this.streaming = {
            createStreamingSession: (target: StreamTarget): StreamingSession => {
                const sessionId = `telegram_stream_${Date.now()}`
                return {
                    sessionId,
                    target,
                    pendingUpdates: [],
                    createdAt: Date.now(),
                    flush: async () => {
                        // no-op: Telegram 不支持卡片流式更新，等待 SessionIdle 后整体发送
                    },
                }
            },
        }

        // 6. Threading adapter
        this.threading = {
            resolveThread: (inbound: NormalizedMessage): ThreadKey => {
                // Telegram 以 chat_id 为会话单元（私聊/群组各自独立）
                return inbound.chatId as ThreadKey
            },
            mapSession: (threadKey: ThreadKey, sessionId: string): void => {
                this._threadMap.set(threadKey, sessionId)
            },
            getSession: (threadKey: ThreadKey): string | null => {
                return this._threadMap.get(threadKey) ?? null
            },
        }
    }

    // ── Private ──

    /**
     * 调用 Telegram Bot API。
     */
    private async callApi(method: string, params: Record<string, unknown>): Promise<unknown> {
        const token = this.telegramConfig.botToken
        const url = `${TELEGRAM_API_BASE}/bot${token}/${method}`
        const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(params),
        })
        const data = (await res.json()) as { ok: boolean; description?: string }
        if (!data.ok) {
            throw new Error(`Telegram API error (${method}): ${data.description ?? "unknown"}`)
        }
        return data
    }

    /**
     * 长轮询主循环。
     * 使用 AbortController 支持优雅关闭。
     */
    private async startPolling(onMessage?: (event: unknown) => Promise<void>): Promise<void> {
        let offset = 0
        this.logger.info("[TelegramPlugin] Long polling started")

        while (this.abortController && !this.abortController.signal.aborted) {
            try {
                const token = this.telegramConfig.botToken
                const url = `${TELEGRAM_API_BASE}/bot${token}/getUpdates`

                const res = await fetch(url, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        offset,
                        timeout: 30,
                        allowed_updates: ["message"],
                    }),
                    signal: this.abortController.signal,
                })

                const data = (await res.json()) as { ok: boolean; result: TelegramUpdate[] }
                if (!data.ok || !Array.isArray(data.result)) {
                    this.logger.warn("[TelegramPlugin] getUpdates returned non-ok response")
                    continue
                }

                for (const update of data.result) {
                    // 推进 offset，告知 Telegram 下次跳过已处理的 update
                    if (update.update_id >= offset) {
                        offset = update.update_id + 1
                    }

                    if (!update.message?.text) {
                        // 忽略无文本的 update（贴纸、图片等）
                        continue
                    }

                    const chatId = String(update.message.chat.id)

                    // 访问控制：若 allowedChatIds 非空，则仅处理白名单中的 chat
                    if (
                        this.telegramConfig.allowedChatIds.length > 0 &&
                        !this.telegramConfig.allowedChatIds.includes(chatId)
                    ) {
                        this.logger.warn(`[TelegramPlugin] Blocked message from unauthorized chatId: ${chatId}`)
                        continue
                    }

                    this.logger.info(`[TelegramPlugin] Received message from chatId=${chatId}`)

                    if (onMessage) {
                        try {
                            // 包装为与 Feishu‑compatible syntheticEvent（handleMessage 依赖此结构）
                            const syntheticEvent = {
                                event_id: String(update.update_id),
                                event_type: "message",
                                chat_id: chatId,
                                chat_type: "p2p" as const,
                                message_id: String(update.message!.message_id),
                                sender: {
                                    sender_id: { open_id: String(update.message!.from?.id ?? chatId) },
                                    sender_type: "user",
                                    tenant_key: "telegram",
                                },
                                message: {
                                    message_type: "text",
                                    content: JSON.stringify({ text: update.message!.text }),
                                },
                                _channelId: "telegram",
                            }
                            await onMessage(syntheticEvent)
                        } catch (err) {
                            this.logger.error(`[TelegramPlugin] onMessage handler error: ${err}`)
                        }
                    }
                }
            } catch (err) {
                if (
                    err instanceof Error &&
                    (err.name === "AbortError" || err.message.includes("aborted"))
                ) {
                    break
                }
                this.logger.warn(`[TelegramPlugin] Polling error: ${err}. Retrying in 5s...`)
                await sleep(5000)
            }
        }

        this.logger.info("[TelegramPlugin] Long polling stopped")
    }
}

// ── Helpers ──

/** 将消息切分为不超过 maxLen 字符的分段 */
function splitMessage(text: string, maxLen: number): string[] {
    if (text.length <= maxLen) return [text]

    const chunks: string[] = []
    let pos = 0
    while (pos < text.length) {
        chunks.push(text.slice(pos, pos + maxLen))
        pos += maxLen
    }
    return chunks
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}
