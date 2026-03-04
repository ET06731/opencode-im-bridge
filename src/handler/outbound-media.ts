/**
 * Outbound media handler — detects file paths in agent replies
 * and uploads them to Feishu as image or file messages.
 *
 * Security: only files within allowed directories may be uploaded.
 * Symlinks are resolved via fs.realpath to prevent escaping the allowlist.
 */

import { readFile, stat, realpath } from "node:fs/promises"
import { resolve } from "node:path"
import { homedir } from "node:os"
import type { FeishuApiClient } from "../feishu/api-client.js"
import type { Logger } from "../utils/logger.js"
import { getAttachmentsDir } from "../utils/paths.js"

// ── Public types ──

export interface OutboundMediaDeps {
  feishuClient: FeishuApiClient
  logger: Logger
  /** Extra directories (absolute) from which uploads are allowed. */
  allowedUploadDirs?: string[]
}

export interface OutboundMediaHandler {
  sendDetectedFiles(chatId: string, text: string): Promise<void>
}

// ── Constants ──

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024

// SVG excluded — treated as a regular file, not an image
const IMAGE_EXTENSIONS = /\.(png|jpg|jpeg|gif|webp)$/i

// Match absolute paths or tilde paths with file extensions.
// Anchored to start-of-string, whitespace, or certain punctuation to avoid matching URL path components.
const FILE_PATH_REGEX =
  /(?:^|[\s"'`(,:;>}\]）：，；】》])((~\/|\/)([^\s"'`<>|*?\n]+\.(?:png|jpg|jpeg|gif|webp|pdf|svg|doc|docx|xls|xlsx|csv|zip|tar|gz|mp3|mp4|wav|mov|avi|txt|md|json|yaml|yml|html|css|js|ts|py)))\b/gim

// Also match backtick file: URI pattern
const BACKTICK_FILE_REGEX = /`file:(\/[\w./-]+\.[\w.]+)`/gi

// ── Path extraction ──

function expandTilde(p: string): string {
  if (p.startsWith("~/")) {
    return resolve(homedir(), p.slice(2))
  }
  return p
}

function extractFilePaths(text: string): string[] {
  const seen = new Set<string>()
  const results: string[] = []

  // Pattern 1: absolute and tilde paths with known extensions
  for (const match of text.matchAll(FILE_PATH_REGEX)) {
    const raw = match[1]
    if (!raw) continue
    const expanded = expandTilde(raw.trim())
    if (!seen.has(expanded)) {
      seen.add(expanded)
      results.push(expanded)
    }
  }

  // Pattern 2: backtick file: URIs
  for (const match of text.matchAll(BACKTICK_FILE_REGEX)) {
    const raw = match[1]
    if (!raw) continue
    const expanded = expandTilde(raw.trim())
    if (!seen.has(expanded)) {
      seen.add(expanded)
      results.push(expanded)
    }
  }

  return results
}

function isImageFile(filePath: string): boolean {
  return IMAGE_EXTENSIONS.test(filePath)
}

// ── Allowlist helpers ──

function defaultAllowedDir(): string {
  return getAttachmentsDir()
}

function buildAllowlist(extraDirs?: string[]): string[] {
  const dirs = [defaultAllowedDir()]
  if (extraDirs) {
    for (const d of extraDirs) {
      dirs.push(resolve(d))
    }
  }
  return dirs
}

/**
 * Resolve symlinks and check the real path against the allowlist.
 * Returns the resolved real path if allowed, null otherwise.
 */
async function resolveAllowedPath(
  filePath: string,
  allowlist: string[],
  logger: Logger,
): Promise<string | null> {
  let real: string
  try {
    real = await realpath(filePath)
  } catch {
    // File doesn't exist or can't be resolved
    return null
  }

  for (const dir of allowlist) {
    if (real === dir || real.startsWith(dir + "/")) {
      return real
    }
  }
  logger.warn(
    `Blocked upload: resolved path "${real}" is outside allowed directories [${allowlist.join(", ")}]`,
  )
  return null
}

// ── Factory ──

export function createOutboundMediaHandler(
  deps: OutboundMediaDeps,
): OutboundMediaHandler {
  const { feishuClient, logger } = deps
  const allowlist = buildAllowlist(deps.allowedUploadDirs)

  return {
    async sendDetectedFiles(chatId: string, text: string): Promise<void> {
      const paths = [...new Set(extractFilePaths(text))]
      if (paths.length === 0) {
        logger.debug(`No file paths detected in response text (${text.length} chars)`)
        return
      }

      logger.info(`Detected ${paths.length} file path(s) in agent reply, attempting upload`)

      for (const filePath of paths) {
        try {
          // Cheap string prefilter — skip FS calls for paths clearly outside allowlist
          const resolved = resolve(filePath)
          if (!allowlist.some((dir) => resolved === dir || resolved.startsWith(dir + "/"))) {
            logger.debug(`Skipped ${filePath}: outside allowed directories (prefilter)`)
            continue
          }

          // Security: resolve symlinks and verify path is within allowlist
          const realPath = await resolveAllowedPath(filePath, allowlist, logger)
          if (!realPath) continue

          // Check file size using resolved path
          const fileStat = await stat(realPath)
          if (fileStat.size > MAX_UPLOAD_BYTES) {
            logger.warn(`Skipping ${realPath}: exceeds ${MAX_UPLOAD_BYTES / 1024 / 1024}MB size limit`)
            continue
          }

          // Read file using resolved path
          const fileData = await readFile(realPath)

          if (isImageFile(realPath)) {
            const imageKey = await feishuClient.uploadImage(fileData)
            await feishuClient.sendMessage(chatId, {
              msg_type: "image",
              content: JSON.stringify({ image_key: imageKey }),
            })
            logger.info(`Sent image to Feishu: ${realPath}`)
          } else {
            const fileName = realPath.split("/").pop() ?? "file"
            const fileKey = await feishuClient.uploadFile(fileData, fileName)
            await feishuClient.sendMessage(chatId, {
              msg_type: "file",
              content: JSON.stringify({ file_key: fileKey }),
            })
            logger.info(`Sent file to Feishu: ${realPath}`)
          }
        } catch (err) {
          logger.warn(`Failed to send file ${filePath} to Feishu: ${err}`)
        }
      }
    },
  }
}
