import { beforeEach, describe, expect, it, vi } from "vitest"
import { createServiceLauncher } from "./service-launcher.js"
import { createMockLogger } from "../__tests__/setup.js"

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}))

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}))

describe("createServiceLauncher", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns healthy immediately when the server is already up", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ healthy: true }),
    }) as any

    const launcher = createServiceLauncher({
      config: {
        enabled: true,
        autoStartServer: true,
        serverCommand: "opencode serve",
        serverStartTimeoutMs: 1000,
        probeTimeoutMs: 1000,
      },
      serverUrl: "http://127.0.0.1:4096",
      logger: createMockLogger(),
    })

    const result = await launcher.ensureServerReady("test")

    expect(result).toEqual({ healthy: true, started: false })
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it("starts the server process when probe fails and auto-start is enabled", async () => {
    let probeCount = 0
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      probeCount++
      if (probeCount < 3) {
        throw new Error("ECONNREFUSED")
      }
      return {
        ok: true,
        json: async () => ({ healthy: true }),
      }
    }) as any

    spawnMock.mockReturnValue({
      unref: vi.fn(),
    })

    const launcher = createServiceLauncher({
      config: {
        enabled: true,
        autoStartServer: true,
        serverCommand: "opencode serve",
        serverCwd: "D:/Project/PRwithAI/opencode-lark",
        serverStartTimeoutMs: 5000,
        probeTimeoutMs: 1000,
      },
      serverUrl: "http://127.0.0.1:4096",
      logger: createMockLogger(),
    })

    const result = await launcher.ensureServerReady("test")

    expect(result).toEqual({ healthy: true, started: true })
    expect(spawnMock).toHaveBeenCalledWith("opencode serve", expect.objectContaining({
      cwd: "D:/Project/PRwithAI/opencode-lark",
      detached: true,
      shell: true,
      stdio: "ignore",
    }))
  })
})
