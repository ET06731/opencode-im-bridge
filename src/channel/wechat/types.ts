/**
 * WeChat iLink Bot API type definitions.
 * Based on official @tencent-weixin/openclaw-weixin protocol.
 */

// ── API Constants ──

export const ILINK_BASE_URL = "https://ilinkai.weixin.qq.com"
export const CHANNEL_VERSION = "1.0.2"
export const BOT_TYPE = 3
export const LONG_POLL_TIMEOUT_MS = 35_000
export const MAX_CONSECUTIVE_FAILURES = 5
export const RETRY_DELAY_MS = 3_000
export const BACKOFF_DELAY_MS = 30_000

// ── Session Types ──

export interface WechatSession {
  token: string
  baseUrl: string
  accountId: string
  userId: string
  savedAt: string
}

// ── API Request/Response Types ──

export interface QrcodeResponse {
  qrcode: string
  qrcode_img_content: string
}

export interface QrcodeStatusResponse {
  status: "wait" | "scaned" | "expired" | "confirmed"
  bot_token?: string
  baseurl?: string
  ilink_bot_id?: string
  ilink_user_id?: string
}

export interface GetUpdatesRequest {
  get_updates_buf: string
  base_info: {
    channel_version: string
  }
}

export interface GetUpdatesResponse {
  ret: number
  errcode?: number
  errmsg?: string
  msgs?: WechatMessage[]
  get_updates_buf?: string
  longpolling_timeout_ms?: number
}

export interface SendMessageRequest {
  msg: {
    from_user_id: string
    to_user_id: string
    client_id: string
    message_type: number
    message_state: number
    context_token: string
    item_list: MessageItem[]
  }
  base_info: {
    channel_version: string
  }
}

export interface SendMessageResponse {
  ret: number
  errcode?: number
  errmsg?: string
  msg_id?: string
}

// ── Message Types ──

export interface WechatMessage {
  from_user_id: string
  to_user_id: string
  client_id?: string
  message_type: number  // 1 = user message, 2 = bot message
  message_state: number
  context_token: string
  item_list: MessageItem[]
  group_id?: string
}

export interface MessageItem {
  type: number
  text_item?: {
    text: string
  }
  image_item?: {
    aes_key: string
    aes_iv: string
    file_id: string
    md5sum: string
    enc_url: string
    size: number
    width?: number
    height?: number
  }
  voice_item?: {
    text?: string  // Speech-to-text result
    aes_key: string
    file_id: string
    md5sum: string
    enc_url: string
    duration: number
  }
  file_item?: {
    file_name: string
    aes_key: string
    file_id: string
    md5sum: string
    enc_url: string
    size: number
  }
  video_item?: {
    thumb_aes_key: string
    thumb_enc_url: string
    thumb_width: number
    thumb_height: number
    aes_key: string
    file_id: string
    md5sum: string
    enc_url: string
    duration: number
    size: number
  }
}

// ── Normalized Message ──

export interface NormalizedWechatMessage {
  messageId: string
  senderId: string
  senderName?: string
  text: string
  chatId: string
  threadId?: string
  timestamp: number
  replyToId?: string
  contextToken: string
  messageType: "text" | "image" | "voice" | "file" | "video"
}

// ── Config Types ──

export interface WechatConfig {
  enabled: boolean
  sessionFile?: string  // Path to save session token
}
