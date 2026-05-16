/**
 * Outbound media handler — detects file paths in agent replies
 * and sends them to the target channel as image or file messages.
 *
 * Security: only files within allowed directories may be uploaded.
 * Symlinks are resolved via fs.realpath to prevent escaping the allowlist.
 *
 * Design: uses ChannelOutboundAdapter.sendImage/sendFile (optional) so each
 * channel plugin is responsible for its own upload/send logic. Falls back
 * silently if the plugin does not implement the required method.
 */

import { stat, realpath, readdir } from "node:fs/promises"
import { resolve, join, basename } from "node:path"
import { homedir } from "node:os"
import type { ChannelOutboundAdapter, OutboundTarget } from "../channel/types.js"
import type { Logger } from "../utils/logger.js"
import { getAttachmentsDir } from "../utils/paths.js"

// ── Public types ──

export interface OutboundMediaDeps {
  outbound?: ChannelOutboundAdapter
  logger: Logger
}

export interface OutboundMediaHandler {
  sendDetectedFiles(target: OutboundTarget, text: string, outboundAdapter?: ChannelOutboundAdapter): Promise<void>
  snapshotAttachments(targetAddress: string): Promise<void>
}

// ── Constants ──

export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024

const IMAGE_EXTENSIONS = /\.(png|jpg|jpeg|gif|webp)$/i
const AUDIO_EXTENSIONS = /\.(opus|mp3|wav|m4a|ogg|flac)$/i
const VIDEO_EXTENSIONS = /\.(mp4|mov|avi|webm|mkv)$/i
const FILE_EXTENSIONS = /\.(pdf|doc|docx|ppt|pptx|rtf|odt|ods|odp|xls|xlsx|csv|zip|tar|gz|txt|md|json|yaml|yml|html|css|js|ts|py|sh|svg)$/i

// ── Path extraction ──

export function expandTilde(p: string): string {
  if (p.startsWith("~/")) {
    return resolve(homedir(), p.slice(2))
  }
  return p
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/")
}

const EXT_REGEX = /\.(png|jpg|jpeg|gif|webp|pdf|svg|doc|docx|ppt|pptx|rtf|odt|ods|odp|xls|xlsx|csv|zip|tar|gz|mp3|mp4|wav|mov|avi|txt|md|json|yaml|yml|html|css|js|ts|py|sh)$/i

// Control chars + Windows illegal chars except slashes (slashes are path separators)
const WIN_PATH_REGEX = /([A-Za-z]:[/\\][^\x00-\x1f<>:"\|?*]+)/g
// Unix path: starts at string beginning or after newline, then /~ + path
const UNIX_PATH_REGEX = /^(?![A-Za-z]:)[/~][^\x00-\x1f<>:"\\|?*]+/gm

export function extractFilePaths(text: string): string[] {
  const seen = new Set<string>()
  const results: string[] = []

  for (const match of text.matchAll(WIN_PATH_REGEX)) {
    const raw = match[1] ?? match[0]
    if (!raw || !EXT_REGEX.test(raw)) continue
    const normalized = normalizePath(raw)
    if (!seen.has(normalized)) {
      seen.add(normalized)
      results.push(normalized)
    }
  }

  for (const match of text.matchAll(UNIX_PATH_REGEX)) {
    const raw = match[1] ?? match[0]
    if (!raw || !EXT_REGEX.test(raw)) continue
    const expanded = expandTilde(raw)
    const normalized = normalizePath(expanded)
    if (!seen.has(normalized)) {
      seen.add(normalized)
      results.push(normalized)
    }
  }

  for (const match of text.matchAll(/`file:(\/[^`]+)`/g)) {
    const raw = match[1] ?? match[0]
    if (!raw || !EXT_REGEX.test(raw)) continue
    const expanded = expandTilde(raw)
    const normalized = normalizePath(expanded)
    if (!seen.has(normalized)) {
      seen.add(normalized)
      results.push(normalized)
    }
  }

  return results
}

function isImageFile(filePath: string): boolean {
  return IMAGE_EXTENSIONS.test(filePath)
}

function isAudioFile(filePath: string): boolean {
  return AUDIO_EXTENSIONS.test(filePath)
}

function isVideoFile(filePath: string): boolean {
  return VIDEO_EXTENSIONS.test(filePath)
}

function isDocumentFile(filePath: string): boolean {
  return FILE_EXTENSIONS.test(filePath)
}

type FileType = "image" | "audio" | "video" | "file"

function classifyFile(filePath: string): FileType | null {
  if (isImageFile(filePath)) return "image"
  if (isAudioFile(filePath)) return "audio"
  if (isVideoFile(filePath)) return "video"
  if (isDocumentFile(filePath)) return "file"
  return null
}

// ── Allowlist helpers ──

function defaultAllowedDir(): string {
  return getAttachmentsDir()
}

function buildAllowlist(): string[] {
  return [normalizePath(defaultAllowedDir())]
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

  const normalizedReal = normalizePath(real)
  for (const dir of allowlist) {
    if (normalizedReal === dir || normalizedReal.startsWith(dir + "/")) {
      return normalizedReal
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
  const { outbound, logger } = deps
  const allowlist = buildAllowlist()

  // Snapshot of files per chat/target — used to detect agent-created files
  const dirSnapshots = new Map<string, Set<string>>()

  async function scanNewFiles(target: OutboundTarget, adapter: ChannelOutboundAdapter): Promise<void> {
    const snapshot = dirSnapshots.get(target.address)
    if (!snapshot) {
      logger.warn(`[OutboundMedia] No snapshot found for target: ${target.address}`)
      return
    }

    logger.info(`[OutboundMedia] Scanning for new files, snapshot has ${snapshot.size} files`)
    logger.info(`[OutboundMedia] Allowlist directories: ${allowlist.join(", ")}`)

    for (const dir of allowlist) {
      let entries: string[]
      try {
        entries = await readdir(dir)
        logger.info(`[OutboundMedia] Directory ${dir} has ${entries.length} entries`)
      } catch (err) {
        logger.warn(`[OutboundMedia] Failed to read directory ${dir}: ${err}`)
        continue
      }

      for (const fileName of entries) {
        if (snapshot.has(fileName)) {
          continue
        }
        logger.info(`[OutboundMedia] New file detected: ${fileName}`)
        const filePath = join(dir, fileName)
        const type = classifyFile(fileName)
        if (type) {
          logger.debug(`[OutboundMedia] Classified as type: ${type}`)
          await processFile(filePath, target, adapter, type, logger, allowlist)
        } else {
          logger.warn(`[OutboundMedia] File not classified: ${fileName}`)
        }
      }
    }
  }

  return {
    async snapshotAttachments(targetAddress: string): Promise<void> {
      const snapshot = new Set<string>()
      logger.info(`[OutboundMedia] Taking snapshot for target: ${targetAddress}`)
      for (const dir of allowlist) {
        try {
          const entries = await readdir(dir)
          logger.info(`[OutboundMedia] Directory ${dir} has ${entries.length} files`)
          for (const f of entries) snapshot.add(f)
        } catch (err) {
          logger.warn(`[OutboundMedia] Failed to read directory ${dir} for snapshot: ${err}`)
        }
      }
      dirSnapshots.set(targetAddress, snapshot)
      logger.info(`[OutboundMedia] Snapshot taken for ${targetAddress}: ${snapshot.size} files`)
    },

    async sendDetectedFiles(target: OutboundTarget, text: string, outboundAdapter?: ChannelOutboundAdapter): Promise<void> {
      const adapter = outboundAdapter ?? outbound
      if (!adapter) {
        logger.debug("Channel plugin not provided, skipping media detection")
        return
      }

      logger.info(`[OutboundMedia] sendDetectedFiles called for ${target.address}`)

      // Extract file paths from text
      const extractedPaths = extractFilePaths(text)
      logger.info(`[OutboundMedia] Extracted ${extractedPaths.length} paths from text: ${JSON.stringify(extractedPaths)}`)

      // Snapshot-based detection
      const hasSnapshot = dirSnapshots.has(target.address)
      logger.info(`[OutboundMedia] Snapshot exists: ${hasSnapshot}, target in map: ${dirSnapshots.has(target.address)}`)

      if (hasSnapshot) {
        await scanNewFiles(target, adapter)
      }

      // Also process extracted paths from text
      for (const filePath of extractedPaths) {
        const type = classifyFile(filePath)
        if (type) {
          logger.info(`[OutboundMedia] Processing extracted path: ${filePath}, type: ${type}`)
          await processFile(filePath, target, adapter, type, logger, allowlist)
        } else {
          logger.warn(`[OutboundMedia] Extracted path not classified: ${filePath}`)
        }
      }
    },
  }
}

async function processFile(
  filePath: string,
  target: OutboundTarget,
  adapter: ChannelOutboundAdapter,
  type: "image" | "audio" | "video" | "file",
  logger: Logger,
  allowlist: string[],
): Promise<void> {
  try {
    const resolved = normalizePath(resolve(filePath))
    if (!allowlist.some((dir) => resolved === dir || resolved.startsWith(dir + "/"))) {
      logger.debug(`Skipped ${filePath}: outside allowed directories (prefilter)`)
      return
    }

    const realPath = await resolveAllowedPath(filePath, allowlist, logger)
    if (!realPath) return

    const fileStat = await stat(realPath)
    const fileName = basename(realPath)
    if (fileStat.size > MAX_UPLOAD_BYTES) {
      const sizeMB = (fileStat.size / 1024 / 1024).toFixed(1)
      const limitMB = MAX_UPLOAD_BYTES / 1024 / 1024
      logger.warn(`Skipping ${realPath}: exceeds ${limitMB}MB size limit`)
      // 告知用户文件太大
      if (adapter.sendText) {
        const msg = `文件 "${fileName}" 大小为 ${sizeMB}MB，超过 ${limitMB}MB 限制，无法发送`
        await adapter.sendText(target, msg)
      }
      return
    }

    logger.debug(`processFile: type=${type}, file=${filePath}, sendImage=${!!adapter.sendImage}, sendFile=${!!adapter.sendFile}`)
    if (type === "image" && adapter.sendImage) {
      logger.info(`[OutboundMedia] Sending image via plugin: ${realPath}`)
      await adapter.sendImage(target, realPath)
      logger.info(`Sent image via channel plugin: ${realPath}`)
    } else if (type === "audio" && adapter.sendAudio) {
      logger.info(`[OutboundMedia] Sending audio via plugin: ${realPath}`)
      await adapter.sendAudio(target, realPath)
      logger.info(`Sent audio via channel plugin: ${realPath}`)
    } else if (type === "video" && adapter.sendVideo) {
      logger.info(`[OutboundMedia] Sending video via plugin: ${realPath}`)
      await adapter.sendVideo(target, realPath)
      logger.info(`Sent video via channel plugin: ${realPath}`)
    } else if (type === "file" && adapter.sendFile) {
      logger.info(`[OutboundMedia] Sending file via plugin: ${realPath}`)
      await adapter.sendFile(target, realPath)
      logger.info(`Sent file via channel plugin: ${realPath}`)
    } else {
      logger.warn(`[OutboundMedia] No suitable sender for type=${type}, file=${filePath}`)
    }
  } catch (err) {
    logger.warn(`Failed to send ${type} ${filePath}: ${err}`)
  }
}
