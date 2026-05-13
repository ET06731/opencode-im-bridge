import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AppConfig } from "../../utils/config.js"
import { createMockLogger } from "../../__tests__/setup.js"

vi.mock("qq-official-bot", () => {
  const { EventEmitter } = require("node:events")
  const instances: any[] = []

  class MockBot extends EventEmitter {
    config: any
    receiver: any
    sessionManager: any
    messageService: any
    fileProcessor: any
    request: any
    start: ReturnType<typeof vi.fn>
    stop: ReturnType<typeof vi.fn>

    constructor(config: any) {
      super()
      this.config = config
      this.receiver = {
        retryCount: 0,
        isReconnect: false,
        connect: vi.fn(async () => undefined),
        authenticate: vi.fn(async () => undefined),
        resumeConnection: vi.fn(async () => undefined),
        handleInvalidSession: vi.fn(() => {
          this.sessionManager.sessionRecord = { sessionID: "", seq: 0 }
          this.receiver.isReconnect = false
        }),
        handleHello: vi.fn(async () => {
          if (this.receiver.isReconnect) {
            await this.receiver.resumeConnection()
            return
          }
          await this.receiver.authenticate()
        }),
        handleReadyEvent: vi.fn(() => undefined),
        handleResumedEvent: vi.fn(() => undefined),
        reconnect: vi.fn(async () => undefined),
      }

      this.sessionManager = {
        receiver: this.receiver,
        sessionRecord: {
          sessionID: "",
          seq: 0,
        },
      }

      this.messageService = {
        sendPrivateMessage: vi.fn().mockResolvedValue({ ok: true }),
      }

      this.fileProcessor = {
        uploadMedia: vi.fn().mockResolvedValue({ file_info: "file-info" }),
      }

      this.request = {
        post: vi.fn().mockResolvedValue({ ok: true }),
      }

      this.start = vi.fn(async () => undefined)
      this.stop = vi.fn(async () => undefined)
      instances.push(this)
    }
  }

  return {
    Bot: MockBot,
    ReceiverMode: {
      WEBSOCKET: "websocket",
    },
    segment: {
      markdown: (text: string) => ({ type: "markdown", text }),
      text: (text: string) => ({ type: "text", text }),
    },
    __qqMockState: {
      botInstances: instances,
    },
  }
})

import { QQPlugin } from "./qq-plugin.js"
import { __qqMockState } from "qq-official-bot"

const botInstances = (__qqMockState as { botInstances: any[] }).botInstances

function makeConfig(): AppConfig {
  return {
    qq: {
      appId: "1903646071",
      secret: "secret",
      sandbox: false,
    },
    defaultAgent: "sisyphus",
    dataDir: "./data",
    messageDebounceMs: 500,
  }
}

function makePlugin() {
  return new QQPlugin({
    appConfig: makeConfig(),
    logger: createMockLogger(),
    onMessage: vi.fn().mockResolvedValue(undefined),
  })
}

describe("QQPlugin", () => {
  beforeEach(() => {
    botInstances.length = 0
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  it("starts and stops the managed bot through the gateway adapter", async () => {
    const plugin = makePlugin()
    const controller = new AbortController()

    await plugin.gateway.startAccount("default", controller.signal)

    expect(botInstances).toHaveLength(1)
    expect(botInstances[0].start).toHaveBeenCalledTimes(1)

    await plugin.gateway.stopAccount!("default")

    expect(botInstances[0].stop).toHaveBeenCalledTimes(1)
  })

  it("normalizes inbound QQ messages", () => {
    const plugin = makePlugin()

    const normalized = plugin.messaging.normalizeInbound({
      message_id: "msg-1",
      user_id: "user-1",
      raw_message: "hello",
      timestamp: "2026-03-31T01:45:00.000Z",
    })

    expect(normalized).toMatchObject({
      messageId: "msg-1",
      senderId: "user-1",
      text: "hello",
      chatId: "user-1",
      threadId: "user-1",
    })
  })

  it("sends outbound text through the active bot instance", async () => {
    const plugin = makePlugin()
    const controller = new AbortController()
    await plugin.gateway.startAccount("default", controller.signal)

    await plugin.outbound.sendText({ address: "user-1" }, "hello")

    expect(botInstances[0].messageService.sendPrivateMessage).toHaveBeenCalledWith(
      "user-1",
      [{ type: "markdown", text: "hello" }],
    )
  })

  it("uses RESUME on HELLO when a recoverable session exists", async () => {
    const plugin = makePlugin()
    const controller = new AbortController()
    await plugin.gateway.startAccount("default", controller.signal)

    const bot = botInstances[0]
    bot.sessionManager.sessionRecord = {
      sessionID: "session-1",
      seq: 42,
    }

    await bot.receiver.handleHello({})

    expect(bot.receiver.resumeConnection).toHaveBeenCalledTimes(1)
    expect(bot.receiver.authenticate).not.toHaveBeenCalled()
  })

  it("forces fresh IDENTIFY after INVALID_SESSION instead of RESUME", async () => {
    const plugin = makePlugin()
    const controller = new AbortController()
    await plugin.gateway.startAccount("default", controller.signal)

    const bot = botInstances[0]
    bot.sessionManager.sessionRecord = {
      sessionID: "session-1",
      seq: 42,
    }

    bot.receiver.handleInvalidSession()
    await bot.receiver.handleHello({})

    expect(bot.receiver.authenticate).toHaveBeenCalledTimes(1)
    expect(bot.receiver.resumeConnection).not.toHaveBeenCalled()
  })

  it("resets the invalid-session counter only after READY", async () => {
    const plugin = makePlugin()
    const logger = plugin["logger"] as ReturnType<typeof createMockLogger>
    const controller = new AbortController()
    await plugin.gateway.startAccount("default", controller.signal)

    const bot = botInstances[0]

    bot.receiver.handleInvalidSession()
    bot.receiver.handleInvalidSession()
    bot.receiver.handleReadyEvent({})
    bot.receiver.handleInvalidSession()

    const invalidLogs = (logger.warn as any).mock.calls
      .map((call: unknown[]) => String(call[0]))
      .filter((message: string) => message.includes("Invalid session detected"))

    expect(invalidLogs).toEqual([
      "[QQPlugin] Invalid session detected (1/3); forcing fresh IDENTIFY",
      "[QQPlugin] Invalid session detected (2/3); forcing fresh IDENTIFY",
      "[QQPlugin] Invalid session detected (1/3); forcing fresh IDENTIFY",
    ])
  })

  it("deduplicates concurrent reconnect attempts", async () => {
    vi.useFakeTimers()

    const plugin = makePlugin()
    const controller = new AbortController()
    await plugin.gateway.startAccount("default", controller.signal)

    const bot = botInstances[0]

    const reconnectA = bot.receiver.reconnect()
    const reconnectB = bot.receiver.reconnect()

    await vi.advanceTimersByTimeAsync(2000)
    await Promise.all([reconnectA, reconnectB])

    expect(bot.receiver.connect).toHaveBeenCalledTimes(1)
  })

  it("rebuilds the bot after repeated invalid sessions", async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, "random").mockReturnValue(0)

    const plugin = makePlugin()
    const controller = new AbortController()
    await plugin.gateway.startAccount("default", controller.signal)

    const firstBot = botInstances[0]

    firstBot.receiver.handleInvalidSession()
    firstBot.receiver.handleInvalidSession()
    firstBot.receiver.handleInvalidSession()

    const reconnectPromise = firstBot.receiver.reconnect()

    await vi.advanceTimersByTimeAsync(1000)
    await reconnectPromise

    expect(firstBot.stop).toHaveBeenCalledTimes(1)
    expect(botInstances).toHaveLength(2)
    expect(botInstances[1].start).toHaveBeenCalledTimes(1)
  })

  it("rebuilds the bot when supervised connect fails", async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, "random").mockReturnValue(0)

    const plugin = makePlugin()
    const controller = new AbortController()
    await plugin.gateway.startAccount("default", controller.signal)

    const firstBot = botInstances[0]
    firstBot.receiver.connect.mockRejectedValueOnce(new Error("connect failed"))

    const reconnectPromise = firstBot.receiver.reconnect()

    await vi.advanceTimersByTimeAsync(3000)
    await reconnectPromise

    expect(firstBot.stop).toHaveBeenCalledTimes(1)
    expect(botInstances).toHaveLength(2)
    expect(botInstances[1].start).toHaveBeenCalledTimes(1)
  })
})
