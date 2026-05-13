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
import type { AppConfig } from "../../utils/config.js"
import type { Logger } from "../../utils/logger.js"
import { Bot, ReceiverMode, segment } from "qq-official-bot"
import { parseQQMediaMessage } from "./qq-api-client.js"

export interface QQPluginDeps {
    appConfig: AppConfig
    logger: Logger
    onMessage?: (event: any) => Promise<void>
}

export class QQPlugin extends BaseChannelPlugin {
    override id = "qq" as ChannelId
    override meta: ChannelMeta = {
        id: "qq" as ChannelId,
        label: "QQ",
        description: "QQ official bot channel integration",
    }

    private readonly appConfig: AppConfig
    private readonly logger: Logger
    private qqBot!: Bot

    override config: ChannelConfigAdapter
    override gateway: ChannelGatewayAdapter
    override messaging: ChannelMessagingAdapter
    override outbound: ChannelOutboundAdapter
    override streaming: ChannelStreamingAdapter
    override threading: ChannelThreadingAdapter

    private readonly _qqThreadMap = new Map<ThreadKey, string>()

    constructor(deps: QQPluginDeps) {
        super()
        this.appConfig = deps.appConfig
        this.logger = deps.logger

        if (!this.appConfig.qq) {
            throw new Error("QQ config is missing but QQPlugin was instantiated")
        }

        this.qqBot = new Bot({
            appid: this.appConfig.qq.appId,
            secret: this.appConfig.qq.secret,
            sandbox: this.appConfig.qq.sandbox,
            removeAt: true,
            logLevel: "info",
            timeout: 60000,
            // Connection manager retry (Session/Connection)
            maxRetry: 10,
            // WebSocket receiver retry/backoff settings
            maxRetries: 10,
            reconnectDelay: 1000,
            heartbeatInterval: 45000,
            intents: [
                "C2C_MESSAGE_CREATE", // Private messages
            ],
            mode: ReceiverMode.WEBSOCKET,
        })

        // Hotfix: after INVALID_SESSION, force a fresh IDENTIFY instead of RESUME
        // and do a full bot restart after repeated failures.
        {
            const receiver = (this.qqBot as any).receiver ?? (this.qqBot as any).sessionManager?.receiver
            if (receiver && typeof receiver.handleInvalidSession === "function" && typeof receiver.handleHello === "function") {
                const logger = this.logger
                const state = receiver as any
                const bot = this.qqBot
                let consecutiveInvalidSessions = 0
                const MAX_CONSECUTIVE_INVALID = 3

                const originalInvalid = state.handleInvalidSession.bind(receiver)
                const originalHello = state.handleHello.bind(receiver)

                state.handleInvalidSession = (...args: any[]) => {
                    consecutiveInvalidSessions++
                    logger.warn(`[QQPlugin] Invalid session detected (${consecutiveInvalidSessions}/${MAX_CONSECUTIVE_INVALID})`)
                    if (typeof state.isReconnect === "boolean") {
                        state.isReconnect = false
                    }
                    if (consecutiveInvalidSessions >= MAX_CONSECUTIVE_INVALID) {
                        logger.warn("[QQPlugin] Too many invalid sessions, forcing full bot restart...")
                        consecutiveInvalidSessions = 0
                        bot.stop().catch(() => {})
                        setTimeout(() => {
                            bot.start().catch(err => logger.error(`[QQPlugin] Failed to restart bot: ${err}`))
                        }, 1000)
                    }
                    return originalInvalid(...args)
                }

                state.handleHello = (...args: any[]) => {
                    if (consecutiveInvalidSessions > 0) {
                        logger.info("[QQPlugin] HELLO received, resetting invalid session counter")
                        consecutiveInvalidSessions = 0
                    }
                    if (typeof state.isReconnect === "boolean" && !state.isReconnect) {
                        state.isReconnect = false
                    }
                    return originalHello(...args)
                }

                this.logger.info("[QQPlugin] Installed WebSocket invalid-session hotfix")
            } else {
                this.logger.warn("[QQPlugin] Unable to install WebSocket hotfix (receiver methods not found)")
            }
        }

        // 1. Config adapter
        this.config = {
            listAccountIds: () => ["default"],
            resolveAccount: (_id: string) => this.appConfig,
        }

        // 2. Gateway adapter
        this.gateway = {
            startAccount: async (_accountId: string, signal: AbortSignal): Promise<void> => {
                this.qqBot.on("message.private", async (event) => {
                    this.logger.info(`QQ Gateway received message from ${event.user_id}`)
                    if (deps.onMessage) {
                        const messageArray = Array.isArray(event.message) ? event.message : []
                        const mediaItems = parseQQMediaMessage(messageArray)
                        const hasMedia = mediaItems.length > 0

                        let messageType = "text"
                        let content: string

                        if (hasMedia && mediaItems[0]) {
                            const firstMedia = mediaItems[0]
                            messageType = firstMedia.type === "image" ? "image" : "file"
                            content = JSON.stringify({
                                media: mediaItems,
                                text: (event as any).raw_message || (event as any).content || "",
                            })
                        } else {
                            content = JSON.stringify({ text: (event as any).raw_message || (event as any).content || "" })
                        }

                        const syntheticEvent: any = {
                            event_id: event.id || event.message_id,
                            event_type: "message",
                            chat_id: event.user_id,
                            chat_type: "p2p",
                            message_id: event.id || event.message_id,
                            sender: {
                                sender_id: { open_id: event.user_id },
                                sender_type: "user",
                                tenant_key: "qq",
                            },
                            message: {
                                message_type: messageType,
                                content: content,
                            },
                            _channelId: "qq",
                            _rawMessage: messageArray,
                        }

                        const qqEvent = event as any
                        if (qqEvent.message_reference?.message_id) {
                            syntheticEvent.parent_id = qqEvent.message_reference.message_id
                        }
                        await deps.onMessage(syntheticEvent as any)
                    }
                })

                await this.qqBot.start()

                signal.addEventListener("abort", () => {
                    this.qqBot.stop().catch(err => this.logger.warn(`Failed to stop QQ bot: ${err}`))
                })
            },
            stopAccount: async (_accountId: string): Promise<void> => {
                await this.qqBot.stop()
            }
        }

        // 3. Messaging adapter
        this.messaging = {
            normalizeInbound: (raw: any): NormalizedMessage => {
                // Since we pass syntheticEvent from Gateway
                const ev = raw

                return {
                    messageId: ev.id || ev.message_id,
                    senderId: ev.user_id,
                    text: ev.raw_message || ev.content || "",
                    chatId: ev.user_id, // For C2C, chat ID is the user ID
                    threadId: ev.user_id, // C2C thread is the user
                    timestamp: ev.timestamp ? new Date(ev.timestamp).getTime() : Date.now(),
                }
            },

            formatOutbound: (msg: OutboundMessage): unknown => {
                return msg.text
            },
        }

        // 4. Outbound adapter
        this.outbound = {
            sendText: async (target: OutboundTarget, text: string): Promise<void> => {
                this.logger.info(`[QQPlugin] Attempting to send message to ${target.address}`)
                try {
                    const res = await this.qqBot.messageService.sendPrivateMessage(target.address, [segment.markdown(text)])
                    this.logger.info(`[QQPlugin] Message sent successfully. Response: ${JSON.stringify(res)}`)
                } catch (err) {
                    this.logger.error(`[QQPlugin] Failed to send message to ${target.address}: ${err}`)
                    throw err
                }
            },

            sendImage: async (target: OutboundTarget, filePath: string): Promise<void> => {
                this.logger.info(`[QQPlugin] Attempting to send image to ${target.address}: ${filePath}`)
                try {
                    const uploadResult = await this.qqBot.fileProcessor.uploadMedia(filePath, {
                        targetId: target.address,
                        targetType: 'user',
                        fileType: 1,
                        sendMessage: true,
                    })
                    this.logger.info(`[QQPlugin] Image upload+send result: ${JSON.stringify(uploadResult)}`)
                } catch (err) {
                    this.logger.error(`[QQPlugin] Failed to send image to ${target.address}: ${err}`)
                    throw err
                }
            },

            sendFile: async (target: OutboundTarget, filePath: string): Promise<void> => {
                this.logger.info(`[QQPlugin] Attempting to send file to ${target.address}: ${filePath}`)
                try {
                    const ext = filePath.toLowerCase().split('.').pop() || ''
                    const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp']
                    const audioExts = ['mp3', 'wav', 'ogg', 'aac', 'm4a', 'silk']
                    const videoExts = ['mp4', 'avi', 'mov', 'mkv', 'flv', 'wmv']
                    const docExts = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md', 'csv', 'zip', 'rar', '7z', 'tar', 'gz']

                    if (imageExts.includes(ext)) {
                        await this.qqBot.fileProcessor.uploadMedia(filePath, {
                            targetId: target.address,
                            targetType: 'user',
                            fileType: 1,
                            sendMessage: true,
                        })
                        this.logger.info(`[QQPlugin] Image file sent.`)
                        return
                    } else if (audioExts.includes(ext)) {
                        const uploadResult = await this.qqBot.fileProcessor.uploadMedia(filePath, {
                            targetId: target.address,
                            targetType: 'user',
                            fileType: 3,
                            sendMessage: false,
                        })
                        const fileInfo = (uploadResult as any).file_info
                        if (fileInfo) {
                            await this.qqBot.request.post(`/v2/users/${target.address}/messages`, {
                                msg_type: 7,
                                content: " ",
                                media: { file_info: fileInfo },
                                msg_seq: Math.floor(Math.random() * 1000000),
                            })
                            this.logger.info(`[QQPlugin] Audio sent via two-step.`)
                            return
                        }
                        this.logger.warn(`[QQPlugin] Audio upload succeeded but no file_info, falling back to text`)
                    } else if (videoExts.includes(ext)) {
                        const uploadResult = await this.qqBot.fileProcessor.uploadMedia(filePath, {
                            targetId: target.address,
                            targetType: 'user',
                            fileType: 2,
                            sendMessage: false,
                        })
                        const fileInfo = (uploadResult as any).file_info
                        if (fileInfo) {
                            await this.qqBot.request.post(`/v2/users/${target.address}/messages`, {
                                msg_type: 7,
                                content: " ",
                                media: { file_info: fileInfo },
                                msg_seq: Math.floor(Math.random() * 1000000),
                            })
                            this.logger.info(`[QQPlugin] Video sent via two-step.`)
                            return
                        }
                        this.logger.warn(`[QQPlugin] Video upload succeeded but no file_info, falling back to text`)
                    } else if (docExts.includes(ext)) {
                        const fileName = filePath.split(/[\\/]/).pop() || filePath
                        const uploadResult = await this.qqBot.fileProcessor.uploadMedia(filePath, {
                            targetId: target.address,
                            targetType: 'user',
                            fileType: 4 as 1 | 2 | 3,
                            sendMessage: false,
                        })
                        const fileInfo = (uploadResult as any).file_info
                        if (fileInfo) {
                            await this.qqBot.request.post(`/v2/users/${target.address}/messages`, {
                                msg_type: 7,
                                content: " ",
                                media: { file_info: fileInfo },
                                msg_seq: Math.floor(Math.random() * 1000000),
                            })
                            await this.qqBot.messageService.sendPrivateMessage(
                                target.address,
                                [segment.text(`📎 原始文件名: ${fileName}`)],
                            )
                            this.logger.info(`[QQPlugin] Document sent with filename hint.`)
                            return
                        }
                        this.logger.warn(`[QQPlugin] Document upload succeeded but no file_info, falling back to text`)
                    }
                    const fileName = filePath.split(/[\\/]/).pop() || filePath
                    const res = await this.qqBot.messageService.sendPrivateMessage(
                        target.address,
                        [segment.text(`📎 文件已保存: ${fileName}\n路径: ${filePath}`)],
                    )
                    this.logger.info(`[QQPlugin] File info sent as text. Response: ${JSON.stringify(res)}`)
                    return
                } catch (err) {
                    this.logger.error(`[QQPlugin] Failed to send file to ${target.address}: ${err}`)
                    const fileName = filePath.split(/[\\/]/).pop() || filePath
                    await this.qqBot.messageService.sendPrivateMessage(
                        target.address,
                        [segment.text(`📎 文件已保存: ${fileName}\n路径: ${filePath}`)],
                    )
                }
            },

            sendAudio: async (target: OutboundTarget, filePath: string): Promise<void> => {
                this.logger.info(`[QQPlugin] Attempting to send audio to ${target.address}: ${filePath}`)
                try {
                    const uploadResult = await this.qqBot.fileProcessor.uploadMedia(filePath, {
                        targetId: target.address,
                        targetType: 'user',
                        fileType: 3,
                        sendMessage: false,
                    })
                    const fileInfo = (uploadResult as any).file_info
                    if (!fileInfo) {
                        throw new Error(`Audio upload succeeded but no file_info: ${JSON.stringify(uploadResult)}`)
                    }
                    await this.qqBot.request.post(`/v2/users/${target.address}/messages`, {
                        msg_type: 7,
                        content: " ",
                        media: { file_info: fileInfo },
                        msg_seq: Math.floor(Math.random() * 1000000),
                    })
                    this.logger.info(`[QQPlugin] Audio sent successfully.`)
                } catch (err) {
                    this.logger.error(`[QQPlugin] Failed to send audio to ${target.address}: ${err}`)
                    const fileName = filePath.split(/[\\/]/).pop() || filePath
                    await this.qqBot.messageService.sendPrivateMessage(
                        target.address,
                        [segment.text(`📎 音频已保存: ${fileName}\n路径: ${filePath}`)],
                    )
                }
            },

            sendVideo: async (target: OutboundTarget, filePath: string): Promise<void> => {
                this.logger.info(`[QQPlugin] Attempting to send video to ${target.address}: ${filePath}`)
                try {
                    const uploadResult = await this.qqBot.fileProcessor.uploadMedia(filePath, {
                        targetId: target.address,
                        targetType: 'user',
                        fileType: 2,
                        sendMessage: false,
                    })
                    const fileInfo = (uploadResult as any).file_info
                    if (!fileInfo) {
                        throw new Error(`Video upload succeeded but no file_info: ${JSON.stringify(uploadResult)}`)
                    }
                    await this.qqBot.request.post(`/v2/users/${target.address}/messages`, {
                        msg_type: 7,
                        content: " ",
                        media: { file_info: fileInfo },
                        msg_seq: Math.floor(Math.random() * 1000000),
                    })
                    this.logger.info(`[QQPlugin] Video sent successfully.`)
                } catch (err) {
                    this.logger.error(`[QQPlugin] Failed to send video to ${target.address}: ${err}`)
                    const fileName = filePath.split(/[\\/]/).pop() || filePath
                    await this.qqBot.messageService.sendPrivateMessage(
                        target.address,
                        [segment.text(`📎 视频已保存: ${fileName}\n路径: ${filePath}`)],
                    )
                }
            },
        }

        // 5. Streaming adapter
        this.streaming = {
            createStreamingSession: (target: StreamTarget): StreamingSession => {
                const sessionId = `qq_stream_${Date.now()}`
                let buffer = ""

                const session: StreamingSession = {
                    sessionId,
                    target,
                    pendingUpdates: [],
                    createdAt: Date.now(),
                    flush: async () => {
                        // For QQ, we don't stream edit cards like Feishu, 
                        // We can just accumulate text and send it out or do nothing and wait for SessionIdle.
                        // Typically we don't want to spam C2C messages for every streamed delta.
                        // We will rely on Final/Idle state emitting normal sendText calls,
                        // so streaming flush can be a no-op here.
                    },
                }
                return session
            },
        }

        // 6. Threading adapter
        this.threading = {
            resolveThread: (inbound: NormalizedMessage): ThreadKey => {
                return inbound.chatId as ThreadKey
            },
            mapSession: (threadKey: ThreadKey, sessionId: string): void => {
                this._qqThreadMap.set(threadKey, sessionId)
            },
            getSession: (threadKey: ThreadKey): string | null => {
                return this._qqThreadMap.get(threadKey) ?? null
            },
        }
    }
}
