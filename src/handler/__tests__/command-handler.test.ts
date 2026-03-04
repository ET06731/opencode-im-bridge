import { describe, it, expect, beforeEach, vi } from "vitest"
import { createCommandHandler } from "../command-handler.js"
import { createMockLogger, createMockFeishuClient } from "../../__tests__/setup.js"
import type { SessionManager } from "../../session/session-manager.js"
import type { SessionMapping } from "../../types.js"

function createMockSessionManager(
  mapping: SessionMapping | null = null,
): SessionManager {
  return {
    getOrCreate: vi.fn().mockResolvedValue(mapping?.session_id ?? "ses-new"),
    getSession: vi.fn().mockReturnValue(mapping),
    getExisting: vi.fn().mockResolvedValue(mapping?.session_id),
    deleteMapping: vi.fn().mockReturnValue(true),
    setMapping: vi.fn().mockReturnValue(true),
    cleanup: vi.fn().mockReturnValue(0),
  }
}

const DEFAULT_MAPPING: SessionMapping = {
  feishu_key: "chat-1",
  session_id: "ses-123",
  agent: "build",
  created_at: Date.now(),
  last_active: Date.now(),
  is_bound: 1,
}

describe("createCommandHandler", () => {
  let mockLogger: ReturnType<typeof createMockLogger>
  let mockFeishuClient: ReturnType<typeof createMockFeishuClient>
  let mockSessionManager: SessionManager
  let mockFetch: ReturnType<typeof vi.fn>

  beforeEach(() => {
    mockLogger = createMockLogger()
    mockFeishuClient = createMockFeishuClient()
    mockSessionManager = createMockSessionManager(DEFAULT_MAPPING)
    mockFetch = vi.fn()
    globalThis.fetch = mockFetch
    vi.clearAllMocks()
  })

  function createHandler(sm?: SessionManager) {
    return createCommandHandler({
      serverUrl: "http://test:4096",
      sessionManager: sm ?? mockSessionManager,
      feishuClient: mockFeishuClient,
      logger: mockLogger,
    })
  }

  describe("/new", () => {
    it("creates a new session and unbinds the mapping", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ id: "ses-new" }),
      })
      mockFeishuClient.replyMessage = vi.fn().mockResolvedValue({ code: 0, msg: "ok" })

      const handler = createHandler()
      const result = await handler("chat-1", "chat-1", "msg-1", "/new")

      expect(result).toBe(true)
      expect(mockFetch).toHaveBeenCalledWith("http://test:4096/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Feishu chat chat-1" }),
      })
      expect(mockSessionManager.deleteMapping).toHaveBeenCalledWith("chat-1")
      expect(mockFeishuClient.replyMessage).toHaveBeenCalledWith("msg-1", {
        msg_type: "text",
        content: JSON.stringify({ text: "已创建新会话: ses-new" }),
      })
    })

    it("replies with error when session creation fails", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500 })
      mockFeishuClient.replyMessage = vi.fn().mockResolvedValue({ code: 0, msg: "ok" })

      const handler = createHandler()
      const result = await handler("chat-1", "chat-1", "msg-1", "/new")

      expect(result).toBe(true)
      expect(mockFeishuClient.replyMessage).toHaveBeenCalledWith("msg-1", {
        msg_type: "text",
        content: expect.stringContaining("命令执行失败"),
      })
    })
  })

  describe("/abort", () => {
    it("aborts the current session", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true })
      mockFeishuClient.replyMessage = vi.fn().mockResolvedValue({ code: 0, msg: "ok" })

      const handler = createHandler()
      const result = await handler("chat-1", "chat-1", "msg-1", "/abort")

      expect(result).toBe(true)
      expect(mockFetch).toHaveBeenCalledWith(
        "http://test:4096/session/ses-123/abort",
        { method: "POST" },
      )
      expect(mockFeishuClient.replyMessage).toHaveBeenCalledWith("msg-1", {
        msg_type: "text",
        content: JSON.stringify({ text: "已中止会话: ses-123" }),
      })
    })

    it("replies when no session is bound", async () => {
      const sm = createMockSessionManager(null)
      mockFeishuClient.replyMessage = vi.fn().mockResolvedValue({ code: 0, msg: "ok" })

      const handler = createHandler(sm)
      const result = await handler("chat-1", "chat-1", "msg-1", "/abort")

      expect(result).toBe(true)
      expect(mockFetch).not.toHaveBeenCalled()
      expect(mockFeishuClient.replyMessage).toHaveBeenCalledWith("msg-1", {
        msg_type: "text",
        content: JSON.stringify({ text: "当前没有绑定的会话。" }),
      })
    })
  })

  describe("/sessions", () => {
    it("sends interactive card with session buttons", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve([
            { id: "ses-1", title: "Chat A" },
            { id: "ses-2" },
          ]),
      })
      mockFeishuClient.replyMessage = vi.fn().mockResolvedValue({ code: 0, msg: "ok" })

      const handler = createHandler()
      const result = await handler("chat-1", "chat-1", "msg-1", "/sessions")

      expect(result).toBe(true)
      expect(mockFetch).toHaveBeenCalledWith("http://test:4096/session")
      expect(mockFeishuClient.replyMessage).toHaveBeenCalledWith("msg-1", {
        msg_type: "interactive",
        content: expect.any(String),
      })
      // Verify card structure
      const callArgs = mockFeishuClient.replyMessage.mock.calls[0]
      const content = JSON.parse(callArgs?.[1]?.content as string)
      expect(content).toHaveProperty("config")
      expect(content).toHaveProperty("header")
      expect(content).toHaveProperty("elements")
      expect(content.header?.title?.content).toContain("选择会话")
      // Verify buttons are created for each session
      const actionElements = content.elements?.filter((e: any) => e.tag === "action")
      // 2 from API + 1 current session (ses-123) not in API list → prepended
      expect(actionElements).toHaveLength(3)
    })

    it("replies with text when no sessions exist", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([]),
      })
      mockFeishuClient.replyMessage = vi.fn().mockResolvedValue({ code: 0, msg: "ok" })

      const handler = createHandler()
      const result = await handler("chat-1", "chat-1", "msg-1", "/sessions")

      expect(result).toBe(true)
      expect(mockFeishuClient.replyMessage).toHaveBeenCalledWith("msg-1", {
        msg_type: "text",
        content: JSON.stringify({ text: "暂无会话。" }),
      })
    })
  })

  describe("/connect", () => {
    it("connects to a valid session", async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: true })
        .mockResolvedValueOnce({ ok: true })
      mockFeishuClient.replyMessage = vi.fn().mockResolvedValue({ code: 0, msg: "ok" })

      const handler = createHandler()
      const result = await handler("chat-1", "chat-1", "msg-1", "/connect ses-456")

      expect(result).toBe(true)
      // First fetch: validate session exists
      expect(mockFetch).toHaveBeenNthCalledWith(1, "http://test:4096/session/ses-456")
      // deleteMapping called
      expect(mockSessionManager.deleteMapping).toHaveBeenCalledWith("chat-1")
      // setMapping called
      expect(mockSessionManager.setMapping).toHaveBeenCalledWith("chat-1", "ses-456")
      expect(mockFeishuClient.replyMessage).toHaveBeenCalledWith("msg-1", {
        msg_type: "text",
        content: JSON.stringify({ text: "已连接到会话: ses-456" }),
      })
    })

    it("replies when session does not exist", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 404 })
      mockFeishuClient.replyMessage = vi.fn().mockResolvedValue({ code: 0, msg: "ok" })

      const handler = createHandler()
      const result = await handler("chat-1", "chat-1", "msg-1", "/connect ses-invalid")

      expect(result).toBe(true)
      expect(mockFeishuClient.replyMessage).toHaveBeenCalledWith("msg-1", {
        msg_type: "text",
        content: JSON.stringify({ text: "会话不存在。" }),
      })
    })

    it("replies with usage when session_id is missing", async () => {
      mockFeishuClient.replyMessage = vi.fn().mockResolvedValue({ code: 0, msg: "ok" })

      const handler = createHandler()
      const result = await handler("chat-1", "chat-1", "msg-1", "/connect")

      expect(result).toBe(true)
      expect(mockFetch).not.toHaveBeenCalled()
      expect(mockFeishuClient.replyMessage).toHaveBeenCalledWith("msg-1", {
        msg_type: "text",
        content: JSON.stringify({ text: "用法: /connect {session_id}" }),
      })
    })
  })

  describe("/compact", () => {
    it("sends session.compact command", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true })
      mockFeishuClient.replyMessage = vi.fn().mockResolvedValue({ code: 0, msg: "ok" })

      const handler = createHandler()
      const result = await handler("chat-1", "chat-1", "msg-1", "/compact")

      expect(result).toBe(true)
      expect(mockFetch).toHaveBeenCalledWith(
        "http://test:4096/session/ses-123/command",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ command: "session.compact", arguments: "" }),
        },
      )
    })

    it("replies when no session is bound", async () => {
      const sm = createMockSessionManager(null)
      mockFeishuClient.replyMessage = vi.fn().mockResolvedValue({ code: 0, msg: "ok" })

      const handler = createHandler(sm)
      const result = await handler("chat-1", "chat-1", "msg-1", "/compact")

      expect(result).toBe(true)
      expect(mockFetch).not.toHaveBeenCalled()
      expect(mockFeishuClient.replyMessage).toHaveBeenCalledWith("msg-1", {
        msg_type: "text",
        content: JSON.stringify({ text: "当前没有绑定的会话。" }),
      })
    })
  })

  describe("/share", () => {
    it("sends session.share command", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true })
      mockFeishuClient.replyMessage = vi.fn().mockResolvedValue({ code: 0, msg: "ok" })

      const handler = createHandler()
      const result = await handler("chat-1", "chat-1", "msg-1", "/share")

      expect(result).toBe(true)
      expect(mockFetch).toHaveBeenCalledWith(
        "http://test:4096/session/ses-123/command",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ command: "session.share", arguments: "" }),
        },
      )
    })
  })

  describe("/help and /", () => {
    it("/help sends interactive card", async () => {
      mockFeishuClient.replyMessage = vi.fn().mockResolvedValue({ code: 0, msg: "ok" })

      const handler = createHandler()
      const result = await handler("chat-1", "chat-1", "msg-1", "/help")

      expect(result).toBe(true)
      expect(mockFeishuClient.replyMessage).toHaveBeenCalledWith("msg-1", {
        msg_type: "interactive",
        content: expect.any(String),
      })
      // Verify the card has full structure: config, header, elements
      const callArgs = mockFeishuClient.replyMessage.mock.calls[0]
      const content = JSON.parse(callArgs?.[1]?.content as string)
      expect(content).toHaveProperty("config")
      expect(content).toHaveProperty("header")
      expect(content).toHaveProperty("elements")
      expect(content.header?.title?.content).toContain("命令菜单")
    })

    it("/ alone sends interactive card", async () => {
      mockFeishuClient.replyMessage = vi.fn().mockResolvedValue({ code: 0, msg: "ok" })

      const handler = createHandler()
      const result = await handler("chat-1", "chat-1", "msg-1", "/")

      expect(result).toBe(true)
      expect(mockFeishuClient.replyMessage).toHaveBeenCalledWith("msg-1", {
        msg_type: "interactive",
        content: expect.any(String),
      })
      // Verify the card has full structure
      const callArgs = mockFeishuClient.replyMessage.mock.calls[0]
      const content = JSON.parse(callArgs?.[1]?.content as string)
      expect(content).toHaveProperty("config")
      expect(content).toHaveProperty("header")
      expect(content).toHaveProperty("elements")
    })
  })

  describe("unknown command", () => {
    it("returns false for unrecognized command", async () => {
      const handler = createHandler()
      const result = await handler("chat-1", "chat-1", "msg-1", "/unknown")

      expect(result).toBe(false)
      expect(mockFetch).not.toHaveBeenCalled()
      expect(mockFeishuClient.replyMessage).not.toHaveBeenCalled()
    })

    it("returns false for non-slash text", async () => {
      const handler = createHandler()
      const result = await handler("chat-1", "chat-1", "msg-1", "hello")

      expect(result).toBe(false)
    })
  })

  describe("error handling", () => {
    it("catches errors and replies with error message", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Network error"))
      mockFeishuClient.replyMessage = vi.fn().mockResolvedValue({ code: 0, msg: "ok" })

      const handler = createHandler()
      const result = await handler("chat-1", "chat-1", "msg-1", "/new")

      expect(result).toBe(true)
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining("/new failed"),
      )
      expect(mockFeishuClient.replyMessage).toHaveBeenCalledWith("msg-1", {
        msg_type: "text",
        content: expect.stringContaining("命令执行失败"),
      })
    })

    it("does not crash when error reply also fails", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Network error"))
      mockFeishuClient.replyMessage = vi.fn().mockRejectedValue(new Error("Reply failed"))

      const handler = createHandler()
      const result = await handler("chat-1", "chat-1", "msg-1", "/new")

      expect(result).toBe(true)
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining("Failed to send error reply"),
      )
    })
  })

  describe("case insensitivity", () => {
    it("handles /NEW as /new", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ id: "ses-new" }),
      })
      mockFeishuClient.replyMessage = vi.fn().mockResolvedValue({ code: 0, msg: "ok" })

      const handler = createHandler()
      const result = await handler("chat-1", "chat-1", "msg-1", "/NEW")

      expect(result).toBe(true)
      expect(mockSessionManager.deleteMapping).toHaveBeenCalledWith("chat-1")
    })
  })
})
