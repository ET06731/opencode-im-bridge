/**
 * DingTalk Stream mode client.
 * Establishes a persistent WebSocket connection to receive messages via DingTalk's Stream API.
 */

import WebSocket from "ws"
import { createLogger } from "../../utils/logger.js"
import type { DingTalkCallbackEvent } from "./types.js"

const logger = createLogger("dingtalk-stream")

interface StreamClientOptions {
  clientId: string
  clientSecret: string
  agentId?: string
  onMessage: (event: DingTalkCallbackEvent) => void
  onError?: (err: Error) => void
}

interface GatewayResponse {
  errcode?: number
  errmsg?: string
  endpoint?: string
  ticket?: string
}

interface DownStreamMessage {
  specVersion: string
  type: "SYSTEM" | "EVENT" | "CALLBACK"
  headers: {
    appId: string
    connectionId: string
    contentType: string
    messageId: string
    time: string
    topic: string
    eventType?: string
    eventBornTime?: string
    eventId?: string
    eventCorpId?: string
    eventUnifiedAppId?: string
  }
  data: string
}

const RECONNECT_DELAY_MS = 3000
const MAX_RECONNECT_DELAY_MS = 60000

export class DingTalkStreamClient {
  private readonly options: StreamClientOptions
  private aborted = false
  private reconnectDelay = RECONNECT_DELAY_MS
  private socket: WebSocket | null = null
  private reconnectAttempts = 0

  constructor(options: StreamClientOptions) {
    this.options = options
  }

  async start(): Promise<void> {
    this.aborted = false
    await this.connect()
  }

  stop(): void {
    this.aborted = true
    if (this.socket) {
      this.socket.terminate()
      this.socket = null
    }
    logger.info("[DingTalkStreamClient] Client stopped")
  }

  private async connect(): Promise<void> {
    while (!this.aborted) {
      try {
        logger.info("[DingTalkStreamClient] Connecting to DingTalk stream gateway...")

        const { endpoint, ticket } = await this.registerStream()

        if (!endpoint || !ticket) {
          throw new Error("Failed to get stream endpoint or ticket")
        }

        const wsUrl = `${endpoint}?ticket=${ticket}`
        logger.info(`[DingTalkStreamClient] WebSocket URL obtained, connecting...`)

        await this.establishConnection(wsUrl)

        this.reconnectDelay = RECONNECT_DELAY_MS
        this.reconnectAttempts = 0
      } catch (err) {
        if (this.aborted) {
          logger.info("[DingTalkStreamClient] Aborting reconnection")
          break
        }

        const error = err instanceof Error ? err : new Error(String(err))
        logger.error(`[DingTalkStreamClient] Stream error: ${error.message}`)

        this.options.onError?.(error)

        this.reconnectAttempts++
        const delay = Math.min(
          this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1) + Math.random() * 1000,
          MAX_RECONNECT_DELAY_MS
        )

        logger.info(`[DingTalkStreamClient] Reconnecting in ${delay}ms... (attempt ${this.reconnectAttempts})`)
        await new Promise((r) => setTimeout(r, delay))
      }
    }

    logger.info("[DingTalkStreamClient] Connection loop ended")
  }

  private async registerStream(): Promise<{ endpoint: string; ticket: string }> {
    const topic = this.options.agentId
      ? `/cloud/robot/${this.options.agentId}`
      : "/cloud/robot"

    const response = await fetch("https://api.dingtalk.com/v1.0/gateway/connections/open", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        clientId: this.options.clientId,
        clientSecret: this.options.clientSecret,
        subscriptions: [
          {
            type: "EVENT",
            topic,
          },
          {
            type: "CALLBACK",
            topic: "*",
          },
        ],
      }),
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`Failed to register stream: ${response.status} - ${text}`)
    }

    const data = await response.json() as GatewayResponse

    if (data.errcode && data.errcode !== 0) {
      throw new Error(`Register stream error: ${data.errcode} - ${data.errmsg}`)
    }

    if (!data.endpoint || !data.ticket) {
      throw new Error(`Invalid response: missing endpoint or ticket`)
    }

    logger.info(`[DingTalkStreamClient] Stream registered, endpoint: ${data.endpoint}`)
    return { endpoint: data.endpoint, ticket: data.ticket }
  }

  private async establishConnection(wsUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = new WebSocket(wsUrl)

      const socket = this.socket

      socket.on("open", () => {
        logger.info("[DingTalkStreamClient] WebSocket connected")
        resolve()
      })

      socket.on("message", (data: WebSocket.RawData) => {
        try {
          const message = JSON.parse(data.toString()) as DownStreamMessage
          this.handleMessage(message)
        } catch (err) {
          logger.warn(`[DingTalkStreamClient] Failed to parse message: ${err}`)
        }
      })

      socket.on("close", () => {
        logger.info("[DingTalkStreamClient] WebSocket closed")
        if (!this.aborted) {
          logger.info("[DingTalkStreamClient] Will attempt to reconnect...")
        }
      })

      socket.on("error", (err) => {
        logger.error(`[DingTalkStreamClient] WebSocket error: ${err.message}`)
        if (socket.readyState === WebSocket.CONNECTING) {
          reject(err)
        }
      })
    })
  }

  private handleMessage(message: DownStreamMessage): void {
    switch (message.type) {
      case "SYSTEM":
        this.handleSystemMessage(message)
        break
      case "EVENT":
        this.handleEventMessage(message)
        break
      case "CALLBACK":
        this.handleCallbackMessage(message)
        break
    }
  }

  private handleSystemMessage(message: DownStreamMessage): void {
    switch (message.headers.topic) {
      case "CONNECTED":
        logger.info("[DingTalkStreamClient] System: Connected")
        break
      case "REGISTERED":
        logger.info("[DingTalkStreamClient] System: Registered")
        break
      case "KEEPALIVE":
        logger.debug("[DingTalkStreamClient] System: Keepalive received")
        break
      case "ping":
        logger.debug("[DingTalkStreamClient] System: Ping received, responding...")
        this.sendMessage({
          code: 200,
          headers: message.headers,
          message: "OK",
        })
        break
      default:
        logger.debug(`[DingTalkStreamClient] System message: ${message.headers.topic}`)
    }
  }

  private handleEventMessage(message: DownStreamMessage): void {
    logger.info(`[DingTalkStreamClient] Received event: ${message.headers.eventType || message.headers.topic}`)

    try {
      const eventData = JSON.parse(message.data) as DingTalkCallbackEvent
      this.options.onMessage(eventData)

      this.sendMessage({
        code: 200,
        headers: {
          contentType: "application/json",
          messageId: message.headers.messageId,
        },
        message: "OK",
      })
    } catch (err) {
      logger.warn(`[DingTalkStreamClient] Failed to handle event: ${err}`)
    }
  }

  private handleCallbackMessage(message: DownStreamMessage): void {
    logger.info(`[DingTalkStreamClient] Received callback: ${message.headers.topic}`)

    try {
      const eventData = JSON.parse(message.data) as DingTalkCallbackEvent
      this.options.onMessage(eventData)
    } catch (err) {
      logger.warn(`[DingTalkStreamClient] Failed to handle callback: ${err}`)
    }
  }

  private sendMessage(data: unknown): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(data))
    }
  }
}
