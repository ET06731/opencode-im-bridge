import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import type { EventListenerMap } from "../utils/event-listeners.js"
import { createMessageHandler, type HandlerDeps } from "./message-handler.js"
import { EventProcessor } from "../streaming/event-processor.js"
import { createMockLogger, createMockFeishuClient, waitFor } from "../__tests__/setup.js"

const advanceTimers = async (ms: number) => {
  if (typeof vi.advanceTimersByTimeAsync === "function") {
    await vi.advanceTimersByTimeAsync(ms)
  } else {
    vi.advanceTimersByTime(ms)
    await new Promise(r => setImmediate(r))
  }
}

import type { FeishuMessageEvent } from "../types.js"
import { FileTooLargeError } from "../feishu/api-client.js"

function makeEvent(overrides: Partial<FeishuMessageEvent> = {}): FeishuMessageEvent {
  return {
    event_id: "evt-1",
    event_type: "im.message.receive_v1",
    chat_id: "chat-1",
    chat_type: "p2p",
    message_id: "msg-1",
    sender: {
      sender_id: { open_id: "ou-1" },
      sender_type: "user",
      tenant_key: "tk-1",
    },
    message: {
      message_type: "text",
      content: JSON.stringify({ text: "Hello" }),
    },
    ...overrides,
  }
}

function makeDeps(overrides: Partial<HandlerDeps> = {}): HandlerDeps {
  const ownedSessions = new Set<string>()
  const eventListeners: EventListenerMap = new Map()

  return {
    serverUrl: "http://127.0.0.1:4096",
    sessionManager: {
      getOrCreate: vi.fn().mockResolvedValue("ses-1"),
      getExisting: vi.fn().mockResolvedValue(undefined),
      getSession: vi.fn().mockReturnValue(null),
      deleteMapping: vi.fn().mockReturnValue(true),
      setMapping: vi.fn().mockReturnValue(true),
      cleanup: vi.fn().mockReturnValue(0),
      validateAndCleanupStale: vi.fn().mockResolvedValue(0),
    },
    dedup: {
      isDuplicate: vi.fn().mockReturnValue(false),
      close: vi.fn(),
    } as any,
    eventProcessor: new EventProcessor({ ownedSessions }),
    feishuClient: createMockFeishuClient(),
    progressTracker: {
      sendThinking: vi.fn().mockResolvedValue("thinking-msg-1"),
      updateWithResponse: vi.fn().mockResolvedValue(undefined),
      updateWithError: vi.fn().mockResolvedValue(undefined),
    },
    eventListeners,
    ownedSessions,
    logger: createMockLogger(),
    ...overrides,
  }
}

function mockFetchOk(body = ""): void {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    text: () => Promise.resolve(body),
  }) as any
}

function mockFetchError(status = 500): void {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: false,
    status,
    text: () => Promise.resolve(""),
  }) as any
}

describe("createMessageHandler", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("skips duplicate events", async () => {
    const deps = makeDeps({
      dedup: { isDuplicate: vi.fn().mockReturnValue(true), close: vi.fn() } as any,
    })
    const { handleMessage: handler } = createMessageHandler(deps)

    await handler(makeEvent())

    expect(deps.sessionManager.getOrCreate).not.toHaveBeenCalled()
  })

  it("skips unsupported message types with clear log", async () => {
    const deps = makeDeps()
    const { handleMessage: handler } = createMessageHandler(deps)

    await handler(
      makeEvent({ message: { message_type: "audio", content: "" } }),
    )

    expect(deps.sessionManager.getOrCreate).not.toHaveBeenCalled()
    expect(deps.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("Unsupported message type: audio"),
    )
  })

  it("handles post message type — extracts text from rich content", async () => {
    mockFetchOk("")
    const deps = makeDeps()
    const { handleMessage: handler } = createMessageHandler(deps)

    const postContent = JSON.stringify({
      zh_cn: {
        title: "Post Title",
        content: [
          [
            { tag: "text", text: "Line 1 text" },
            { tag: "a", href: "https://example.com", text: "link" },
          ],
          [
            { tag: "text", text: "Line 2" },
          ],
        ],
      },
    })

    const handlerPromise = handler(
      makeEvent({ message: { message_type: "post", content: postContent } }),
    )

    await waitFor(() => {
      expect(deps.eventListeners.size).toBe(1)
    })

    ;[...deps.eventListeners.get("ses-1")!].forEach(fn => fn({
      type: "session.status",
      properties: { sessionID: "ses-1", status: { type: "idle" } },
    }))

    await handlerPromise

    expect(deps.feishuClient.sendMessage).toHaveBeenCalled()
  })

  it("handles post message with multiple paragraphs", async () => {
    mockFetchOk("")
    const deps = makeDeps()
    const { handleMessage: handler } = createMessageHandler(deps)

    const postContent = JSON.stringify({
      en_us: {
        content: [
          [{ tag: "text", text: "Paragraph 1" }],
          [{ tag: "text", text: "Paragraph 2" }],
          [{ tag: "text", text: "Paragraph 3" }],
        ],
      },
    })

    const handlerPromise = handler(
      makeEvent({ message: { message_type: "post", content: postContent } }),
    )

    await waitFor(() => {
      expect(deps.eventListeners.size).toBe(1)
    })

    const listener = [...deps.eventListeners.get("ses-1")!][0]!

    listener({
      type: "session.status",
      properties: { sessionID: "ses-1", status: { type: "idle" } },
    })

    await handlerPromise

    expect(deps.feishuClient.sendMessage).toHaveBeenCalled()
  })

  it("handles post message with empty content gracefully", async () => {
    mockFetchOk("")
    const deps = makeDeps()
    const { handleMessage: handler } = createMessageHandler(deps)

    // Empty post content
    const postContent = JSON.stringify({})

    await handler(
      makeEvent({ message: { message_type: "post", content: postContent } }),
    )

    // Should skip because extracted text is empty
    expect(deps.sessionManager.getOrCreate).not.toHaveBeenCalled()
  })

  it("handles flat post format (WebSocket)", async () => {
    mockFetchOk("")
    const deps = makeDeps()
    const { handleMessage: handler } = createMessageHandler(deps)

    const postContent = JSON.stringify({
      title: "",
      content: [
        [
          { tag: "text", text: "1. ", style: [] },
          { tag: "text", text: "first item" },
        ],
        [
          { tag: "text", text: "2. ", style: [] },
          { tag: "text", text: "second item" },
        ],
      ],
    })

    const handlerPromise = handler(
      makeEvent({ message: { message_type: "post", content: postContent } }),
    )

    await waitFor(() => {
      expect(deps.eventListeners.size).toBe(1)
    })

    ;[...deps.eventListeners.get("ses-1")!].forEach(fn => fn({
      type: "session.status",
      properties: { sessionID: "ses-1", status: { type: "idle" } },
    }))

    await handlerPromise

    // Verify fetch was called with parts containing extracted text
    const fetchCalls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls
    const postCall = fetchCalls.find(
      (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("/message"),
    )
    expect(postCall).toBeDefined()
    const body = JSON.parse((postCall![1] as { body: string }).body)
    expect(body.parts[0].text).toContain("1. first item")
    expect(body.parts[0].text).toContain("2. second item")
  })

  it("skips empty text messages", async () => {
    const deps = makeDeps()
    const { handleMessage: handler } = createMessageHandler(deps)

    await handler(
      makeEvent({ message: { message_type: "text", content: JSON.stringify({ text: "  " }) } }),
    )

    expect(deps.sessionManager.getOrCreate).not.toHaveBeenCalled()
  })

  it("handles POST failure with error card", async () => {
    mockFetchError(500)
    const deps = makeDeps()
    const { handleMessage: handler } = createMessageHandler(deps)

    await handler(makeEvent())

    expect(deps.progressTracker.updateWithError).toHaveBeenCalledWith(
      "thinking-msg-1",
      "处理请求时出错了。",
    )
  })

  it("handles POST failure without thinking card — sends direct message", async () => {
    mockFetchError(500)
    const deps = makeDeps({
      progressTracker: {
        sendThinking: vi.fn().mockResolvedValue(null),
        updateWithResponse: vi.fn().mockResolvedValue(undefined),
        updateWithError: vi.fn().mockResolvedValue(undefined),
      },
    })
    const { handleMessage: handler } = createMessageHandler(deps)

    await handler(makeEvent())

    expect(deps.feishuClient.sendMessage).toHaveBeenCalledWith(
      "chat-1",
      expect.objectContaining({ msg_type: "text" }),
    )
  })

  it("retries message POST after waking the server", async () => {
    let callCount = 0
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      callCount++
      if (callCount === 1) {
        throw new Error("connect ECONNREFUSED 127.0.0.1:4096")
      }
      return {
        ok: true,
        text: () => Promise.resolve(""),
      }
    }) as any

    const serviceLauncher = {
      ensureServerReady: vi.fn().mockResolvedValue({ healthy: true, started: true }),
      probeServer: vi.fn(),
    }
    const deps = makeDeps({ serviceLauncher })
    const { handleMessage: handler } = createMessageHandler(deps)

    const handlerPromise = handler(makeEvent())

    await waitFor(() => {
      expect(deps.eventListeners.size).toBe(1)
    })

    ;[...deps.eventListeners.get("ses-1")!].forEach(fn => fn({
      type: "session.status",
      properties: { sessionID: "ses-1", status: { type: "idle" } },
    }))

    await handlerPromise

    expect(serviceLauncher.ensureServerReady).toHaveBeenCalledWith("incoming message")
    expect(globalThis.fetch).toHaveBeenCalledTimes(2)
  })

  it("event-driven flow: collects TextDelta and responds on SessionIdle", async () => {
    mockFetchOk("")
    const deps = makeDeps()
    const { handleMessage: handler } = createMessageHandler(deps)

    const handlerPromise = handler(makeEvent())


    await waitFor(() => {
      expect(deps.eventListeners.size).toBe(1)
    })

    const listener = [...deps.eventListeners.get("ses-1")!][0]!

    listener({
      type: "message.part.updated",
      properties: {
        part: { sessionID: "ses-1", messageID: "msg-1", type: "text", text: "Hello" },
        delta: "Hello ",
      },
    })

    listener({
      type: "message.part.updated",
      properties: {
        part: { sessionID: "ses-1", messageID: "msg-1", type: "text", text: "Hello World" },
        delta: "World",
      },
    })

    listener({
      type: "session.status",
      properties: { sessionID: "ses-1", status: { type: "idle" } },
    })

    await handlerPromise

    expect(deps.progressTracker.updateWithResponse).toHaveBeenCalledWith(
      "thinking-msg-1",
      "Hello World",
    )
  })

  it("event-driven flow: removes listener after SessionIdle", async () => {
    mockFetchOk("")
    const deps = makeDeps()
    const { handleMessage: handler } = createMessageHandler(deps)

    const handlerPromise = handler(makeEvent())

    await waitFor(() => {
      expect(deps.eventListeners.size).toBe(1)
    })

    const listener = [...deps.eventListeners.get("ses-1")!][0]!

    listener({
      type: "session.status",
      properties: { sessionID: "ses-1", status: { type: "idle" } },
    })

    await handlerPromise

    expect(deps.eventListeners.size).toBe(0)
  })

  it("event-driven flow: responds with default text when no TextDelta received", async () => {
    mockFetchOk("")
    const deps = makeDeps()
    const { handleMessage: handler } = createMessageHandler(deps)

    const handlerPromise = handler(makeEvent())

    await waitFor(() => {
      expect(deps.eventListeners.size).toBe(1)
    })

    ;[...deps.eventListeners.get("ses-1")!].forEach(fn => fn({
      type: "session.status",
      properties: { sessionID: "ses-1", status: { type: "idle" } },
    }))

    await handlerPromise

    expect(deps.progressTracker.updateWithResponse).toHaveBeenCalledWith(
      "thinking-msg-1",
      "（无回复）",
    )
  })

  it("falls back to sync mode on event-driven timeout", async () => {
    vi.useFakeTimers()

    const syncBody = JSON.stringify({
      parts: [{ type: "text", text: "Sync response" }],
    })
    mockFetchOk(syncBody)
    const deps = makeDeps()
    const { handleMessage: handler } = createMessageHandler(deps)

    const handlerPromise = handler(makeEvent())

    // Advance microtasks under fake timers (waitFor uses setTimeout which is frozen)
    for (let i = 0; i < 20; i++) await advanceTimers(0)
    expect(deps.eventListeners.size).toBe(1)

    vi.advanceTimersByTime(5 * 60 * 1000 + 100)

    await handlerPromise

    expect(deps.progressTracker.updateWithResponse).toHaveBeenCalledWith(
      "thinking-msg-1",
      "Sync response",
    )
    expect(deps.eventListeners.size).toBe(0)

  })

  it("sync fallback handles empty response body", async () => {
    vi.useFakeTimers()

    mockFetchOk("   ")
    const deps = makeDeps()
    const { handleMessage: handler } = createMessageHandler(deps)

    const handlerPromise = handler(makeEvent())

    // Advance microtasks under fake timers (waitFor uses setTimeout which is frozen)
    for (let i = 0; i < 20; i++) await advanceTimers(0)
    expect(deps.eventListeners.size).toBe(1)

    vi.advanceTimersByTime(5 * 60 * 1000 + 100)

    await handlerPromise

    expect(deps.progressTracker.updateWithError).toHaveBeenCalledWith(
      "thinking-msg-1",
      "服务器返回了空响应。",
    )

  })

  it("adds sessionId to ownedSessions", async () => {
    mockFetchOk("")
    const deps = makeDeps()
    const { handleMessage: handler } = createMessageHandler(deps)

    const handlerPromise = handler(makeEvent())

    await waitFor(() => {
      expect(deps.ownedSessions.has("ses-1")).toBe(true)
    })

    ;[...deps.eventListeners.get("ses-1")!].forEach(fn => fn({
      type: "session.status",
      properties: { sessionID: "ses-1", status: { type: "idle" } },
    }))

    await handlerPromise
  })

  it("group chat replies to message instead of sending to chat", async () => {
    mockFetchOk("")
    const deps = makeDeps({
      botOpenId: "bot-1",
      progressTracker: {
        sendThinking: vi.fn().mockResolvedValue(null),
        updateWithResponse: vi.fn().mockResolvedValue(undefined),
        updateWithError: vi.fn().mockResolvedValue(undefined),
      },
    })
    const { handleMessage: handler } = createMessageHandler(deps)

    const handlerPromise = handler(
      makeEvent({
        chat_type: "group",
        message_id: "group-msg-1",
        mentions: [{ id: { open_id: "bot-1" } }],
      }),
    )

    await waitFor(() => {
      expect(deps.eventListeners.size).toBe(1)
    })

    ;[...deps.eventListeners.get("ses-1")!].forEach(fn => fn({
      type: "message.part.updated",
      properties: {
        part: { sessionID: "ses-1", messageID: "m-1", type: "text", text: "Reply" },
        delta: "Reply",
      },
    }))

    ;[...deps.eventListeners.get("ses-1")!].forEach(fn => fn({
      type: "session.status",
      properties: { sessionID: "ses-1", status: { type: "idle" } },
    }))

    await handlerPromise

    expect(deps.feishuClient.replyMessage).toHaveBeenCalledWith(
      "group-msg-1",
      expect.objectContaining({ msg_type: "text" }),
    )
  })


  it("sends bind notification on first message for a feishuKey", async () => {
    mockFetchOk("")
    const deps = makeDeps()
    const { handleMessage: handler } = createMessageHandler(deps)

    const handlerPromise = handler(makeEvent())

    await waitFor(() => {
      expect(deps.eventListeners.size).toBe(1)
    })

    ;[...deps.eventListeners.get("ses-1")!].forEach(fn => fn({
      type: "session.status",
      properties: { sessionID: "ses-1", status: { type: "idle" } },
    }))

    await handlerPromise

    // Bind notification was sent
    expect(deps.feishuClient.sendMessage).toHaveBeenCalledWith(
      "chat-1",
      expect.objectContaining({
        msg_type: "text",
        content: expect.stringContaining("\u5df2\u8fde\u63a5 session: ses-1"),
      }),
    )
  })

  it("does not send bind notification on second message for same feishuKey", async () => {
    mockFetchOk("")
    const deps = makeDeps()
    const { handleMessage: handler } = createMessageHandler(deps)

    // First message
    const p1 = handler(makeEvent({ event_id: "evt-1" }))
    await waitFor(() => { expect(deps.eventListeners.size).toBe(1) })
    ;[...deps.eventListeners.get("ses-1")!].forEach(fn => fn({
      type: "session.status",
      properties: { sessionID: "ses-1", status: { type: "idle" } },
    }))
    await p1

    const sendCallCount = (deps.feishuClient.sendMessage as any).mock.calls.length

    // Second message (different event_id)
    const p2 = handler(makeEvent({ event_id: "evt-2" }))
    await waitFor(() => { expect(deps.eventListeners.size).toBe(1) })
    ;[...deps.eventListeners.get("ses-1")!].forEach(fn => fn({
      type: "session.status",
      properties: { sessionID: "ses-1", status: { type: "idle" } },
    }))
    await p2

    // Bind notification should only have been sent once (from first message)
    const bindCalls = (deps.feishuClient.sendMessage as any).mock.calls.filter(
      (c: any[]) => JSON.parse(c[1].content).text?.includes("\u5df2\u8fde\u63a5 session:"),
    )
    expect(bindCalls).toHaveLength(1)
  })

  it("calls observer.observe() with correct args after session resolution", async () => {
    mockFetchOk("")
    const observer = {
      observe: vi.fn(),
      markOwned: vi.fn(),
      markSessionBusy: vi.fn(),
      markSessionFree: vi.fn(),
      getChatForSession: vi.fn(),
      stop: vi.fn(),
    }
    const deps = makeDeps({ observer })
    const { handleMessage: handler } = createMessageHandler(deps)

    const handlerPromise = handler(makeEvent())

    await waitFor(() => {
      expect(deps.eventListeners.size).toBe(1)
    })

    ;[...deps.eventListeners.get("ses-1")!].forEach(fn => fn({
      type: "session.status",
      properties: { sessionID: "ses-1", status: { type: "idle" } },
    }))

    await handlerPromise

    expect(observer.observe).toHaveBeenCalledWith("ses-1", "chat-1")
  })

  it("calls observer.markOwned() with messageId from events in event-driven path", async () => {
    mockFetchOk("")
    const observer = {
      observe: vi.fn(),
      markOwned: vi.fn(),
      markSessionBusy: vi.fn(),
      markSessionFree: vi.fn(),
      getChatForSession: vi.fn(),
      stop: vi.fn(),
    }
    const deps = makeDeps({ observer })
    const { handleMessage: handler } = createMessageHandler(deps)

    const handlerPromise = handler(makeEvent())

    await waitFor(() => {
      expect(deps.eventListeners.size).toBe(1)
    })

    // Dispatch event with messageID
    ;[...deps.eventListeners.get("ses-1")!].forEach(fn => fn({
      type: "message.part.updated",
      properties: {
        part: { sessionID: "ses-1", messageID: "oc-msg-42", type: "text", text: "Hello" },
        delta: "Hello",
      },
    }))

    ;[...deps.eventListeners.get("ses-1")!].forEach(fn => fn({
      type: "session.status",
      properties: { sessionID: "ses-1", status: { type: "idle" } },
    }))

    await handlerPromise

    expect(observer.markOwned).toHaveBeenCalledWith("oc-msg-42")
  })

  it("works without observer (backward compatible)", async () => {
    mockFetchOk("")
    const deps = makeDeps() // No observer
    const { handleMessage: handler } = createMessageHandler(deps)

    const handlerPromise = handler(makeEvent())

    await waitFor(() => {
      expect(deps.eventListeners.size).toBe(1)
    })

    ;[...deps.eventListeners.get("ses-1")!].forEach(fn => fn({
      type: "session.status",
      properties: { sessionID: "ses-1", status: { type: "idle" } },
    }))

    await handlerPromise

    // Should complete without errors
    expect(deps.progressTracker.updateWithResponse).toHaveBeenCalled()
  })

  it("calls observer.markSessionBusy/Free when streaming bridge is used", async () => {
    mockFetchOk("")
    const observer = {
      observe: vi.fn(),
      markOwned: vi.fn(),
      markSessionBusy: vi.fn(),
      markSessionFree: vi.fn(),
      getChatForSession: vi.fn(),
      stop: vi.fn(),
    }

    // Create a minimal streaming bridge that resolves immediately
    const streamingBridge = {
      handleMessage: vi.fn().mockImplementation(
        async (_chatId: string, _sessionId: string, _el: EventListenerMap, _ep: unknown, _send: () => Promise<string>, onComplete: (text: string) => void) => {
          onComplete("done")
        },
      ),
    }

    const feishuClient = createMockFeishuClient()
    ;(feishuClient.addReaction as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: 0, msg: "ok", data: { reaction_id: "r-1" },
    })

    const deps = makeDeps({ observer, streamingBridge, feishuClient })
    const { handleMessage: handler } = createMessageHandler(deps)

    await handler(makeEvent())

    expect(observer.markSessionBusy).toHaveBeenCalledWith("ses-1")
    expect(observer.markSessionFree).toHaveBeenCalledWith("ses-1")
  })

  it("includes quoted message context when parent_id is present", async () => {
    mockFetchOk("")
    const feishuClient = createMockFeishuClient()
    ;(feishuClient.getMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: 0,
      msg: "ok",
      data: {
        items: [{
          msg_type: "text",
          body: { content: JSON.stringify({ text: "original question" }) },
        }],
      },
    })
    const deps = makeDeps({ feishuClient })
    const { handleMessage: handler } = createMessageHandler(deps)

    const handlerPromise = handler(
      makeEvent({ parent_id: "parent-msg-1" }),
    )

    await waitFor(() => {
      expect(deps.eventListeners.size).toBe(1)
    })

    ;[...deps.eventListeners.get("ses-1")!].forEach(fn => fn({
      type: "session.status",
      properties: { sessionID: "ses-1", status: { type: "idle" } },
    }))

    await handlerPromise

    expect(feishuClient.getMessage).toHaveBeenCalledWith("parent-msg-1")

    // Verify the POST body contains quoted context
    const fetchCalls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls
    const postCall = fetchCalls.find(
      (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("/message"),
    )
    expect(postCall).toBeDefined()
    const body = JSON.parse((postCall![1] as { body: string }).body)
    expect(body.parts[0].text).toContain("> original question")
    expect(body.parts[0].text).toContain("Hello")
  })

  it("uses a Lark signature for Feishu messages", async () => {
    mockFetchOk("")
    const deps = makeDeps({
      channelManager: {
        getChannel: vi.fn().mockReturnValue({
          meta: { label: "Feishu" },
        }),
      },
    })
    const { handleMessage: handler } = createMessageHandler(deps)

    const handlerPromise = handler(makeEvent())

    await waitFor(() => {
      expect(deps.eventListeners.size).toBe(1)
    })

    ;[...deps.eventListeners.get("ses-1")!].forEach(fn => fn({
      type: "session.status",
      properties: { sessionID: "ses-1", status: { type: "idle" } },
    }))

    await handlerPromise

    const fetchCalls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls
    const postCall = fetchCalls.find(
      (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("/message"),
    )
    expect(postCall).toBeDefined()
    const body = JSON.parse((postCall![1] as { body: string }).body)
    expect(body.parts[0].text).toContain("[Lark] Save files ->")
  })

  it("uses a non-Lark signature for telegram messages", async () => {
    mockFetchOk("")
    const deps = makeDeps({
      channelManager: {
        getChannel: vi.fn().mockReturnValue({
          meta: { label: "Telegram" },
        }),
      },
    })
    const { handleMessage: handler } = createMessageHandler(deps)

    const handlerPromise = handler({
      ...makeEvent(),
      _channelId: "telegram",
    } as FeishuMessageEvent)

    await waitFor(() => {
      expect(deps.eventListeners.size).toBe(1)
    })

    ;[...deps.eventListeners.get("ses-1")!].forEach(fn => fn({
      type: "session.status",
      properties: { sessionID: "ses-1", status: { type: "idle" } },
    }))

    await handlerPromise

    const fetchCalls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls
    const postCall = fetchCalls.find(
      (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("/message"),
    )
    expect(postCall).toBeDefined()
    const body = JSON.parse((postCall![1] as { body: string }).body)
    expect(body.parts[0].text).toContain("[Telegram]")
    expect(body.parts[0].text).toContain("/cron")
    expect(body.parts[0].text).not.toContain("[Lark]")
  })

  it("handles getMessage failure gracefully (still sends user message)", async () => {
    mockFetchOk("")
    const feishuClient = createMockFeishuClient()
    ;(feishuClient.getMessage as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("API error"),
    )
    const deps = makeDeps({ feishuClient })
    const { handleMessage: handler } = createMessageHandler(deps)

    const handlerPromise = handler(
      makeEvent({ parent_id: "parent-msg-1" }),
    )

    await waitFor(() => {
      expect(deps.eventListeners.size).toBe(1)
    })

    ;[...deps.eventListeners.get("ses-1")!].forEach(fn => fn({
      type: "session.status",
      properties: { sessionID: "ses-1", status: { type: "idle" } },
    }))

    await handlerPromise

    // Should still have sent the original message without quoted context
    const fetchCalls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls
    const postCall = fetchCalls.find(
      (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("/message"),
    )
    expect(postCall).toBeDefined()
    const body = JSON.parse((postCall![1] as { body: string }).body)
    expect(body.parts[0].text).toContain("Hello")
    expect(body.parts[0].text).not.toContain("> original question")
  })

  it("does not fetch quoted message when parent_id is absent", async () => {
    mockFetchOk("")
    const feishuClient = createMockFeishuClient()
    const deps = makeDeps({ feishuClient })
    const { handleMessage: handler } = createMessageHandler(deps)

    const handlerPromise = handler(makeEvent())

    await waitFor(() => {
      expect(deps.eventListeners.size).toBe(1)
    })

    ;[...deps.eventListeners.get("ses-1")!].forEach(fn => fn({
      type: "session.status",
      properties: { sessionID: "ses-1", status: { type: "idle" } },
    }))

    await handlerPromise

    expect(feishuClient.getMessage).not.toHaveBeenCalled()
  })

  it("handles image message — downloads and forwards as text", async () => {
    mockFetchOk("")
    const feishuClient = createMockFeishuClient()
    ;(feishuClient.downloadResource as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: Buffer.from("fake-png-data"),
      filename: undefined,
    })
    const deps = makeDeps({ feishuClient })
    const { handleMessage: handler } = createMessageHandler(deps)

    const imageContent = JSON.stringify({ image_key: "img_abc123" })
    const handlerPromise = handler(
      makeEvent({ message: { message_type: "image", content: imageContent } }),
    )

    await waitFor(() => {
      expect(deps.eventListeners.size).toBe(1)
    })

    ;[...deps.eventListeners.get("ses-1")!].forEach(fn => fn({
      type: "session.status",
      properties: { sessionID: "ses-1", status: { type: "idle" } },
    }))

    await handlerPromise

    // Verify downloadResource was called with correct args
    expect(feishuClient.downloadResource).toHaveBeenCalledWith("msg-1", "img_abc123", "image")

    // Verify POST to opencode contains the file reference text
    const fetchCalls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls
    const postCall = fetchCalls.find(
      (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("/message"),
    )
    expect(postCall).toBeDefined()
    const body = JSON.parse((postCall![1] as { body: string }).body)
    expect(body.parts[0].text).toContain("User sent an image.")
    expect(body.parts[0].text).toContain("Saved to:")
    expect(body.parts[0].text).toContain("Please look at this image.")
  })

  it("handles file message — downloads and forwards as text", async () => {
    mockFetchOk("")
    const feishuClient = createMockFeishuClient()
    ;(feishuClient.downloadResource as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: Buffer.from("fake-file-data"),
      filename: undefined,
    })
    const deps = makeDeps({ feishuClient })
    const { handleMessage: handler } = createMessageHandler(deps)

    const fileContent = JSON.stringify({ file_key: "file_xyz789", file_name: "report.pdf" })
    const handlerPromise = handler(
      makeEvent({ message: { message_type: "file", content: fileContent } }),
    )

    await waitFor(() => {
      expect(deps.eventListeners.size).toBe(1)
    })

    ;[...deps.eventListeners.get("ses-1")!].forEach(fn => fn({
      type: "session.status",
      properties: { sessionID: "ses-1", status: { type: "idle" } },
    }))

    await handlerPromise

    // Verify downloadResource was called with correct args
    expect(feishuClient.downloadResource).toHaveBeenCalledWith("msg-1", "file_xyz789", "file")

    // Verify POST to opencode contains the file reference text
    const fetchCalls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls
    const postCall = fetchCalls.find(
      (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("/message"),
    )
    expect(postCall).toBeDefined()
    const body = JSON.parse((postCall![1] as { body: string }).body)
    expect(body.parts[0].text).toContain("User sent a file: report.pdf")
    expect(body.parts[0].text).toContain("Saved to:")
    expect(body.parts[0].text).toContain("Please review this file.")
  })

  it("handles file download failure — forwards error to opencode", async () => {
    mockFetchOk("")
    const feishuClient = createMockFeishuClient()
    ;(feishuClient.downloadResource as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Download failed"),
    )
    const deps = makeDeps({ feishuClient })
    const { handleMessage: handler } = createMessageHandler(deps)

    const imageContent = JSON.stringify({ image_key: "img_bad" })
    const handlerPromise = handler(
      makeEvent({ message: { message_type: "image", content: imageContent } }),
    )

    await waitFor(() => {
      expect(deps.eventListeners.size).toBe(1)
    })

    ;[...deps.eventListeners.get("ses-1")!].forEach(fn => fn({
      type: "session.status",
      properties: { sessionID: "ses-1", status: { type: "idle" } },
    }))

    await handlerPromise

    // Error should be logged
    expect(deps.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("Failed to handle image message"),
    )

    // Error message should be forwarded to opencode
    expect(deps.sessionManager.getOrCreate).toHaveBeenCalled()
    const fetchCalls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls
    const postCall = fetchCalls.find(
      (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("/message"),
    )
    expect(postCall).toBeDefined()
    const body = JSON.parse((postCall![1] as { body: string }).body)
    expect(body.parts[0].text).toContain("download failed")
    expect(body.parts[0].text).toContain("Message ID: msg-1")
  })

  it("handles image message with missing image_key — forwards error", async () => {
    mockFetchOk("")
    const deps = makeDeps()
    const { handleMessage: handler } = createMessageHandler(deps)

    const imageContent = JSON.stringify({})
    const handlerPromise = handler(
      makeEvent({ message: { message_type: "image", content: imageContent } }),
    )

    await waitFor(() => {
      expect(deps.eventListeners.size).toBe(1)
    })

    ;[...deps.eventListeners.get("ses-1")!].forEach(fn => fn({
      type: "session.status",
      properties: { sessionID: "ses-1", status: { type: "idle" } },
    }))

    await handlerPromise

    expect(deps.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("Failed to handle image message"),
    )
    // Error forwarded as text to opencode
    expect(deps.sessionManager.getOrCreate).toHaveBeenCalled()
  })

  it("handles FileTooLargeError — sends size limit message to opencode", async () => {
    mockFetchOk("")
    const feishuClient = createMockFeishuClient()
    ;(feishuClient.downloadResource as ReturnType<typeof vi.fn>).mockRejectedValue(
      new FileTooLargeError("big_file.zip", 60 * 1024 * 1024),
    )
    const deps = makeDeps({ feishuClient })
    const { handleMessage: handler } = createMessageHandler(deps)

    const fileContent = JSON.stringify({ file_key: "file_xyz", file_name: "big_file.zip" })
    const handlerPromise = handler(
      makeEvent({ message: { message_type: "file", content: fileContent } }),
    )

    await waitFor(() => {
      expect(deps.eventListeners.size).toBe(1)
    })

    ;[...deps.eventListeners.get("ses-1")!].forEach(fn => fn({
      type: "session.status",
      properties: { sessionID: "ses-1", status: { type: "idle" } },
    }))

    await handlerPromise

    // Should forward specific size-limit message
    const fetchCalls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls
    const postCall = fetchCalls.find(
      (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("/message"),
    )
    expect(postCall).toBeDefined()
    const body = JSON.parse((postCall![1] as { body: string }).body)
    expect(body.parts[0].text).toContain("exceeds the 50MB size limit")
    expect(body.parts[0].text).toContain("big_file.zip")
  })
})

describe("createMessageHandler — debounce race condition", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    mockFetchOk("")
  })

  it("media1 starts init, media2 arrives → must not flush before init completes", async () => {
    // Simulate a slow addReaction call that takes significant time.
    // media2 arrives during that time. The flush must NOT fire before
    // addReaction finishes and context is set.

    let resolveReaction: ((v: unknown) => void) | undefined
    const reactionPromise = new Promise((r) => { resolveReaction = r })

    const feishuClient = createMockFeishuClient()
    ;(feishuClient.addReaction as ReturnType<typeof vi.fn>).mockReturnValue(reactionPromise)

    // Streaming bridge that captures reaction args to verify later
    const capturedArgs: Array<{ reactionMessageId: string, reactionId: string | null }> = []
    const streamingBridge = {
      handleMessage: vi.fn().mockImplementation(
        async (
          _chatId: string, _sessionId: string, _el: EventListenerMap,
          _ep: unknown, _send: () => Promise<string>,
          onComplete: (text: string) => void,
          reactionMessageId: string,
          reactionId: string | null,
        ) => {
          capturedArgs.push({ reactionMessageId, reactionId })
          onComplete("done")
        },
      ),
    }

    // Use a short debounce window with real timers
    const deps = makeDeps({
      feishuClient,
      streamingBridge,
      debounceMs: 100,
    })
    const { handleMessage: handler, dispose } = createMessageHandler(deps)

    // media1 — starts init, addReaction is pending
    const p1 = handler(makeEvent({
      event_id: "evt-img1",
      message_id: "msg-img1",
      message: { message_type: "image", content: JSON.stringify({ image_key: "img1" }) },
    }))

    // Wait a bit for image download + handler to reach addReaction await
    await new Promise(r => setTimeout(r, 50))

    // media2 arrives while addReaction is still pending
    const p2 = handler(makeEvent({
      event_id: "evt-img2",
      message_id: "msg-img2",
      message: { message_type: "image", content: JSON.stringify({ image_key: "img2" }) },
    }))

    // Wait well past the debounce window — flush must NOT fire
    await new Promise(r => setTimeout(r, 200))

    // The streaming bridge should NOT have been called yet —
    // init hasn't resolved so the timer was never started
    expect(streamingBridge.handleMessage).not.toHaveBeenCalled()

    // Now resolve the reaction — init completes, timer starts
    resolveReaction!({ data: { reaction_id: "r-1" } })

    // Wait for:
    //  - handler to resume after reaction resolves (microtasks)
    //  - debounce timer to fire (100ms real time)
    //  - handleBatchFlush to complete (async, involves mocked I/O)
    // Use a generous real-time delay, then poll for completion
    await new Promise(r => setTimeout(r, 300))
    await waitFor(() => {
      expect(streamingBridge.handleMessage).toHaveBeenCalledTimes(1)
    })

    // Verify reaction context was propagated to the streaming bridge
    expect(capturedArgs).toHaveLength(1)
    expect(capturedArgs[0]!.reactionId).toBe("r-1")
    expect(capturedArgs[0]!.reactionMessageId).toBe("msg-img1")

    await p1
    await p2
    dispose()
  })

  it("media + follow-up text → immediate flush, reaction context present", async () => {
    const feishuClient = createMockFeishuClient()
    ;(feishuClient.addReaction as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { reaction_id: "r-42" },
    })

    const capturedArgs: Array<{ reactionMessageId: string, reactionId: string | null }> = []
    const streamingBridge = {
      handleMessage: vi.fn().mockImplementation(
        async (
          _chatId: string, _sessionId: string, _el: EventListenerMap,
          _ep: unknown, _send: () => Promise<string>,
          onComplete: (text: string) => void,
          reactionMessageId: string,
          reactionId: string | null,
        ) => {
          capturedArgs.push({ reactionMessageId, reactionId })
          onComplete("done")
        },
      ),
    }

    const deps = makeDeps({
      feishuClient,
      streamingBridge,
      debounceMs: 100,
    })
    const { handleMessage: handler, dispose } = createMessageHandler(deps)

    // 1. Send image first
    const p1 = handler(makeEvent({
      event_id: "evt-img",
      message_id: "msg-img",
      message: { message_type: "image", content: JSON.stringify({ image_key: "img1" }) },
    }))

    // Wait for the handler to complete init (image download + addReaction + updateContext + resolveInit)
    await p1

    // 2. Send follow-up text — should trigger immediate flush (hasPending check + flush)
    const p2 = handler(makeEvent({
      event_id: "evt-text",
      message_id: "msg-text",
      message: { message_type: "text", content: JSON.stringify({ text: "describe this" }) },
    }))

    // The streaming bridge should be called after flush
    await waitFor(() => {
      expect(streamingBridge.handleMessage).toHaveBeenCalledTimes(1)
    })

    // Verify reaction context was present (not lost due to race)
    expect(capturedArgs).toHaveLength(1)
    expect(capturedArgs[0]!.reactionId).toBe("r-42")
    expect(capturedArgs[0]!.reactionMessageId).toBe("msg-img")

    await p2
    dispose()
  })
})

describe("createMessageHandler — 404 session self-healing", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("recovers from 404 by clearing mapping and retrying with new session", async () => {
    let callCount = 0
    globalThis.fetch = vi.fn().mockImplementation(async (input: string) => {
      if (input.includes("/message")) {
        callCount++
        if (callCount === 1) {
          // First POST — 404 (stale session)
          return { ok: false, status: 404, text: () => Promise.resolve("") }
        }
        // Retry POST — success
        return { ok: true, text: () => Promise.resolve("") }
      }
      return { ok: true, text: () => Promise.resolve("") }
    }) as any

    const sessionManager = {
      getOrCreate: vi.fn()
        .mockResolvedValueOnce("ses-stale")
        .mockResolvedValueOnce("ses-new"),
      getExisting: vi.fn().mockResolvedValue(undefined),
      getSession: vi.fn().mockReturnValue(null),
      deleteMapping: vi.fn().mockReturnValue(true),
      setMapping: vi.fn().mockReturnValue(true),
      cleanup: vi.fn().mockReturnValue(0),
      validateAndCleanupStale: vi.fn().mockResolvedValue(0),
    }
    const deps = makeDeps({ sessionManager })
    const { handleMessage: handler } = createMessageHandler(deps)

    const handlerPromise = handler(makeEvent())

    await waitFor(() => {
      expect(deps.eventListeners.size).toBe(1)
    })

    // Fire SessionIdle to complete the flow
    ;[...deps.eventListeners.entries()].forEach(([, listeners]) => {
      [...listeners].forEach(fn => fn({
        type: "session.status",
        properties: { sessionID: "ses-new", status: { type: "idle" } },
      }))
    })

    await handlerPromise

    // Verify: deleteMapping was called for the stale session
    expect(sessionManager.deleteMapping).toHaveBeenCalledWith("chat-1")
    // Verify: getOrCreate was called twice (initial + recovery)
    expect(sessionManager.getOrCreate).toHaveBeenCalledTimes(2)
    // Verify: 2 POSTs to /message (original + retry)
    const messagePosts = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("/message"),
    )
    expect(messagePosts).toHaveLength(2)
    // Verify: self-healing logged
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("returned 404"),
    )
  })

  it("does not retry more than once on repeated 404s", async () => {
    // Both POSTs return 404 — should fail after one retry
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve(""),
    }) as any

    const sessionManager = {
      getOrCreate: vi.fn()
        .mockResolvedValueOnce("ses-stale")
        .mockResolvedValueOnce("ses-also-stale"),
      getExisting: vi.fn().mockResolvedValue(undefined),
      getSession: vi.fn().mockReturnValue(null),
      deleteMapping: vi.fn().mockReturnValue(true),
      setMapping: vi.fn().mockReturnValue(true),
      cleanup: vi.fn().mockReturnValue(0),
      validateAndCleanupStale: vi.fn().mockResolvedValue(0),
    }
    const deps = makeDeps({ sessionManager })
    const { handleMessage: handler } = createMessageHandler(deps)

    await handler(makeEvent())

    // Should show error after retry failure
    expect(deps.progressTracker.updateWithError).toHaveBeenCalledWith(
      "thinking-msg-1",
      "处理请求时出错了。",
    )
    // Only one retry
    expect(sessionManager.getOrCreate).toHaveBeenCalledTimes(2)
  })

  it("non-404 errors are not treated as session-gone", async () => {
    mockFetchError(500)
    const deps = makeDeps()
    const { handleMessage: handler } = createMessageHandler(deps)

    await handler(makeEvent())

    // Regular error handling — no deleteMapping
    expect(deps.sessionManager.deleteMapping).not.toHaveBeenCalled()
    expect(deps.progressTracker.updateWithError).toHaveBeenCalled()
  })
})

describe("createMessageHandler — streaming 404 session self-healing", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("streaming branch: 404 triggers session switch with new listener on new session", async () => {
    // Setup: first POST returns 404 (stale session), second POST succeeds on new session
    let postCallCount = 0
    globalThis.fetch = vi.fn().mockImplementation(async (input: string) => {
      if (input.includes("/message")) {
        postCallCount++
        if (postCallCount === 1) {
          // First POST — 404 (stale session)
          return { ok: false, status: 404, text: () => Promise.resolve("") }
        }
        // Second POST — success (new session)
        return { ok: true, text: () => Promise.resolve("") }
      }
      return { ok: true, text: () => Promise.resolve("") }
    }) as any

    const sessionManager = {
      getOrCreate: vi.fn()
        .mockResolvedValueOnce("ses-stale")
        .mockResolvedValueOnce("ses-new"),
      getExisting: vi.fn().mockResolvedValue(undefined),
      getSession: vi.fn().mockReturnValue(null),
      deleteMapping: vi.fn().mockReturnValue(true),
      setMapping: vi.fn().mockReturnValue(true),
      cleanup: vi.fn().mockReturnValue(0),
      validateAndCleanupStale: vi.fn().mockResolvedValue(0),
    }

    const observer = {
      observe: vi.fn(),
      markOwned: vi.fn(),
      markSessionBusy: vi.fn(),
      markSessionFree: vi.fn(),
      getChatForSession: vi.fn(),
      stop: vi.fn(),
    }

    // Track which sessionId the streaming bridge was called with
    const bridgeCalls: string[] = []
    const streamingBridge = {
      handleMessage: vi.fn().mockImplementation(
        async (
          _chatId: string, sid: string, _el: EventListenerMap,
          _ep: unknown, sendMessage: () => Promise<string>,
          onComplete: (text: string) => void,
        ) => {
          bridgeCalls.push(sid)
          // Call sendMessage to trigger the POST (which may throw SessionGoneError)
          await sendMessage()
          onComplete("done")
        },
      ),
    }

    const feishuClient = createMockFeishuClient()
    ;(feishuClient.addReaction as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: 0, msg: "ok", data: { reaction_id: "r-1" },
    })

    const deps = makeDeps({ sessionManager, observer, streamingBridge, feishuClient })
    const { handleMessage: handler } = createMessageHandler(deps)

    await handler(makeEvent())

    // Verify: old session was cleaned up
    expect(sessionManager.deleteMapping).toHaveBeenCalledWith("chat-1")
    // Verify: getOrCreate called twice (initial + recovery)
    expect(sessionManager.getOrCreate).toHaveBeenCalledTimes(2)
    // Verify: streaming bridge called twice — first with stale, then with new
    expect(bridgeCalls).toEqual(["ses-stale", "ses-new"])
    // Verify: old session listener was cleaned (markSessionBusy/Free paired)
    expect(observer.markSessionBusy).toHaveBeenCalledWith("ses-stale")
    expect(observer.markSessionFree).toHaveBeenCalledWith("ses-stale")
    // Verify: new session got busy/free
    expect(observer.markSessionBusy).toHaveBeenCalledWith("ses-new")
  })

  it("streaming branch: does not retry more than once on repeated 404s", async () => {
    // Both POSTs return 404
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve(""),
    }) as any

    const sessionManager = {
      getOrCreate: vi.fn()
        .mockResolvedValueOnce("ses-stale")
        .mockResolvedValueOnce("ses-also-stale"),
      getExisting: vi.fn().mockResolvedValue(undefined),
      getSession: vi.fn().mockReturnValue(null),
      deleteMapping: vi.fn().mockReturnValue(true),
      setMapping: vi.fn().mockReturnValue(true),
      cleanup: vi.fn().mockReturnValue(0),
      validateAndCleanupStale: vi.fn().mockResolvedValue(0),
    }

    const streamingBridge = {
      handleMessage: vi.fn().mockImplementation(
        async (
          _chatId: string, _sid: string, _el: EventListenerMap,
          _ep: unknown, sendMessage: () => Promise<string>,
        ) => {
          await sendMessage() // Always throws SessionGoneError
        },
      ),
    }

    const feishuClient = createMockFeishuClient()
    ;(feishuClient.addReaction as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: 0, msg: "ok", data: { reaction_id: "r-1" },
    })
    ;(feishuClient.deleteReaction as ReturnType<typeof vi.fn>).mockResolvedValue({ code: 0 })

    const deps = makeDeps({ sessionManager, streamingBridge, feishuClient })
    const { handleMessage: handler } = createMessageHandler(deps)

    await handler(makeEvent())

    // Streaming bridge called exactly twice (initial + one retry)
    expect(streamingBridge.handleMessage).toHaveBeenCalledTimes(2)
    // deleteMapping called: once in streaming 404 recovery, potentially again in sync fallback's postWithRecovery
    expect(sessionManager.deleteMapping).toHaveBeenCalled()
    // Reaction should be cleaned up in the sync fallback path
    expect(feishuClient.deleteReaction).toHaveBeenCalled()
  })
})
