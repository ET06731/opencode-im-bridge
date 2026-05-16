/**
 * Feishu Open Platform REST API client.
 * Handles tenant_access_token lifecycle and core messaging APIs.
 */

import { createLogger } from "../utils/logger.js"
import type { FeishuMessageBody, FeishuApiResponse } from "../types.js"

const logger = createLogger("feishu-api")

const FEISHU_BASE_URL = "https://open.feishu.cn/open-apis"

export const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024 // 50 MB

export class FileTooLargeError extends Error {
  constructor(public readonly filename: string, public readonly size: number) {
    super(`File "${filename}" exceeds the ${MAX_DOWNLOAD_BYTES / 1024 / 1024}MB size limit (Content-Length: ${size} bytes)`)
    this.name = "FileTooLargeError"
  }
}

interface FeishuApiClientOptions {
  appId: string
  appSecret: string
}

interface TokenState {
  token: string
  expiresAt: number
}

export interface FeishuApiClient {
  sendMessage(chatId: string, body: FeishuMessageBody): Promise<FeishuApiResponse>
  replyMessage(messageId: string, body: FeishuMessageBody): Promise<FeishuApiResponse>
  updateMessage(messageId: string, content: string): Promise<FeishuApiResponse>
  addReaction(messageId: string, emojiType: string): Promise<FeishuApiResponse>
  deleteReaction(messageId: string, reactionId: string): Promise<FeishuApiResponse>
  getMessage(messageId: string): Promise<FeishuApiResponse>
  downloadResource(messageId: string, fileKey: string, type: "image" | "file"): Promise<{ data: Buffer, filename?: string }>
  getBotInfo(): Promise<{ app_name: string; open_id: string }>
  uploadImage(imageData: Buffer, imageType?: string): Promise<string>
  uploadFile(fileData: Buffer, fileName: string, fileType?: string): Promise<string>
  uploadAudio(audioData: Buffer, fileName: string): Promise<string>
  uploadVideo(videoData: Buffer, fileName: string): Promise<string>
  sendTypingIndicator(chatId: string): Promise<FeishuApiResponse>
}


async function downloadResourceImpl(
  getToken: () => Promise<string>,
  clearToken: () => void,
  messageId: string,
  fileKey: string,
  type: "image" | "file",
  retryCount = 0,
): Promise<{ data: Buffer, filename?: string }> {
  const token = await getToken()

  const urlPath = `/im/v1/messages/${messageId}/resources/${fileKey}?type=${type}`

  const response = await fetch(`${FEISHU_BASE_URL}${urlPath}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
    },
  })

  // Token expired — clear and retry once (binary endpoints return HTTP 401)
  if (response.status === 401 && retryCount < 1) {
    await response.body?.cancel().catch(() => {})
    clearToken()
    return downloadResourceImpl(getToken, clearToken, messageId, fileKey, type, retryCount + 1)
  }

  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    throw new Error(`Feishu download error [${urlPath}]: ${response.status}`)
  }

  // Try to extract filename from Content-Disposition header
  const disposition = response.headers.get("content-disposition")
  let filename: string | undefined
  if (disposition) {
    const match = disposition.match(/filename\*?=["']?(?:UTF-8'')?([^"';\s]+)/i)
    if (match?.[1]) {
      try {
        filename = decodeURIComponent(match[1])
      } catch {
        filename = match[1]
      }
    }
  }

  // Check Content-Length before downloading body
  const contentLength = response.headers.get("content-length")
  const parsedLength = contentLength ? parseInt(contentLength, 10) : NaN
  let data: Buffer

  if (!Number.isNaN(parsedLength) && parsedLength > MAX_DOWNLOAD_BYTES) {
    // Known size exceeds limit — no need to drain, just throw
    await response.body?.cancel().catch(() => {})
    throw new FileTooLargeError(filename ?? fileKey, parsedLength)
  }

  if (!Number.isNaN(parsedLength) && parsedLength <= MAX_DOWNLOAD_BYTES) {
    // Fast path: known size, within limit
    const arrayBuffer = await response.arrayBuffer()
    if (arrayBuffer.byteLength > MAX_DOWNLOAD_BYTES) {
      throw new FileTooLargeError(filename ?? fileKey, arrayBuffer.byteLength)
    }
    data = Buffer.from(arrayBuffer)
  } else {
    // No Content-Length or unparseable — stream with byte counter
    const body = response.body
    if (!body) {
      throw new Error(`Feishu download error [${urlPath}]: response body is null`)
    }
    const reader = body.getReader()
    const chunks: Uint8Array[] = []
    let totalBytes = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        totalBytes += value.byteLength
        if (totalBytes > MAX_DOWNLOAD_BYTES) {
          await reader.cancel().catch(() => {})
          throw new FileTooLargeError(filename ?? fileKey, totalBytes)
        }
        chunks.push(value)
      }
    } catch (err) {
      if (err instanceof FileTooLargeError) throw err
      throw new Error(`Feishu download error [${urlPath}]: stream read failed: ${err}`)
    }
    data = Buffer.concat(chunks)
  }

  return { data, filename }
}

async function parseFeishuJsonResponse(
  response: Response,
  urlPath: string,
): Promise<FeishuApiResponse> {
  const rawText = await response.text()
  if (!rawText.trim()) {
    return response.ok
      ? { code: 0, msg: "ok" }
      : { code: response.status, msg: `HTTP ${response.status}` }
  }

  try {
    return JSON.parse(rawText) as FeishuApiResponse
  } catch (err) {
    throw new Error(`Failed to parse JSON for ${urlPath}: ${err}; body=${rawText.slice(0, 200)}`)
  }
}

export function createFeishuApiClient(options: FeishuApiClientOptions): FeishuApiClient {
  const { appId, appSecret } = options
  let tokenState: TokenState | null = null
  let refreshPromise: Promise<string> | null = null

  async function getToken(): Promise<string> {
    const now = Date.now()

    // Token still valid (refresh 5 min early)
    if (tokenState && tokenState.expiresAt - now > 300_000) {
      return tokenState.token
    }

    // Deduplicate concurrent refresh calls
    if (refreshPromise) {
      return refreshPromise
    }

    refreshPromise = refreshToken()
    try {
      return await refreshPromise
    } finally {
      refreshPromise = null
    }
  }

  async function refreshToken(): Promise<string> {
    logger.info("Refreshing tenant_access_token...")

    const response = await fetch(
      `${FEISHU_BASE_URL}/auth/v3/tenant_access_token/internal`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      },
    )

    const data = (await response.json()) as {
      code: number
      msg: string
      tenant_access_token: string
      expire: number
    }

    if (data.code !== 0) {
      throw new Error(`Failed to get tenant_access_token: ${data.msg}`)
    }

    tokenState = {
      token: data.tenant_access_token,
      expiresAt: Date.now() + data.expire * 1000,
    }

    logger.info(`Token refreshed, expires in ${data.expire}s`)
    return tokenState.token
  }

  async function apiRequest(
    method: string,
    urlPath: string,
    body?: Record<string, unknown>,
    retryCount = 0,
  ): Promise<FeishuApiResponse> {
    const token = await getToken()

    const response = await fetch(`${FEISHU_BASE_URL}${urlPath}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    })

    const data = await parseFeishuJsonResponse(response, urlPath)

    // Token expired — refresh and retry once
    if (data.code === 99991663 && retryCount < 1) {
      tokenState = null
      return apiRequest(method, urlPath, body, retryCount + 1)
    }

    if (data.code !== 0) {
      logger.error(`Feishu API error [${urlPath}]: ${data.code} - ${data.msg}`)
    }

    return data
  }

  return {
    async sendMessage(chatId, body) {
      return apiRequest("POST", "/im/v1/messages?receive_id_type=chat_id", {
        receive_id: chatId,
        msg_type: body.msg_type,
        content: body.content,
      })
    },

    async replyMessage(messageId, body) {
      return apiRequest("POST", `/im/v1/messages/${messageId}/reply`, {
        msg_type: body.msg_type,
        content: body.content,
      })
    },

    async updateMessage(messageId, content) {
      return apiRequest("PATCH", `/im/v1/messages/${messageId}`, {
        content,
      })
    },


    async addReaction(messageId, emojiType) {
      return apiRequest("POST", `/im/v1/messages/${messageId}/reactions`, {
        reaction_type: { emoji_type: emojiType },
      })
    },

    async deleteReaction(messageId, reactionId) {
      return apiRequest("DELETE", `/im/v1/messages/${messageId}/reactions/${reactionId}`)
    },

    async getMessage(messageId) {
      return apiRequest("GET", `/im/v1/messages/${messageId}`)
    },

    async downloadResource(messageId, fileKey, type) {
      return downloadResourceImpl(getToken, () => { tokenState = null }, messageId, fileKey, type)
    },

    async getBotInfo() {
      const resp = await apiRequest("GET", "/bot/v3/info")
      // /bot/v3/info returns { code, bot: { open_id, app_name } } — bot is top-level, not under data
      const bot = (resp.bot ?? resp.data?.bot) as { open_id?: string; app_name?: string } | undefined
      return {
        open_id: bot?.open_id ?? "",
        app_name: bot?.app_name ?? "",
      }
    },

    async uploadImage(imageData, imageType = "message") {
      const token = await getToken()
      const form = new FormData()
      form.append("image_type", imageType)
      form.append("image", new Blob([imageData]), "image.png")

      const response = await fetch(`${FEISHU_BASE_URL}/im/v1/images`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      })

      const data = (await response.json()) as FeishuApiResponse
      if (data.code !== 0) {
        throw new Error(`Feishu uploadImage error: ${data.code} - ${data.msg}`)
      }
      return (data.data?.image_key as string) ?? ""
    },

    async uploadFile(fileData, fileName, fileType = "stream") {
      const token = await getToken()
      const form = new FormData()
      form.append("file_type", fileType)
      form.append("file_name", fileName)
      form.append("file", new Blob([fileData]), fileName)

      const response = await fetch(`${FEISHU_BASE_URL}/im/v1/files`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      })

      const data = (await response.json()) as FeishuApiResponse
      if (data.code !== 0) {
        throw new Error(`Feishu uploadFile error: ${data.code} - ${data.msg}`)
      }
      return (data.data?.file_key as string) ?? ""
    },

    async uploadAudio(audioData, fileName) {
      return this.uploadFile(audioData, fileName, "opus")
    },

    async uploadVideo(videoData, fileName) {
      return this.uploadFile(videoData, fileName, "mp4")
    },

    async sendTypingIndicator(chatId) {
      const token = await getToken()
      const urlPath = "/im/v1/messages/typing_indicators"
      const response = await fetch(`${FEISHU_BASE_URL}${urlPath}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ receive_id: chatId }),
      })

      if (response.status === 404) {
        logger.info("Feishu typing indicator endpoint unavailable, skipping")
        return { code: 0, msg: "typing indicator unsupported" }
      }

      return parseFeishuJsonResponse(response, urlPath)
    },
  }
}
