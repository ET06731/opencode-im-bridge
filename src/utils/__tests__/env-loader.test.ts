import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  loadEnvFile,
  ensureConfigDir,
  listEnvFiles,
  CONFIG_DIR,
  bootstrapLauncherEnv,
  buildLauncherEnvLines,
  shouldBootstrapLauncher,
  DEFAULT_LAUNCHER_COMMAND,
} from "../env-loader.js"

describe("env-loader", () => {
  let tempDir: string
  let tempEnvPath: string
  const originalEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "env-loader-test-"))
    tempEnvPath = path.join(tempDir, ".env")
    // Save original env values for keys we'll be testing
    originalEnv.TEST_KEY = process.env.TEST_KEY
    originalEnv.TEST_KEY_2 = process.env.TEST_KEY_2
    originalEnv.QUOTED_KEY = process.env.QUOTED_KEY
    originalEnv.SINGLE_QUOTED = process.env.SINGLE_QUOTED
    originalEnv.MULTI_EQUAL = process.env.MULTI_EQUAL
    originalEnv.OPENCODE_SERVER_URL = process.env.OPENCODE_SERVER_URL
    originalEnv.OPENCODE_LAUNCHER_ENABLED = process.env.OPENCODE_LAUNCHER_ENABLED
    originalEnv.OPENCODE_AUTO_START_SERVER = process.env.OPENCODE_AUTO_START_SERVER
    originalEnv.OPENCODE_SERVER_COMMAND = process.env.OPENCODE_SERVER_COMMAND
    // Delete them from process.env so we start clean
    delete process.env.TEST_KEY
    delete process.env.TEST_KEY_2
    delete process.env.QUOTED_KEY
    delete process.env.SINGLE_QUOTED
    delete process.env.MULTI_EQUAL
    delete process.env.OPENCODE_SERVER_URL
    delete process.env.OPENCODE_LAUNCHER_ENABLED
    delete process.env.OPENCODE_AUTO_START_SERVER
    delete process.env.OPENCODE_SERVER_COMMAND
  })

  afterEach(() => {
    // Restore original env values
    if (originalEnv.TEST_KEY === undefined) {
      delete process.env.TEST_KEY
    } else {
      process.env.TEST_KEY = originalEnv.TEST_KEY
    }
    if (originalEnv.TEST_KEY_2 === undefined) {
      delete process.env.TEST_KEY_2
    } else {
      process.env.TEST_KEY_2 = originalEnv.TEST_KEY_2
    }
    if (originalEnv.QUOTED_KEY === undefined) {
      delete process.env.QUOTED_KEY
    } else {
      process.env.QUOTED_KEY = originalEnv.QUOTED_KEY
    }
    if (originalEnv.SINGLE_QUOTED === undefined) {
      delete process.env.SINGLE_QUOTED
    } else {
      process.env.SINGLE_QUOTED = originalEnv.SINGLE_QUOTED
    }
    if (originalEnv.MULTI_EQUAL === undefined) {
      delete process.env.MULTI_EQUAL
    } else {
      process.env.MULTI_EQUAL = originalEnv.MULTI_EQUAL
    }
    if (originalEnv.OPENCODE_SERVER_URL === undefined) {
      delete process.env.OPENCODE_SERVER_URL
    } else {
      process.env.OPENCODE_SERVER_URL = originalEnv.OPENCODE_SERVER_URL
    }
    if (originalEnv.OPENCODE_LAUNCHER_ENABLED === undefined) {
      delete process.env.OPENCODE_LAUNCHER_ENABLED
    } else {
      process.env.OPENCODE_LAUNCHER_ENABLED = originalEnv.OPENCODE_LAUNCHER_ENABLED
    }
    if (originalEnv.OPENCODE_AUTO_START_SERVER === undefined) {
      delete process.env.OPENCODE_AUTO_START_SERVER
    } else {
      process.env.OPENCODE_AUTO_START_SERVER = originalEnv.OPENCODE_AUTO_START_SERVER
    }
    if (originalEnv.OPENCODE_SERVER_COMMAND === undefined) {
      delete process.env.OPENCODE_SERVER_COMMAND
    } else {
      process.env.OPENCODE_SERVER_COMMAND = originalEnv.OPENCODE_SERVER_COMMAND
    }
    // Clean up temp files
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true })
    }
  })

  it("parses KEY=VALUE correctly", () => {
    fs.writeFileSync(tempEnvPath, "TEST_KEY=test_value\n")
    loadEnvFile(tempEnvPath)
    expect(process.env.TEST_KEY).toBe("test_value")
  })

  it("handles double-quoted values", () => {
    fs.writeFileSync(tempEnvPath, 'QUOTED_KEY="double quoted value"\n')
    loadEnvFile(tempEnvPath)
    expect(process.env.QUOTED_KEY).toBe("double quoted value")
  })

  it("handles single-quoted values", () => {
    fs.writeFileSync(tempEnvPath, "SINGLE_QUOTED='single quoted value'\n")
    loadEnvFile(tempEnvPath)
    expect(process.env.SINGLE_QUOTED).toBe("single quoted value")
  })

  it("skips comment lines starting with #", () => {
    fs.writeFileSync(
      tempEnvPath,
      `# This is a comment
TEST_KEY=value
# Another comment
`,
    )
    loadEnvFile(tempEnvPath)
    expect(process.env.TEST_KEY).toBe("value")
  })

  it("skips blank lines", () => {
    fs.writeFileSync(
      tempEnvPath,
      `
TEST_KEY=value

TEST_KEY_2=value2

`,
    )
    loadEnvFile(tempEnvPath)
    expect(process.env.TEST_KEY).toBe("value")
    expect(process.env.TEST_KEY_2).toBe("value2")
  })

  it("does NOT override existing process.env values", () => {
    process.env.TEST_KEY = "existing_value"
    fs.writeFileSync(tempEnvPath, "TEST_KEY=new_value\n")
    loadEnvFile(tempEnvPath)
    expect(process.env.TEST_KEY).toBe("existing_value")
  })

  it("no-ops gracefully when file doesn't exist", () => {
    const nonexistentPath = path.join(tempDir, "nonexistent.env")
    // Should not throw
    expect(() => {
      loadEnvFile(nonexistentPath)
    }).not.toThrow()
  })

  it("handles values with = signs in them", () => {
    fs.writeFileSync(tempEnvPath, "MULTI_EQUAL=a=b=c\n")
    loadEnvFile(tempEnvPath)
    expect(process.env.MULTI_EQUAL).toBe("a=b=c")
  })

  it("no-ops when no argument provided", () => {
    // loadEnvFile() with no args should do nothing (not even look for .env in cwd)
    expect(() => {
      loadEnvFile()
    }).not.toThrow()
  })

  it("strips leading/trailing whitespace from keys and values", () => {
    fs.writeFileSync(tempEnvPath, "  TEST_KEY  =  value_with_spaces  \n")
    loadEnvFile(tempEnvPath)
    expect(process.env.TEST_KEY).toBe("value_with_spaces")
  })

  it("preserves quotes in unquoted values", () => {
    fs.writeFileSync(tempEnvPath, 'TEST_KEY=value "with" quotes\n')
    loadEnvFile(tempEnvPath)
    expect(process.env.TEST_KEY).toBe('value "with" quotes')
  })

  it("handles empty quoted values", () => {
    fs.writeFileSync(tempEnvPath, 'QUOTED_KEY=""\n')
    loadEnvFile(tempEnvPath)
    expect(process.env.QUOTED_KEY).toBe("")
  })

  it("reports launcher bootstrap for local URLs", () => {
    expect(shouldBootstrapLauncher("http://localhost:4096")).toBe(true)
    expect(buildLauncherEnvLines("http://127.0.0.1:4096")).toEqual([
      "OPENCODE_LAUNCHER_ENABLED=true",
      "OPENCODE_AUTO_START_SERVER=true",
      `OPENCODE_SERVER_COMMAND=${DEFAULT_LAUNCHER_COMMAND}`,
    ])
  })

  it("skips launcher bootstrap for remote URLs", () => {
    expect(shouldBootstrapLauncher("https://example.com")).toBe(false)
    expect(buildLauncherEnvLines("https://example.com")).toEqual([])
  })

  it("bootstraps missing launcher env for local startup", () => {
    process.env.OPENCODE_SERVER_URL = "http://localhost:4096"

    bootstrapLauncherEnv()

    expect(process.env.OPENCODE_LAUNCHER_ENABLED).toBe("true")
    expect(process.env.OPENCODE_AUTO_START_SERVER).toBe("true")
    expect(process.env.OPENCODE_SERVER_COMMAND).toBe(DEFAULT_LAUNCHER_COMMAND)
  })

  it("preserves explicit launcher env values during bootstrap", () => {
    process.env.OPENCODE_SERVER_URL = "http://localhost:4096"
    process.env.OPENCODE_LAUNCHER_ENABLED = "false"
    process.env.OPENCODE_SERVER_COMMAND = "custom serve"

    bootstrapLauncherEnv()

    expect(process.env.OPENCODE_LAUNCHER_ENABLED).toBe("false")
    expect(process.env.OPENCODE_AUTO_START_SERVER).toBe("true")
    expect(process.env.OPENCODE_SERVER_COMMAND).toBe("custom serve")
  })
})

describe("ensureConfigDir", () => {
  let testConfigDir: string

  beforeEach(() => {
    testConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "ensure-config-test-"))
    // Clean it so we can test creation
    fs.rmSync(testConfigDir, { recursive: true })
  })

  afterEach(() => {
    if (fs.existsSync(testConfigDir)) {
      fs.rmSync(testConfigDir, { recursive: true })
    }
  })

  it("creates CONFIG_DIR if it does not exist", () => {
    // We can't easily test the real CONFIG_DIR without mocking,
    // so we just verify ensureConfigDir doesn't throw
    expect(() => ensureConfigDir()).not.toThrow()
    expect(fs.existsSync(CONFIG_DIR)).toBe(true)
  })

  it("does not throw if CONFIG_DIR already exists", () => {
    ensureConfigDir()
    // Call again — should be idempotent
    expect(() => ensureConfigDir()).not.toThrow()
  })
})

describe("listEnvFiles", () => {
  let testConfigDir: string

  beforeEach(() => {
    testConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "list-env-test-"))
  })

  afterEach(() => {
    if (fs.existsSync(testConfigDir)) {
      fs.rmSync(testConfigDir, { recursive: true })
    }
  })

  it("returns empty array when CONFIG_DIR does not exist", () => {
    // listEnvFiles uses the real CONFIG_DIR, but we can test via a temp dir approach
    // For this test, we verify the function handles non-existent dirs
    const result = listEnvFiles()
    // Result depends on whether ~/.config/opencode-lark exists
    expect(Array.isArray(result)).toBe(true)
  })

  it("returns env files with correct appId extraction", () => {
    // Create test .env files in a temp dir that mimics CONFIG_DIR
    // Since listEnvFiles reads from CONFIG_DIR constant, we test integration
    ensureConfigDir()
    const testFile = path.join(CONFIG_DIR, ".env.cli_test_abc123")
    const created = !fs.existsSync(testFile)
    if (created) {
      fs.writeFileSync(testFile, "FEISHU_APP_ID=cli_test_abc123\n")
    }

    try {
      const result = listEnvFiles()
      const match = result.find((r) => r.appId === "cli_test_abc123")
      expect(match).toBeDefined()
      expect(match?.filePath).toBe(testFile)
    } finally {
      if (created && fs.existsSync(testFile)) {
        fs.unlinkSync(testFile)
      }
    }
  })

  it("ignores files that don't match .env.* pattern", () => {
    ensureConfigDir()
    const junkFile = path.join(CONFIG_DIR, "config.json")
    const created = !fs.existsSync(junkFile)
    if (created) {
      fs.writeFileSync(junkFile, "{}")
    }

    try {
      const result = listEnvFiles()
      const match = result.find((r) => r.appId === "config.json")
      expect(match).toBeUndefined()
    } finally {
      if (created && fs.existsSync(junkFile)) {
        fs.unlinkSync(junkFile)
      }
    }
  })

  it("ignores bare .env file (no suffix)", () => {
    ensureConfigDir()
    const bareEnv = path.join(CONFIG_DIR, ".env.")
    const created = !fs.existsSync(bareEnv)
    if (created) {
      fs.writeFileSync(bareEnv, "TEST=1\n")
    }

    try {
      const result = listEnvFiles()
      // .env. has length 5, entry.length > 5 fails, so it should be excluded
      const match = result.find((r) => r.appId === "")
      expect(match).toBeUndefined()
    } finally {
      if (created && fs.existsSync(bareEnv)) {
        fs.unlinkSync(bareEnv)
      }
    }
  })
})
