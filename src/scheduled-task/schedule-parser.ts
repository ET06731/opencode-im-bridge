import type { ParsedTaskSchedule } from "./types.js"

/**
 * Parses natural language schedule expressions into structured data.
 * Supports: "every Nm", "every Nh", "daily HH:MM", "weekly", "cron expr", and specific datetime for one-time tasks.
 */

export function parseSchedule(text: string): ParsedTaskSchedule {
  let trimmed = text.trim()

  // Strip common prefixes that don't affect schedule meaning
  trimmed = trimmed.replace(/^(创建任务|请|帮我|我想|我要|定时|自动)\s*/i, "")

  // 中文自然语言支持
  const chinesePatterns = parseChineseSchedule(trimmed)
  if (chinesePatterns) {
    return chinesePatterns
  }

  const datetimeMatch = trimmed.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{1,2}):(\d{2})$/)
  if (datetimeMatch) {
    const [, date, hourStr, minuteStr] = datetimeMatch
    const hour = Number(hourStr)
    const minute = Number(minuteStr)
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
      throw new Error(`Invalid datetime "${text}": hour must be 0-23, minute must be 0-59`)
    }
    const runAt = `${date}T${hourStr!.padStart(2, "0")}:${minuteStr!.padStart(2, "0")}:00`
    return {
      cronExpression: `${minute} ${hour} ${date!.split("-")[1]} ${date!.split("-")[2]} *`,
      summary: `Once at ${date} ${hourStr}:${minuteStr!.padStart(2, "0")}`,
      kind: "once",
      runAt,
    }
  }

  const intervalMatch = trimmed.match(/^every\s+(\d+)\s*([mh])$/i)
  if (intervalMatch) {
    const value = Number(intervalMatch[1])
    const unit = intervalMatch[2]!.toLowerCase()
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`Invalid schedule "${text}": interval must be a positive number`)
    }
    if (unit === "m") {
      return {
        cronExpression: `0 */${value} * * * *`,
        summary: `Every ${value} minute${value > 1 ? "s" : ""}`,
        kind: "cron",
      }
    }
    return {
      cronExpression: `0 0 */${value} * * *`,
      summary: `Every ${value} hour${value > 1 ? "s" : ""}`,
      kind: "cron",
    }
  }

  const dailyMatch = trimmed.match(/^daily\s+(\d{1,2}):(\d{2})$/i)
  if (dailyMatch) {
    const hour = Number(dailyMatch[1])
    const minute = Number(dailyMatch[2])
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
      throw new Error(`Invalid schedule "${text}": invalid time (expected HH:MM with hour 0-23, minute 0-59)`)
    }
    const hourStr = String(hour).padStart(2, "0")
    const minuteStr = String(minute).padStart(2, "0")
    return {
      cronExpression: `0 ${minute} ${hour} * * *`,
      summary: `Daily at ${hourStr}:${minuteStr}`,
      kind: "cron",
    }
  }

  if (/^weekly$/i.test(trimmed)) {
    return {
      cronExpression: `0 0 0 * * 0`,
      summary: "Weekly on Sunday",
      kind: "cron",
    }
  }

  const fields = trimmed.split(/\s+/)
  if (fields.length === 5) {
    if (!isValidCronFields(fields)) {
      throw new Error(`Invalid cron expression "${text}": invalid field values`)
    }
    return {
      cronExpression: `0 ${trimmed}`,
      summary: `Cron: ${trimmed}`,
      kind: "cron",
    }
  }

  if (fields.length === 6) {
    if (!isValidCronFields(fields)) {
      throw new Error(`Invalid cron expression "${text}": invalid field values`)
    }
    return {
      cronExpression: trimmed,
      summary: `Cron: ${trimmed}`,
      kind: "cron",
    }
  }

  throw new Error(`无法识别 "${text}"。支持格式: "每天19:00", "每周三14:30", "every Nm", "every Nh", "daily HH:MM", "cron表达式", "YYYY-MM-DD HH:MM"`)
}

export function getScheduleSummary(parsed: ParsedTaskSchedule): string {
  return parsed.summary
}

function isValidCronFields(fields: string[]): boolean {
  const fieldCount = fields.length
  if (fieldCount !== 5 && fieldCount !== 6) return false

  // Field positions (0-indexed):
  // 5-field: minute hour day month dayOfWeek
  // 6-field: second minute hour day month dayOfWeek

  const ranges: [number, number][] = fieldCount === 5
    ? [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]]  // minute, hour, day, month, dayOfWeek
    : [[0, 59], [0, 59], [0, 23], [1, 31], [1, 12], [0, 6]] // second, minute, hour, day, month, dayOfWeek

  for (let i = 0; i < fieldCount; i++) {
    const field = fields[i]!
    if (field === "*") continue

    const stepMatch = field.match(/^\*\/(\d+)$/)
    if (stepMatch) {
      const step = Number(stepMatch[1])
      if (step < 1 || step > ranges[i]![1]) return false
      continue
    }

    const rangeMatch = field.match(/^(\d+)-(\d+)$/)
    if (rangeMatch) {
      const start = Number(rangeMatch[1])
      const end = Number(rangeMatch[2])
      if (start < ranges[i]![0] || start > ranges[i]![1]) return false
      if (end < ranges[i]![0] || end > ranges[i]![1]) return false
      if (start > end) return false
      continue
    }

    const listMatch = field.match(/^(\d+(,\d+)*)$/)
    if (listMatch) {
      const parts = field.split(",")
      for (const part of parts) {
        const num = Number(part)
        if (isNaN(num) || num < ranges[i]![0] || num > ranges[i]![1]) return false
      }
      continue
    }

    const num = Number(field)
    if (isNaN(num) || num < ranges[i]![0] || num > ranges[i]![1]) return false
  }

  return true
}

function parseChineseSchedule(text: string): ParsedTaskSchedule | null {
  const t = text.toLowerCase()

  const chineseDigit: Record<string, number> = {
    "零": 0, "一": 1, "二": 2, "三": 3, "四": 4,
    "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10,
  }

  function parseChineseNumeral(s: string): number {
    if (!s) return 0
    // Handle pure Arabic digits
    if (/^\d+$/.test(s)) {
      return parseInt(s, 10)
    }
    let result = 0
    let temp = 0

    for (let i = 0; i < s.length; i++) {
      const char = s[i]!
      if (char === "十") {
        if (temp === 0) {
          // "十" at start or after another "十" means 10
          result += result === 0 ? 10 : result * 10
        } else {
          // Normal case: e.g. "二十" = 2*10, "二十五" = 2*10+5
          result += temp * 10
          temp = 0
        }
      } else {
        const val = chineseDigit[char]
        if (val !== undefined && val < 10) {
          temp = temp * 10 + val
        }
      }
    }
    result += temp
    return result
  }

  // 每天几点 - supports "每天19:00", "每天19点", "每天晚上7点", "每天晚上八点15分", "每天晚上八点"
  const dailyMatch = t.match(/^每天((?:晚上|上午|中午|凌晨|早上|下午)?)(.+)/)
  if (dailyMatch) {
    const [, timeOfDay, timePart] = dailyMatch
    if (!timePart) return null

    let hour = 0
    let minute = 0

    // Try colon format: "19:00" or "8:15"
    const colonMatch = timePart.match(/^(\d{1,2}):(\d{1,2})/)
    if (colonMatch) {
      hour = parseInt(colonMatch[1]!, 10)
      minute = parseInt(colonMatch[2]!, 10)
    } else {
      // Try Chinese format: "八点15分", "八点", "8点", "8点15分"
      const chineseTimeMatch = timePart.match(/^([一二三四五六七八九十\d]+)点(?:([一二三四五六七八九十五\d]+)分?)?/)
      if (chineseTimeMatch) {
        hour = parseChineseNumeral(chineseTimeMatch[1]!)
        if (chineseTimeMatch[2]) {
          minute = parseChineseNumeral(chineseTimeMatch[2]!)
        }
      } else {
        // Just digits without "点": "19"
        const justDigits = timePart.match(/^(\d+)/)
        if (justDigits) {
          hour = parseInt(justDigits[1]!, 10)
        }
      }
    }

    // Apply time-of-day offset
    if (timeOfDay === "晚上" && hour < 12) hour += 12
    if (timeOfDay === "凌晨" && hour >= 6) hour -= 12
    if (timeOfDay === "早上" && hour < 6) hour += 12

    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null

    const hourStr = String(hour).padStart(2, "0")
    const minuteStr = String(minute).padStart(2, "0")
    return {
      cronExpression: `0 ${minute} ${hour} * * *`,
      summary: `每天 ${hourStr}:${minuteStr}`,
      kind: "cron",
    }
  }

  // 提醒我吃饭 - extract time from "每天19:10提醒我吃饭" (no "点" but has "提醒")
  if (text.includes("提醒")) {
    const remindMatch = text.match(/(\d{1,2}):(\d{1,2})/)
    if (remindMatch) {
      let hour = parseInt(remindMatch[1]!, 10)
      const minute = parseInt(remindMatch[2]!, 10)

      if (text.includes("晚上") && hour < 12) hour += 12

      if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null

      const hourStr = String(hour).padStart(2, "0")
      const minuteStr = String(minute).padStart(2, "0")
      return {
        cronExpression: `0 ${minute} ${hour} * * *`,
        summary: `每天 ${hourStr}:${minuteStr}`,
        kind: "cron",
      }
    }
  }

  // 每周几几点
  const weeklyMatch = t.match(/每周([一二三四五六日天])[^\d]*(\d{1,2})(?:点|时)?(?:(\d{1,2})(?:分|分钟))?/)
  if (weeklyMatch) {
    const dayMap: Record<string, number> = { "一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "日": 0, "天": 0 }
    const dayOfWeek = dayMap[weeklyMatch[1]!]
    if (dayOfWeek === undefined) return null

    let hour = Number(weeklyMatch[2])
    const minute = weeklyMatch[3] ? Number(weeklyMatch[3]) : 0

    if (t.includes("晚上") && hour < 12) hour += 12

    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null

    const hourStr = String(hour).padStart(2, "0")
    const minuteStr = String(minute).padStart(2, "0")
    return {
      cronExpression: `0 ${minute} ${hour} * * ${dayOfWeek}`,
      summary: `每周${weeklyMatch[1]} ${hourStr}:${minuteStr}`,
      kind: "cron",
    }
  }

  // 每隔几小时
  const everyHourMatch = t.match(/每[隔个]?(\d+)小时/)
  if (everyHourMatch) {
    const hours = Number(everyHourMatch[1])
    if (hours > 0 && hours <= 24) {
      return {
        cronExpression: `0 0 */${hours} * * *`,
        summary: `每 ${hours} 小时`,
        kind: "cron",
      }
    }
  }

  // 每隔几分钟 - 支持阿拉伯数字和中文数字
  function parseChineseNum(text: string): number | null {
    if (/^\d+$/.test(text)) return parseInt(text, 10)
    let result = 0
    let temp = 0
    for (const char of text) {
      if (char === "十") {
        if (temp === 0) {
          result += result === 0 ? 10 : result * 10
        } else {
          result += temp * 10
          temp = 0
        }
      } else {
        const val = chineseDigit[char]
        if (val !== undefined && val < 10) {
          temp = temp * 10 + val
        }
      }
    }
    result += temp
    return result > 0 ? result : null
  }

  const everyMinMatch = t.match(/每[隔个]?([零一二三四五六七八九十\d]+)分钟/)
  if (everyMinMatch) {
    const mins = parseChineseNum(everyMinMatch[1]!)
    if (mins !== null && mins > 0 && mins <= 60) {
      return {
        cronExpression: `0 */${mins} * * * *`,
        summary: `每 ${mins} 分钟`,
        kind: "cron",
      }
    }
  }

  return null
}
