import crypto from "node:crypto"
import {
  ILINK_BASE_URL,
  CHANNEL_VERSION,
  LONG_POLL_TIMEOUT_MS,
  type QrcodeResponse,
  type QrcodeStatusResponse,
  type GetUpdatesResponse,
  type SendMessageRequest,
  type SendMessageResponse,
} from "./types.js"

function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0)
  return Buffer.from(String(uint32), "utf-8").toString("base64")
}

function buildHeaders(token: string | undefined, body: unknown): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": randomWechatUin(),
  }
  if (body !== undefined) {
    headers["Content-Length"] = String(Buffer.byteLength(JSON.stringify(body), "utf-8"))
  }
  if (token) {
    headers.Authorization = `Bearer ${token}`
  }
  return headers
}

export async function apiGet<T>(baseUrl: string, path: string): Promise<T> {
  const url = `${baseUrl.replace(/\/$/, "")}/${path}`
  const res = await fetch(url)
  const text = await res.text()
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`)
  return JSON.parse(text) as T
}

export async function apiPost<T>(
  baseUrl: string,
  endpoint: string,
  body: object,
  token?: string,
  timeoutMs = 15_000,
): Promise<T> {
  const url = `${baseUrl.replace(/\/$/, "")}/${endpoint}`
  const payload = { ...body, base_info: { channel_version: CHANNEL_VERSION } }
  const bodyStr = JSON.stringify(payload)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: buildHeaders(token, payload),
      body: bodyStr,
      signal: controller.signal,
    })
    clearTimeout(timer)
    const text = await res.text()
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`)
    return JSON.parse(text) as T
  } catch (err) {
    clearTimeout(timer)
    if ((err as Error).name === "AbortError") return null as T
    throw err
  }
}

export async function getQrcode(baseUrl: string): Promise<QrcodeResponse> {
  return apiGet<QrcodeResponse>(baseUrl, `ilink/bot/get_bot_qrcode?bot_type=3`)
}

export async function getQrcodeStatus(baseUrl: string, qrcode: string): Promise<QrcodeStatusResponse> {
  return apiGet<QrcodeStatusResponse>(baseUrl, `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`)
}

export async function getUpdates(
  baseUrl: string,
  token: string,
  getUpdatesBuf: string,
): Promise<GetUpdatesResponse> {
  const resp = await apiPost<GetUpdatesResponse>(
    baseUrl,
    "ilink/bot/getupdates",
    { get_updates_buf: getUpdatesBuf ?? "" },
    token,
    LONG_POLL_TIMEOUT_MS + 5_000,
  )
  return resp ?? { ret: 0, msgs: [], get_updates_buf: getUpdatesBuf }
}

export async function sendMessage(
  baseUrl: string,
  token: string,
  toUserId: string,
  text: string,
  contextToken: string,
): Promise<SendMessageResponse> {
  const clientId = `wcb-${crypto.randomUUID()}`
  const request = {
    msg: {
      from_user_id: "",
      to_user_id: toUserId,
      client_id: clientId,
      message_type: 2,
      message_state: 2,
      context_token: contextToken,
      item_list: [{ type: 1, text_item: { text } }],
    },
    base_info: { channel_version: CHANNEL_VERSION },
  }
  return apiPost<SendMessageResponse>(baseUrl, "ilink/bot/sendmessage", request, token)
}

export { ILINK_BASE_URL, CHANNEL_VERSION }
