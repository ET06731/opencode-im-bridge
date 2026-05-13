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
    setModel: vi.fn().mockReturnValue(true),
    cleanup: vi.fn().mockReturnValue(0),
    validateAndCleanupStale: vi.fn().mockResolvedValue(0),
  }
}

const DEFAULT_MAPPING: SessionMapping = {
  feishu_key: "chat-1",
  session_id: "ses-123",
  agent: "build",
  model: null,
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
    // Mock filesystem reads to return empty model state
    vi.mock("node:fs/promises", () => ({
      readFile: vi.fn().mockRejectedValue(new Error("ENOENT")),
      writeFile: vi.fn().mockResolvedValue(undefined),
    }))
  })

  function createHandler(sm?: SessionManager, overrides: Record<string, unknown> = {}) {
    return createCommandHandler({
      serverUrl: "http://test:4096",
      sessionManager: sm ?? mockSessionManager,
      feishuClient: mockFeishuClient,
      logger: mockLogger,
      ...overrides,
    })
  }

  describe("/new", () => {
    it("creates a new session and binds to it", async () => {
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
        body: JSON.stringify({}),
      })
      expect(mockSessionManager.setMapping).toHaveBeenCalledWith("chat-1", "ses-new")
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
        content: JSON.stringify({ text: "当前没有绑定的会话。请使用 /sessions 或 /new 创建。" }),
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
      expect(content).toHaveProperty("body")
      expect(content.body).toHaveProperty("elements")
      expect(content.header?.title?.content).toContain("选择项目会话")
      // Verify buttons are created for each session
      const actionElements = content.body.elements?.filter((e: any) => e.tag === "button")
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

    it("sends Telegram inline keyboard when telegram channel supports cards", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([{ id: "ses-1", title: "Chat A" }]),
      })

      const sendCard = vi.fn().mockResolvedValue(undefined)
      const handler = createCommandHandler({
        serverUrl: "http://test:4096",
        sessionManager: mockSessionManager,
        feishuClient: mockFeishuClient,
        logger: mockLogger,
        channelManager: {
          getChannel: vi.fn().mockReturnValue({
            outbound: {
              sendText: vi.fn(),
              sendCard,
            },
          }),
        } as any,
      })

      const result = await handler("chat-1", "chat-1", "msg-1", "/sessions", "telegram")

      expect(result).toBe(true)
      expect(sendCard).toHaveBeenCalled()
      expect(sendCard.mock.calls[0]?.[1]).toMatchObject({
        text: expect.stringContaining("Current session"),
        reply_markup: {
          inline_keyboard: expect.any(Array),
        },
      })
    })
  })

  describe("/agent", () => {
    it("lists agents with current selection", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve([
            { name: "build", mode: "primary" },
            { name: "researcher", mode: "primary" },
            { name: "subtask", mode: "subagent" },
          ]),
      })
      mockFeishuClient.replyMessage = vi.fn().mockResolvedValue({ code: 0, msg: "ok" })

      const handler = createHandler()
      const result = await handler("chat-1", "chat-1", "msg-1", "/agent")

      expect(result).toBe(true)
      expect(mockFetch).toHaveBeenCalledWith("http://test:4096/agent")
      expect(mockFeishuClient.replyMessage).toHaveBeenCalledWith("msg-1", {
        msg_type: "interactive",
        content: expect.any(String),
      })

      const callArgs = mockFeishuClient.replyMessage.mock.calls[0]
      const content = JSON.parse(callArgs?.[1]?.content as string)
      expect(content.header?.title?.content).toContain("Agent")
      const actionElements = content.body.elements?.filter((e: any) => e.tag === "button")
      expect(actionElements).toHaveLength(2)
      expect(actionElements[0]?.value?.command).toBe("/agent build")
    })

    it("switches to a valid agent", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([{ name: "build", mode: "primary" }, { name: "researcher", mode: "primary" }]),
      })
      mockFeishuClient.replyMessage = vi.fn().mockResolvedValue({ code: 0, msg: "ok" })

      const handler = createHandler()
      const result = await handler("chat-1", "chat-1", "msg-1", "/agent researcher")

      expect(result).toBe(true)
      expect(mockSessionManager.setMapping).toHaveBeenCalledWith("chat-1", "ses-123", "researcher")
      expect(mockFeishuClient.replyMessage).toHaveBeenCalledWith("msg-1", {
        msg_type: "text",
        content: expect.stringContaining("Agent"),
      })
    })
  })

  describe("/models", () => {
    it("sends interactive card with model buttons", async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              all: [
                {
                  id: "openai",
                  name: "OpenAI",
                  models: {
                    "gpt-5": { id: "gpt-5", name: "GPT-5" },
                    "gpt-5-mini": { id: "gpt-5-mini", name: "GPT-5 Mini" },
                  },
                },
              ],
            }),
        })
      mockFeishuClient.replyMessage = vi.fn().mockResolvedValue({ code: 0, msg: "ok" })

      const handler = createHandler()
      const result = await handler("chat-1", "chat-1", "msg-1", "/models")

      expect(result).toBe(true)
      expect(mockFetch).toHaveBeenCalledTimes(1)
      expect(mockFetch).toHaveBeenNthCalledWith(1, "http://test:4096/provider")
      expect(mockFeishuClient.replyMessage).toHaveBeenCalledWith("msg-1", {
        msg_type: "interactive",
        content: expect.any(String),
      })

      const callArgs = mockFeishuClient.replyMessage.mock.calls[0]
      const content = JSON.parse(callArgs?.[1]?.content as string)
      expect(content.header?.title?.content).toContain("Model")
      const actionElements = content.body.elements?.filter((e: any) => e.tag === "button")
      expect(actionElements).toHaveLength(2)
      expect(actionElements[0]?.value?.command).toBe("/models openai/gpt-5")
    })

    it("switches to a valid model", async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              all: [
                {
                  id: "openai",
                  name: "OpenAI",
                  models: {
                    "gpt-5": { id: "gpt-5", name: "GPT-5" },
                  },
                },
              ],
            }),
        })
        .mockResolvedValueOnce({ ok: true })
      mockFeishuClient.replyMessage = vi.fn().mockResolvedValue({ code: 0, msg: "ok" })

      const handler = createHandler()
      const result = await handler("chat-1", "chat-1", "msg-1", "/models openai/gpt-5", "feishu")

      expect(result).toBe(true)
      expect(mockSessionManager.setModel).toHaveBeenCalledWith("chat-1", "openai/gpt-5")
      expect(mockFeishuClient.replyMessage).toHaveBeenCalledWith("msg-1", {
        msg_type: "text",
        content: expect.stringContaining("已切换模型"),
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
      // setMapping replaces the binding in place so metadata can be preserved
      expect(mockSessionManager.deleteMapping).not.toHaveBeenCalled()
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
    it("sends POST /session/{id}/summarize", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true })
      mockFeishuClient.replyMessage = vi.fn().mockResolvedValue({ code: 0, msg: "ok" })

      const handler = createHandler()
      const result = await handler("chat-1", "chat-1", "msg-1", "/compact")

      expect(result).toBe(true)
      expect(mockFetch).toHaveBeenCalledWith(
        "http://test:4096/session/ses-123/prompt_async",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ parts: [{ type: "text", text: "/compact", role: "user" }] }),
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
        content: JSON.stringify({ text: "当前没有绑定的会话。请使用 /sessions 或 /new 创建。" }),
      })
    })
  })

  describe("/share", () => {
    it("sends POST /session/{id}/share", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ share: { url: "https://opencode.ai/s/ses-123" } }),
      })
      mockFeishuClient.replyMessage = vi.fn().mockResolvedValue({ code: 0, msg: "ok" })

      const handler = createHandler()
      const result = await handler("chat-1", "chat-1", "msg-1", "/share")

      expect(result).toBe(true)
      expect(mockFetch).toHaveBeenCalledWith(
        "http://test:4096/session/ses-123/share",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      )
    })
  })

  describe("/fork", () => {
    it("forks from the current session tip when no source message is provided", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ id: "ses-fork-1" }),
      })
      mockFeishuClient.replyMessage = vi.fn().mockResolvedValue({ code: 0, msg: "ok" })

      const handler = createHandler()
      const result = await handler("chat-1", "chat-1", "msg-1", "/fork")

      expect(result).toBe(true)
      expect(mockFetch).toHaveBeenCalledWith(
        "http://test:4096/session/ses-123/fork",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      )
      expect(mockSessionManager.setMapping).toHaveBeenCalledWith("chat-1", "ses-fork-1", "build")
      expect(mockFeishuClient.replyMessage).toHaveBeenCalledWith("msg-1", {
        msg_type: "text",
        content: JSON.stringify({ text: "已创建分叉会话: ses-fork-1" }),
      })
    })

    it("forks from the replied assistant message when parent context is available", async () => {
      mockFeishuClient.getMessage = vi.fn().mockResolvedValue({
        code: 0,
        data: {
          items: [{
            msg_type: "text",
            body: { content: JSON.stringify({ text: "Second reply" }) },
          }],
        },
      })
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve([
            { info: { id: "oc-msg-1" }, parts: [{ type: "text", text: "First reply" }] },
            { info: { id: "oc-msg-2" }, parts: [{ type: "text", text: "Second reply" }] },
          ]),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ id: "ses-fork-2" }),
        })
      mockFeishuClient.replyMessage = vi.fn().mockResolvedValue({ code: 0, msg: "ok" })

      const handler = createHandler()
      const result = await handler("chat-1", "chat-1", "msg-1", "/fork", "feishu", {
        replyToMessageId: "parent-msg-1",
      })

      expect(result).toBe(true)
      expect(mockFeishuClient.getMessage).toHaveBeenCalledWith("parent-msg-1")
      expect(mockFetch).toHaveBeenNthCalledWith(
        1,
        "http://test:4096/session/ses-123/message?limit=200",
      )
      expect(mockFetch).toHaveBeenNthCalledWith(
        2,
        "http://test:4096/session/ses-123/fork",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messageID: "oc-msg-2" }),
        },
      )
      expect(mockSessionManager.setMapping).toHaveBeenCalledWith("chat-1", "ses-fork-2", "build")
    })

    it("replies with guidance when the replied message cannot be resolved", async () => {
      mockFeishuClient.getMessage = vi.fn().mockResolvedValue({
        code: 0,
        data: {
          items: [{
            msg_type: "text",
            body: { content: JSON.stringify({ text: "Missing reply" }) },
          }],
        },
      })
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([
          { info: { id: "oc-msg-1" }, parts: [{ type: "text", text: "Another reply" }] },
        ]),
      })
      mockFeishuClient.replyMessage = vi.fn().mockResolvedValue({ code: 0, msg: "ok" })

      const handler = createHandler()
      const result = await handler("chat-1", "chat-1", "msg-1", "/fork", "feishu", {
        replyToMessageId: "parent-msg-2",
      })

      expect(result).toBe(true)
      expect(mockFetch).toHaveBeenCalledTimes(1)
      expect(mockFeishuClient.replyMessage).toHaveBeenCalledWith("msg-1", {
        msg_type: "text",
        content: JSON.stringify({
          text: "没有找到可用于分叉的历史消息。请回复一条助手消息后再执行 /fork，或直接使用 /fork <message_id>。",
        }),
      })
    })

    it("forks from the replied message using quotedText for non-Feishu channels (Telegram)", async () => {
      const sendTextMock = vi.fn().mockResolvedValue(undefined)
      const mockChannelManager = {
        getChannel: vi.fn().mockReturnValue({
          outbound: { sendText: sendTextMock, sendCard: vi.fn() },
        }),
      } as any

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve([
            { info: { id: "oc-msg-1" }, parts: [{ type: "text", text: "First reply" }] },
            { info: { id: "oc-msg-2" }, parts: [{ type: "text", text: "Second reply" }] },
          ]),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ id: "ses-fork-3" }),
        })

      const handler = createHandler(undefined, { channelManager: mockChannelManager })
      const result = await handler("chat-1", "chat-1", "msg-1", "/fork", "telegram", {
        replyToMessageId: "tg-msg-42",
        quotedText: "Second reply",
      })

      expect(result).toBe(true)
      expect(mockFeishuClient.getMessage).not.toHaveBeenCalled()
      expect(mockFetch).toHaveBeenNthCalledWith(
        1,
        "http://test:4096/session/ses-123/message?limit=200",
      )
      expect(mockFetch).toHaveBeenNthCalledWith(
        2,
        "http://test:4096/session/ses-123/fork",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messageID: "oc-msg-2" }),
        },
      )
      expect(mockSessionManager.setMapping).toHaveBeenCalledWith("chat-1", "ses-fork-3", "build")
      expect(sendTextMock).toHaveBeenCalled()
    })

    it("forks from the replied message using quotedText for Discord channel", async () => {
      const sendTextMock = vi.fn().mockResolvedValue(undefined)
      const mockChannelManager = {
        getChannel: vi.fn().mockReturnValue({
          outbound: { sendText: sendTextMock, sendCard: vi.fn() },
        }),
      } as any

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve([
            { info: { id: "oc-msg-1" }, parts: [{ type: "text", text: "Discord original" }] },
          ]),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ id: "ses-fork-4" }),
        })

      const handler = createHandler(undefined, { channelManager: mockChannelManager })
      const result = await handler("chat-1", "chat-1", "msg-1", "/fork", "discord", {
        replyToMessageId: "dc-msg-99",
        quotedText: "Discord original",
      })

      expect(result).toBe(true)
      expect(mockFeishuClient.getMessage).not.toHaveBeenCalled()
      expect(mockFetch).toHaveBeenNthCalledWith(
        1,
        "http://test:4096/session/ses-123/message?limit=200",
      )
      expect(mockFetch).toHaveBeenNthCalledWith(
        2,
        "http://test:4096/session/ses-123/fork",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messageID: "oc-msg-1" }),
        },
      )
      expect(mockSessionManager.setMapping).toHaveBeenCalledWith("chat-1", "ses-fork-4", "build")
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
      expect(content).toHaveProperty("body")
      expect(content.body).toHaveProperty("elements")
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
      expect(content).toHaveProperty("body")
      expect(content.body).toHaveProperty("elements")
    })
  })

  describe("/wake", () => {
    it("replies with guidance when launcher is not configured", async () => {
      mockFeishuClient.replyMessage = vi.fn().mockResolvedValue({ code: 0, msg: "ok" })

      const handler = createHandler()
      const result = await handler("chat-1", "chat-1", "msg-1", "/wake")

      expect(result).toBe(true)
      expect(mockFeishuClient.replyMessage).toHaveBeenLastCalledWith("msg-1", {
        msg_type: "text",
        content: JSON.stringify({
          text: "未配置唤醒器。请先设置 launcher.enabled、launcher.autoStartServer 和 launcher.serverCommand。",
        }),
      })
    })

    it("wakes server successfully when launcher is configured", async () => {
      mockFeishuClient.replyMessage = vi.fn().mockResolvedValue({ code: 0, msg: "ok" })
      const serviceLauncher = {
        ensureServerReady: vi.fn().mockResolvedValue({ healthy: true, started: true }),
        probeServer: vi.fn(),
      }

      const handler = createHandler(undefined, { serviceLauncher })
      const result = await handler("chat-1", "chat-1", "msg-1", "/wake")

      expect(result).toBe(true)
      expect(serviceLauncher.ensureServerReady).toHaveBeenCalledWith("slash wake")
      expect(mockFeishuClient.replyMessage).toHaveBeenNthCalledWith(1, "msg-1", {
        msg_type: "text",
        content: JSON.stringify({ text: "正在唤醒 opencode 服务端，请稍候..." }),
      })
      expect(mockFeishuClient.replyMessage).toHaveBeenNthCalledWith(2, "msg-1", {
        msg_type: "text",
        content: JSON.stringify({ text: "opencode 服务端已就绪，可以继续发送消息。" }),
      })
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
      expect(mockSessionManager.setMapping).toHaveBeenCalledWith("chat-1", "ses-new")
    })
  })
})
