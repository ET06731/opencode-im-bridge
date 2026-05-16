/**
 * Slash command handler for channel -> opencode bridge.
 *
 * Intercepts messages starting with "/" and routes them to
 * the appropriate opencode API endpoint instead of sending
 * them as plain text to the AI agent.
 */

import type { SessionManager } from "../session/session-manager.js"
import type { FeishuApiClient } from "../feishu/api-client.js"
import type { Logger } from "../utils/logger.js"
import type { SessionMapping } from "../types.js"
import { buildResponseCard, buildProjectSelectorCard, buildProjectCard, buildHelpCard, buildModelSelectorCard, buildAgentSelectorCard, buildVariantSelectorCard } from "../feishu/card-builder.js"
import { createTelegramInlineCard } from "../channel/telegram/telegram-interactive.js"
import { t, getLocale } from "../i18n/index.js"

import type { ChannelManager } from "../channel/manager.js"

import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { homedir } from "node:os"

import {
  listScheduledTasks,
  addScheduledTask,
  removeScheduledTask,
} from "../scheduled-task/store.js"
import {
  buildTaskListCard,
  buildTaskListText,
  buildTaskCreationCard,
  buildTaskPreviewCard,
  buildTaskRemoveCard,
} from "../scheduled-task/display.js"
import { tryParseSchedule, llmParseSchedule } from "../scheduled-task/llm-schedule-parser.js"
import { TaskCreationManager } from "../scheduled-task/creation-manager.js"
import { scheduledTaskRuntime } from "../scheduled-task/runtime.js"
import type { TaskDisplayItem, ScheduledTask } from "../scheduled-task/types.js"
import { CronJob } from "cron"

export interface CommandHandlerDeps {
  serverUrl: string
  sessionManager: SessionManager
  feishuClient: FeishuApiClient
  logger: Logger
  channelManager?: ChannelManager
}

export type CommandHandler = (
  feishuKey: string,
  chatId: string,
  messageId: string,
  commandText: string,
  channelId?: string,
) => Promise<boolean>

interface Session {
  id: string
  title?: string
}

interface AgentInfo {
  name: string
  description?: string
  mode: "subagent" | "primary" | "all"
}

interface VariantInfo {
  id: string
  name?: string
}

interface ProviderModelInfo {
  id: string
  providerId: string
  providerName: string
  modelName: string
  variants?: VariantInfo[]
}
interface ReplyCardPayload {
  text: string
  card: unknown
}

// Card builders removed - used centralized card-builder.ts instead



export function createCommandHandler(deps: CommandHandlerDeps): CommandHandler {
  const { serverUrl, sessionManager, feishuClient, logger } = deps

  const recentProviders = new Map<string, string[]>()

  const creationManagers = new Map<string, TaskCreationManager>()

  function recordProviderUsage(feishuKey: string, providerId: string): void {
    const recent = recentProviders.get(feishuKey) ?? []
    const filtered = recent.filter((p) => p !== providerId)
    recentProviders.set(feishuKey, [providerId, ...filtered].slice(0, 5))
  }

  function getPlugin(channelId: string) {
    return deps.channelManager?.getChannel(channelId as any)
  }

  async function replyText(
    chatId: string,
    messageId: string,
    text: string,
    channelId: string = "feishu",
  ): Promise<void> {
    const plugin = getPlugin(channelId)
    if (channelId === "telegram" && plugin?.outbound?.sendPlainText) {
      await plugin.outbound.sendPlainText({ address: chatId }, text)
      return
    }
    if (plugin?.outbound) {
      await plugin.outbound.sendText({ address: chatId }, text)
      return
    }

    await feishuClient.replyMessage(messageId, {
      msg_type: "text",
      content: JSON.stringify({ text }),
    })
  }

  async function replyCard(
    chatId: string,
    messageId: string,
    payload: ReplyCardPayload,
    channelId: string,
  ): Promise<void> {
    const plugin = getPlugin(channelId)
    if (plugin?.outbound?.sendCard) {
      await plugin.outbound.sendCard({ address: chatId }, payload.card)
      return
    }

    if (channelId === "feishu") {
      await feishuClient.replyMessage(messageId, {
        msg_type: "interactive",
        content: JSON.stringify(payload.card),
      })
      return
    }

    await replyText(chatId, messageId, payload.text, channelId)
  }

  function buildTelegramSessionCard(sessions: Session[], currentSessionId?: string) {
    return createTelegramInlineCard(
      `Current session: ${currentSessionId ?? "none"}\nChoose a session to connect:`,
      [
        ...sessions.slice(0, 8).map((session) => [{
          text: session.id === currentSessionId ? `• ${session.title || session.id}` : (session.title || session.id),
          payload: { action: "cmd" as const, command: `/connect ${session.id}` },
        }]),
        [{ text: "New Session", payload: { action: "cmd" as const, command: "/new" } }],
      ],
    )
  }

  interface ProjectInfo {
    id: string
    worktree: string
    name?: string
  }

  function buildTelegramProjectCard(projects: ProjectInfo[], currentWorktree?: string) {
    const normalizedCurrent = (currentWorktree || "").replace(/\\/g, "/").toLowerCase()
    const rows = projects.slice(0, 8).map((p) => {
      const name = p.name || p.worktree.split("/").pop() || p.worktree
      const isCurrent = p.worktree.replace(/\\/g, "/").toLowerCase() === normalizedCurrent
      return [{
        text: isCurrent ? `✓ ${name}` : name,
        payload: { action: "cmd" as const, command: `/projects ${name}` },
      }]
    })
    return createTelegramInlineCard(
      `Projects (${projects.length}):`,
      rows,
    )
  }

  function buildDiscordSessionCard(sessions: Session[], currentSessionId?: string) {
    const rows: Array<Array<{ text: string; command: string }>> = []
    const sessionRows = sessions.slice(0, 8).map((session) => ({
      text: session.id === currentSessionId ? `• ${session.title || session.id}` : (session.title || session.id),
      command: `/connect ${session.id}`,
    }))
    if (sessionRows.length > 0) rows.push(sessionRows)
    rows.push([{ text: "New Session", command: "/new" }])
    return { text: `Current session: ${currentSessionId ?? "none"}\nChoose a session to connect:`, rows }
  }

  function buildDiscordAgentCard(currentAgent: string, names: string[]) {
    return {
      text: `Current agent: ${currentAgent}\nChoose the agent to use:`,
      rows: names.slice(0, 8).map((name) => [{ text: name === currentAgent ? `• ${name}` : name, command: `/agent ${name}` }]),
    }
  }

  function buildDiscordModelCard(currentModelId: string | null | undefined, models: ProviderModelInfo[]) {
    return {
      text: `Current model: ${currentModelId ?? "unknown"}\nChoose the model to use:`,
      rows: models.slice(0, 8).map((model) => ({ text: model.id === currentModelId ? `• ${model.id}` : model.id, command: `/models ${model.id}` })),
    }
  }

  function buildDiscordRemoveCard(tasks: TaskDisplayItem[]) {
    const lines = tasks.map((t) => {
      const status = t.lastStatus === "success" ? "✅" : t.lastStatus === "error" ? "❌" : t.lastStatus === "running" ? "🔄" : "💤"
      const enabled = t.enabled ? "●" : "○"
      return `${enabled} ${status} *${t.name}*\n  ${t.scheduleSummary}\n  ID: ${t.id}`
    })
    const text = "🗑️ Delete Task\n\n" + lines.join("\n\n")
    return {
      text,
      rows: tasks.map((task) => ({ text: `🗑️ Delete: ${task.name}`, command: `/cron remove ${task.id}` })),
    }
  }

  function buildTelegramAgentCard(currentAgent: string, names: string[]) {
    return createTelegramInlineCard(
      `Current agent: ${currentAgent}\nChoose the agent to use:`,
      names.slice(0, 8).map((name) => [{
        text: name === currentAgent ? `• ${name}` : name,
        payload: { action: "cmd" as const, command: `/agent ${name}` },
      }]),
    )
  }

  function buildTelegramModelCard(currentModelId: string | null | undefined, models: ProviderModelInfo[]) {
    return createTelegramInlineCard(
      `Current model: ${currentModelId ?? "unknown"}\nChoose the model to use:`,
      models.slice(0, 8).map((model) => [{
        text: model.id === currentModelId ? `• ${model.id}` : model.id,
        payload: { action: "cmd" as const, command: `/models ${model.id}` },
      }]),
    )
  }

  function buildTelegramRemoveCard(tasks: TaskDisplayItem[]) {
    if (tasks.length === 0) {
      return createTelegramInlineCard("No tasks to delete.", [])
    }
    const lines = tasks.map((t) => {
      const status = t.lastStatus === "success" ? "✅" : t.lastStatus === "error" ? "❌" : t.lastStatus === "running" ? "🔄" : "💤"
      const enabled = t.enabled ? "●" : "○"
      return `${enabled} ${status} *${t.name}*\n  ${t.scheduleSummary}\n  ID: ${t.id}`
    })
    const text = "🗑️ Delete Task\n\n" + lines.join("\n\n")
    return createTelegramInlineCard(
      text,
      tasks.map((task) => [{
        text: `🗑️ Delete: ${task.name}`,
        payload: { action: "cmd" as const, command: `/cron remove ${task.id}` },
      }]),
    )
  }

  async function handleNew(
    feishuKey: string,
    chatId: string,
    messageId: string,
    channelId: string,
  ): Promise<void> {
    const resp = await fetch(`${serverUrl}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })

    if (!resp.ok) {
      throw new Error(`Failed to create session: HTTP ${resp.status}`)
    }

    const data = (await resp.json()) as { id: string }
    sessionManager.setMapping(feishuKey, data.id)
    logger.info(`/new: created session ${data.id}, bound to ${feishuKey}`)
    await replyText(chatId, messageId, t(getLocale(channelId), "command.newSession", { sessionId: data.id }), channelId)
  }

  async function handleCompact(
    feishuKey: string,
    chatId: string,
    messageId: string,
    channelId: string,
  ): Promise<void> {
    const locale = getLocale(channelId)
    const mapping = sessionManager.getSession(feishuKey)
    if (!mapping) {
      await replyText(chatId, messageId, t(locale, "command.noSessionBound"), channelId)
      return
    }

    await replyText(chatId, messageId, t(locale, "command.compacting"), channelId)

    const resp = await fetch(`${serverUrl}/session/${mapping.session_id}/prompt_async`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parts: [{ type: "text", text: "/compact", role: "user" }] }),
    })
    if (!resp.ok) {
      const errText = await resp.text()
      throw new Error(`Command compact failed: HTTP ${resp.status}, ${errText}`)
    }

    logger.info(`/compact: summarized session ${mapping.session_id}`)
    await replyText(chatId, messageId, t(locale, "command.compacted", { sessionId: mapping.session_id }), channelId)
  }

  async function handleShare(
    feishuKey: string,
    chatId: string,
    messageId: string,
    channelId: string,
  ): Promise<void> {
    const locale = getLocale(channelId)
    const mapping = sessionManager.getSession(feishuKey)
    if (!mapping) {
      await replyText(chatId, messageId, t(locale, "command.noSessionBound"), channelId)
      return
    }

    const resp = await fetch(`${serverUrl}/session/${mapping.session_id}/share`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })
    if (!resp.ok) {
      throw new Error(`Share failed: HTTP ${resp.status}`)
    }

    const data = (await resp.json()) as { share?: { url?: string } }
    const shareUrl = data.share?.url
    logger.info(`/share: shared session ${mapping.session_id}, url: ${shareUrl}`)
    if (shareUrl) {
      await replyText(chatId, messageId, t(locale, "command.sessionShared", { url: shareUrl }), channelId)
    } else {
      await replyText(chatId, messageId, t(locale, "command.sessionSharedWithId", { sessionId: mapping.session_id }), channelId)
    }
  }

  async function handleUnshare(
    feishuKey: string,
    chatId: string,
    messageId: string,
    channelId: string,
  ): Promise<void> {
    const locale = getLocale(channelId)
    const mapping = sessionManager.getSession(feishuKey)
    if (!mapping) {
      await replyText(chatId, messageId, t(locale, "command.noSessionBound"), channelId)
      return
    }

    const resp = await fetch(`${serverUrl}/session/${mapping.session_id}/share`, {
      method: "DELETE",
    })
    if (!resp.ok) {
      throw new Error(`Unshare failed: HTTP ${resp.status}`)
    }

    logger.info(`/unshare: unshared session ${mapping.session_id}`)
    await replyText(chatId, messageId, t(locale, "command.shareCanceled", { sessionId: mapping.session_id }), channelId)
  }

  async function handleRename(
    feishuKey: string,
    chatId: string,
    messageId: string,
    channelId: string,
    args: string[],
  ): Promise<void> {
    const locale = getLocale(channelId)
    const mapping = sessionManager.getSession(feishuKey)
    if (!mapping) {
      await replyText(chatId, messageId, t(locale, "command.noSessionBound"), channelId)
      return
    }

    const newName = args.join(" ").trim()
    if (!newName) {
      await replyText(chatId, messageId, t(locale, "command.renameUsage"), channelId)
      return
    }

    const resp = await fetch(`${serverUrl}/session/${mapping.session_id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: newName }),
    })
    if (!resp.ok) {
      throw new Error(`Rename failed: HTTP ${resp.status}`)
    }

    logger.info(`/rename: renamed session ${mapping.session_id} to "${newName}"`)
    await replyText(chatId, messageId, t(locale, "command.renameSuccess", { name: newName }), channelId)
  }

  async function handleAbort(
    feishuKey: string,
    chatId: string,
    messageId: string,
    channelId: string,
  ): Promise<void> {
    const locale = getLocale(channelId)
    const mapping = sessionManager.getSession(feishuKey)
    if (!mapping) {
      await replyText(chatId, messageId, t(locale, "command.noSessionBound"), channelId)
      return
    }

    const resp = await fetch(`${serverUrl}/session/${mapping.session_id}/abort`, { method: "POST" })
    if (!resp.ok) {
      throw new Error(`Abort failed: HTTP ${resp.status}`)
    }

    logger.info(`/abort: aborted session ${mapping.session_id}`)
    await replyText(chatId, messageId, t(locale, "command.sessionAborted", { sessionId: mapping.session_id }), channelId)
  }

  async function handleSessions(
    feishuKey: string,
    chatId: string,
    messageId: string,
    channelId: string,
  ): Promise<void> {
    const locale = getLocale(channelId)
    const resp = await fetch(`${serverUrl}/session`)
    if (!resp.ok) {
      throw new Error(`List sessions failed: HTTP ${resp.status}`)
    }

    const sessions = (await resp.json()) as Session[]
    if (sessions.length === 0) {
      await replyText(chatId, messageId, t(locale, "command.noSessions"), channelId)
      return
    }

    const currentSessionId = await sessionManager.getExisting(feishuKey)
    if (currentSessionId) {
      const existingIndex = sessions.findIndex((session) => session.id === currentSessionId)
      if (existingIndex >= 0) {
        const current = sessions.splice(existingIndex, 1)[0]
        if (current) sessions.unshift(current)
      } else {
        sessions.unshift({ id: currentSessionId, title: t(locale, "status.session") })
      }
    }

    if (channelId === "telegram") {
      const telegramCard = buildTelegramSessionCard(sessions, currentSessionId)
      if (telegramCard) {
        await replyCard(chatId, messageId, {
          text: sessions.slice(0, 10).map((session) => `- ${session.title || session.id} (${session.id})`).join("\n"),
          card: telegramCard,
        }, channelId)
        return
      }
    }

    if (channelId === "discord") {
      const discordCard = buildDiscordSessionCard(sessions, currentSessionId)
      await replyCard(chatId, messageId, {
        text: sessions.slice(0, 10).map((session) => `- ${session.title || session.id} (${session.id})`).join("\n"),
        card: discordCard,
      }, channelId)
      return
    }

    if (channelId !== "feishu") {
      const sessionList = sessions.slice(0, 10).map((session) => `- ${session.title || session.id} (\`${session.id}\`)`).join("\n")
      await replyText(chatId, messageId, t(locale, "command.recentSessions", { sessions: sessionList }), channelId)
      return
    }

    const card = buildProjectSelectorCard(sessions, currentSessionId)
    await replyCard(chatId, messageId, {
      text: sessions.slice(0, 10).map((session) => `- ${session.title || session.id} (${session.id})`).join("\n"),
      card,
    }, channelId)
  }

  async function handleConnect(
    feishuKey: string,
    chatId: string,
    messageId: string,
    targetSessionId: string,
    channelId: string,
  ): Promise<void> {
    const locale = getLocale(channelId)
    const checkResp = await fetch(`${serverUrl}/session/${targetSessionId}`)
    if (!checkResp.ok) {
      await replyText(chatId, messageId, t(locale, "command.sessionNotFound"), channelId)
      return
    }

    const success = sessionManager.setMapping(feishuKey, targetSessionId)
    if (!success) {
      throw new Error("Failed to set session mapping")
    }

    logger.info(`/connect: bound ${feishuKey} to session ${targetSessionId}`)
    await replyText(chatId, messageId, t(locale, "command.connectedToSession", { sessionId: targetSessionId }), channelId)
  }

  async function handleSessionCommand(
    feishuKey: string,
    chatId: string,
    messageId: string,
    command: string,
    channelId: string,
  ): Promise<void> {
    const locale = getLocale(channelId)
    const mapping = sessionManager.getSession(feishuKey)
    if (!mapping) {
      await replyText(chatId, messageId, t(locale, "command.noSessionBound"), channelId)
      return
    }

    const resp = await fetch(`${serverUrl}/session/${mapping.session_id}/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command, arguments: "" }),
    })
    if (!resp.ok) {
      throw new Error(`Command ${command} failed: HTTP ${resp.status}`)
    }

    logger.info(`/${command}: executed on session ${mapping.session_id}`)
    await replyText(chatId, messageId, t(locale, "command.executing", { command, sessionId: mapping.session_id }), channelId)
  }

  async function handleProjects(
    feishuKey: string,
    chatId: string,
    messageId: string,
    channelId: string,
    args: string[],
  ): Promise<void> {
    const locale = getLocale(channelId)

    if (args[0]) {
      const targetProjectArg = args.join(" ").trim()
      const resp = await fetch(`${serverUrl}/project`)
      if (!resp.ok) {
        throw new Error(`List projects failed: HTTP ${resp.status}`)
      }

      const projects = (await resp.json()) as ProjectInfo[]
      const normalizedArg = targetProjectArg.replace(/\\/g, "/").toLowerCase()

      const matched = projects.find((p) => {
        const name = p.name || p.worktree.split("/").pop() || p.worktree
        const normalizedName = name.replace(/\\/g, "/").toLowerCase()
        const normalizedWorktree = p.worktree.replace(/\\/g, "/").toLowerCase()
        return normalizedName === normalizedArg || normalizedWorktree === normalizedArg || p.id === normalizedArg
      })

      if (!matched) {
        await replyText(chatId, messageId, t(locale, "command.projectCreating", { project: targetProjectArg }), channelId)

        const baseDir = process.env.OPENCODE_CWD || process.cwd()
        const newProjectDir = `${baseDir}/${targetProjectArg}`

        const createResp = await fetch(`${serverUrl}/session?directory=${encodeURIComponent(newProjectDir)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: targetProjectArg }),
        })

        if (!createResp.ok) {
          const errText = await createResp.text()
          await replyText(chatId, messageId, t(locale, "command.projectCreateFailed", { project: targetProjectArg, error: errText }), channelId)
          return
        }

        const newData = (await createResp.json()) as { id: string; directory?: string }
        process.env.OPENCODE_CWD = newData.directory || newProjectDir
        sessionManager.setMapping(feishuKey, newData.id)
        logger.info(`/projects: created and switched to project "${targetProjectArg}" (${newData.directory || newProjectDir})`)
        await replyText(chatId, messageId, t(locale, "command.projectCreated", { project: targetProjectArg, sessionId: newData.id }), channelId)
        return
      }

      process.env.OPENCODE_CWD = matched.worktree
      logger.info(`/projects: switched to project "${matched.name || matched.worktree}" (${matched.worktree})`)

      const newSessionResp = await fetch(`${serverUrl}/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: matched.id }),
      })

      if (newSessionResp.ok) {
        const data = (await newSessionResp.json()) as { id: string }
        sessionManager.setMapping(feishuKey, data.id)
        await replyText(chatId, messageId, t(locale, "command.projectSwitched", { project: matched.name || matched.worktree, sessionId: data.id }), channelId)
      } else {
        await replyText(chatId, messageId, t(locale, "command.projectSwitchedNoSession", { project: matched.name || matched.worktree }), channelId)
      }
      return
    }

    const resp = await fetch(`${serverUrl}/project`)
    if (!resp.ok) {
      throw new Error(`List projects failed: HTTP ${resp.status}`)
    }

    const projects = (await resp.json()) as ProjectInfo[]
    if (projects.length === 0) {
      await replyText(chatId, messageId, t(locale, "command.noProjects"), channelId)
      return
    }

    const currentWorktree = process.env.OPENCODE_CWD || process.cwd()

    if (channelId === "telegram") {
      const telegramCard = buildTelegramProjectCard(projects, currentWorktree)
      if (telegramCard) {
        const projectList = projects.slice(0, 10).map((p) => {
          const name = p.name || p.worktree.split("/").pop() || p.worktree
          return `- ${name}`
        }).join("\n")
        await replyCard(chatId, messageId, {
          text: `📂 *Projects*\n\n${projectList}\n\n💡 Tap a button to switch`,
          card: telegramCard,
        }, channelId)
        return
      }
    }

    const card = buildProjectCard(projects, currentWorktree)
    await replyCard(chatId, messageId, {
      text: projects.slice(0, 10).map((p) => {
        const name = p.name || p.worktree.split("/").pop() || p.worktree
        return `- ${name}`
      }).join("\n"),
      card,
    }, channelId)
  }

  async function handleHelp(
    chatId: string,
    messageId: string,
    channelId: string,
  ): Promise<void> {
    const locale = getLocale(channelId)
    if (channelId !== "feishu") {
      const helpText = `**${t(locale, "help.title")}**

\`/new\` - ${t(locale, "help.new")}
\`/sessions\` - ${t(locale, "help.sessions")}
\`/projects\` - ${t(locale, "help.projects")}
\`/status\` - ${t(locale, "help.status")}
\`/compact\` - ${t(locale, "help.compact")}
\`/share\` - ${t(locale, "help.share")}
\`/unshare\` - ${t(locale, "help.unshare")}
\`/rename\` - ${t(locale, "help.rename")}
\`/abort\` - ${t(locale, "help.abort")}
\`/agent\` - ${t(locale, "help.agent")}
\`/models\` - ${t(locale, "help.models")}
\`/cron\` - ${t(locale, "help.cron")}
\`/help\` - ${t(locale, "help.help")}`
      await replyText(chatId, messageId, helpText, channelId)
      return
    }

    const card = buildHelpCard()
    await replyCard(chatId, messageId, {
      text: "Use /new, /sessions, /projects, /agent, /models, /compact, /share, /abort, /help",
      card,
    }, channelId)
  }

  async function handleCron(
    feishuKey: string,
    chatId: string,
    messageId: string,
    channelId: string,
    args: string[],
  ): Promise<void> {
    const locale = getLocale(channelId)
    const sub = args[0]?.toLowerCase()

    if (sub === "list") {
      const tasks = await listScheduledTasks()
      const displayItems: TaskDisplayItem[] = tasks.map((task) => ({
        id: task.id,
        name: task.name,
        prompt: task.prompt,
        scheduleSummary: task.scheduleSummary,
        nextRunAt: task.nextRunAt,
        lastRunAt: task.lastRunAt,
        lastStatus: task.lastStatus,
        enabled: task.enabled,
      }))

      const text = channelId === "feishu"
        ? buildTaskListCard(displayItems, locale)
        : buildTaskListText(displayItems, locale)
      await replyText(chatId, messageId, text, channelId)
      return
    }

    if (sub === "remove") {
      const taskId = args[1]
      if (taskId) {
        const success = await removeScheduledTask(taskId)
        scheduledTaskRuntime.removeTask(taskId)
        await replyText(chatId, messageId, t(locale, success ? "command.cronJobRemoved" : "command.cronJobNotFound", { jobId: taskId }), channelId)
        return
      }

      const tasks = await listScheduledTasks()
      const displayItems: TaskDisplayItem[] = tasks.map((task) => ({
        id: task.id,
        name: task.name,
        prompt: task.prompt,
        scheduleSummary: task.scheduleSummary,
        nextRunAt: task.nextRunAt,
        lastRunAt: task.lastRunAt,
        lastStatus: task.lastStatus,
        enabled: task.enabled,
      }))

      if (channelId === "feishu") {
        const card = buildTaskRemoveCard(displayItems, locale)
        await replyCard(chatId, messageId, { card, text: "" }, channelId)
      } else if (channelId === "telegram") {
        const card = buildTelegramRemoveCard(displayItems)
        if (card) {
          await replyCard(chatId, messageId, { card, text: card.text }, channelId)
        } else {
          await replyText(chatId, messageId, "No tasks to delete.", channelId)
        }
      } else if (channelId === "discord") {
        const card = buildDiscordRemoveCard(displayItems)
        await replyCard(chatId, messageId, { card, text: card.text }, channelId)
      } else {
        await replyText(chatId, messageId, buildTaskListText(displayItems, locale), channelId)
      }
      return
    }

    if (sub === "confirm" || sub === "reject") {
      const manager = creationManagers.get(feishuKey)
      if (!manager) {
        await replyText(chatId, messageId, t(locale, "scheduledTask.creation.notInCreationFlow"), channelId)
        return
      }

      const state = manager.getState()
      if (!state || (state.stage !== "preview" && state.stage !== "confirming")) {
        await replyText(chatId, messageId, t(locale, "scheduledTask.creation.notInCreationFlow"), channelId)
        return
      }

      if (sub === "reject") {
        manager.clear()
        creationManagers.delete(feishuKey)
        await replyText(chatId, messageId, t(locale, "scheduledTask.creation.cancelled"), channelId)
        return
      }

      // confirm: create and save the task
      const { parsedSchedule, prompt, model, agent, projectId, projectWorktree, sessionId } = state
      if (!parsedSchedule || !prompt) {
        await replyText(chatId, messageId, t(locale, "scheduledTask.creation.missingData"), channelId)
        return
      }

      const taskId = Math.random().toString(36).substring(2, 9)
      const newTask = await addScheduledTask({
        id: taskId,
        name: parsedSchedule.summary,
        kind: parsedSchedule.kind,
        prompt,
        schedule: state.scheduleText ?? "",
        scheduleSummary: parsedSchedule.summary,
        cronExpression: parsedSchedule.cronExpression,
        model: model ?? { providerID: "", modelID: "" },
        agent: agent ?? "build",
        projectId: projectId ?? "",
        projectWorktree: projectWorktree ?? "",
        enabled: true,
        sessionId: sessionId ?? undefined,
        runAt: parsedSchedule.runAt,
        nextRunAt: null,
        lastRunAt: null,
        lastStatus: "idle",
        lastError: null,
        runCount: 0,
        createdAt: new Date().toISOString(),
        channelId,
        chatId,
      })

      scheduledTaskRuntime.registerTask(newTask)
      creationManagers.delete(feishuKey)

      await replyText(chatId, messageId, t(locale, "scheduledTask.creation.successWithId", { taskId: newTask.id }), channelId)
      return
    }

    // "add" subcommand — or natural language shortcut: /cron <description>
    // Supports:
    //   /cron add                       → interactive wizard (no inline input)
    //   /cron add 每天19:10提醒我吃饭   → inline parse + LLM fallback
    //   /cron 每天19:10提醒我吃饭       → same, auto-detected by non-keyword sub
    const isAddExplicit = sub === "add"
    const isNaturalLanguage = sub !== undefined
      && sub !== "list"
      && sub !== "remove"
      && sub !== "add"

    if (isAddExplicit || isNaturalLanguage) {
      const mapping = sessionManager.getSession(feishuKey)
      if (!mapping) {
        await replyText(chatId, messageId, t(locale, "command.noSessionBound"), channelId)
        return
      }

      let manager = creationManagers.get(feishuKey)
      if (!manager) {
        manager = new TaskCreationManager(logger)
        creationManagers.set(feishuKey, manager)
      }

      const projectId = process.env.OPENCODE_CWD || "default"
      const model = mapping.model
        ? { providerID: mapping.model.split("/")[0] || "", modelID: mapping.model.split("/")[1] || "" }
        : { providerID: "", modelID: "" }
      manager.start(projectId, projectId, model, mapping.agent || "build", mapping.session_id)

      // Collect the inline description text
      const inlineInput = isNaturalLanguage
        ? args.join(" ").trim()               // whole args is description (no 'add' prefix)
        : args.slice(1).join(" ").trim()      // args after 'add'

      if (!inlineInput) {
        // No inline input → show wizard prompt, wait for next message
        const state = manager.getState()
        if (state) {
          const result = buildTaskCreationCard(state.stage, state, locale, channelId)
          if (typeof result === "object") {
            await replyCard(chatId, messageId, { card: result, text: "" }, channelId)
          } else {
            await replyText(chatId, messageId, result, channelId)
          }
        }
        return
      }

      // Fast path: try regex parser first
      const fastParsed = tryParseSchedule(inlineInput)
      if (fastParsed) {
        manager.setSchedule(inlineInput, fastParsed)
        // 从输入中提取时间后面的文本作为任务描述
        const prompt = extractPromptFromInput(inlineInput)
        if (prompt) {
          manager.setPrompt(prompt)
        }
        const state = manager.getState()
        if (state) {
          const result = buildTaskCreationCard(state.stage, state, locale, channelId)
          if (typeof result === "object") {
            await replyCard(chatId, messageId, { card: result, text: "" }, channelId)
          } else {
            await replyText(chatId, messageId, result, channelId)
          }
        }
        return
      }

      // Slow path: LLM parsing
      await replyText(chatId, messageId, "🤔 正在理解你的描述...", channelId)
      try {
        const llmParsed = await llmParseSchedule(serverUrl, inlineInput, new Date().toISOString())
        manager.setSchedule(inlineInput, llmParsed)

        // If LLM extracted a task prompt, pre-fill it and skip awaiting_prompt stage
        if (llmParsed.taskPrompt) {
          manager.setPrompt(llmParsed.taskPrompt)
        }

        const state = manager.getState()
        if (state) {
          const result = buildTaskCreationCard(state.stage, state, locale, channelId)
          if (typeof result === "object") {
            await replyCard(chatId, messageId, { card: result, text: "" }, channelId)
          } else {
            await replyText(chatId, messageId, result, channelId)
          }
        }
      } catch (err) {
        logger.warn(`[handleCron] LLM schedule parse failed: ${err}`)
        await replyText(
          chatId,
          messageId,
          `⚠️ 无法理解 "${inlineInput}"，请尝试更具体的描述，例如：\n• /cron 每天19:00提醒我吃饭\n• /cron 每周三14:30开会提醒\n• /cron 每2小时检查一次`,
          channelId,
        )
        manager.clear()
        creationManagers.delete(feishuKey)
      }
      return
    }

    if (sub === undefined) {
      const tasks = await listScheduledTasks()
      const displayItems: TaskDisplayItem[] = tasks.map((task) => ({
        id: task.id,
        name: task.name,
        scheduleSummary: task.scheduleSummary,
        nextRunAt: task.nextRunAt,
        lastRunAt: task.lastRunAt,
        lastStatus: task.lastStatus,
        enabled: task.enabled,
      }))

      const text = channelId === "feishu"
        ? buildTaskListCard(displayItems, locale)
        : buildTaskListText(displayItems, locale)
      await replyText(chatId, messageId, text, channelId)
      return
    }

    await replyText(chatId, messageId, t(locale, "command.cronSubcommands"), channelId)
  }

  async function handleAgent(
    feishuKey: string,
    chatId: string,
    messageId: string,
    channelId: string,
    args: string[],
  ): Promise<void> {
    const locale = getLocale(channelId)
    const mapping = sessionManager.getSession(feishuKey)
    if (!mapping) {
      await replyText(chatId, messageId, t(locale, "command.noSessionBound"), channelId)
      return
    }

    const resp = await fetch(`${serverUrl}/agent`)
    if (!resp.ok) {
      throw new Error(`List agents failed: HTTP ${resp.status}`)
    }

    const agents = (await resp.json()) as AgentInfo[]
    const available = agents.filter((agent) => agent.mode === "primary" || agent.mode === "all")
    const names = available.map((agent) => agent.name)
    const current = mapping.agent || "build"
    const targetRaw = args[0]

    if (!targetRaw || targetRaw.toLowerCase() === "list") {
      const listText = names.length
        ? names.map((name) => (name.toLowerCase() === current.toLowerCase() ? `✓ ${name}` : `- ${name}`)).join("\n")
        : "No agents available"

      if (channelId === "telegram") {
        const telegramCard = buildTelegramAgentCard(current, names)
        if (telegramCard) {
          await replyCard(chatId, messageId, {
            text: `Current agent: ${current}\n\nAvailable agents:\n${listText}`,
            card: telegramCard,
          }, channelId)
          return
        }
      }

      if (channelId === "discord") {
        const discordCard = buildDiscordAgentCard(current, names)
        await replyCard(chatId, messageId, {
          text: `Current agent: ${current}\n\nAvailable agents:\n${listText}`,
          card: discordCard,
        }, channelId)
        return
      }

      if (channelId === "feishu") {
        const card = buildAgentSelectorCard(names, current)
        await replyCard(chatId, messageId, {
          text: listText,
          card,
        }, channelId)
        return
      }

      await replyText(
        chatId,
        messageId,
        `**Current agent:** ${current}\n\n**Available agents:**\n${listText}\n\n💡 Usage: \`/agent {name}\``,
        channelId,
      )
      return
    }

    const normalize = (n: string) => n.replace(/\s*\([^)]*\)/, "").replace(/\s+/g, " ").trim().toLowerCase()
    const normalizedTarget = normalize(targetRaw)

    const matched = names.find((name) => name.toLowerCase() === targetRaw.toLowerCase() || normalize(name) === normalizedTarget)

    if (!matched) {
      const listText = names.length ? names.join(", ") : "none"
      await replyText(chatId, messageId, t(locale, "command.agentNotFound", { agent: targetRaw, list: listText }), channelId)
      return
    }

    sessionManager.setMapping(feishuKey, mapping.session_id, matched)
    await replyText(chatId, messageId, t(locale, "command.agentSwitched", { agent: matched }), channelId)
  }

  async function listModels(feishuKey: string): Promise<ProviderModelInfo[]> {
    const resp = await fetch(`${serverUrl}/provider`)
    if (!resp.ok) {
      throw new Error(`List models failed: HTTP ${resp.status}`)
    }

    const data = (await resp.json()) as {
      all?: Array<{
        id: string
        name: string
        models?: Record<string, { id?: string; name?: string; variants?: Array<{ id?: string; name?: string }> }>
      }>
      connected?: string[]
    }

    const allProviders = data.all ?? []
    const connectedIds = new Set(data.connected ?? [])

    let availableProviders =
      connectedIds.size > 0
        ? allProviders.filter((provider) => connectedIds.has(provider.id))
        : allProviders

    const junkProviders = ["test", "mock", "fake", "dummy", "placeholder"]
    availableProviders = availableProviders.filter(
      (p) => !junkProviders.some((j) => p.id.toLowerCase().includes(j)),
    )

    const recent = recentProviders.get(feishuKey) ?? []
    const { favorites, recent: fileRecent } = await getFavoriteAndRecentFromFile()

    return availableProviders
      .flatMap((provider) =>
        Object.entries(provider.models ?? {}).map(([modelKey, model]) => {
          const modelId = model.id ?? modelKey
          const baseId = `${provider.id}/${modelId}`
          return {
            id: baseId,
            providerId: provider.id,
            providerName: provider.name,
            modelName: model.name ?? modelId,
            variants: model.variants ? Object.entries(model.variants).map(([variantKey, variant]: [string, any]) => ({
              id: `${baseId}#${variantKey}`,
              name: variant.name ?? variantKey,
              key: variantKey,
            })) : [],
          }
        }),
      )
      .sort((a, b) => {
        // 1. Favorites from model.json first (preserve order)
        const aFav = favorites.indexOf(a.id)
        const bFav = favorites.indexOf(b.id)
        if (aFav !== -1 && bFav !== -1) return aFav - bFav
        if (aFav !== -1) return -1
        if (bFav !== -1) return 1
        // 2. Recent from model.json second (preserve order)
        const aRecent = fileRecent.indexOf(a.id)
        const bRecent = fileRecent.indexOf(b.id)
        if (aRecent !== -1 && bRecent !== -1) return aRecent - bRecent
        if (aRecent !== -1) return -1
        if (bRecent !== -1) return 1
        // 3. Per-feishuKey recent usage third
        const aRecentProvider = recent.indexOf(a.providerId)
        const bRecentProvider = recent.indexOf(b.providerId)
        if (aRecentProvider !== -1 && bRecentProvider !== -1) return aRecentProvider - bRecentProvider
        if (aRecentProvider !== -1) return -1
        if (bRecentProvider !== -1) return 1
        // 4. Alphabetical by provider name
        return a.providerName.localeCompare(b.providerName)
      })
  }

  async function listVariants(providerId: string, modelId: string): Promise<VariantInfo[]> {
    try {
      const resp = await fetch(`${serverUrl}/provider`)
      if (!resp.ok) {
        return []
      }

      const data = (await resp.json()) as {
        all?: Array<{
          id: string
          models?: Record<string, { variants?: Record<string, { name?: string }> }>
        }>
      }

      const provider = (data.all ?? []).find(p => p.id === providerId)
      if (!provider) return []

      const model = provider.models?.[modelId] ?? provider.models?.[modelId.split('/').pop() || '']
      if (!model || !model.variants) return []

      return Object.entries(model.variants).map(([variantKey, variant]) => ({
        id: `${providerId}/${modelId}#${variantKey}`,
        name: variant?.name ?? variantKey,
        key: variantKey,
      }))
    } catch {
      return []
    }
  }

  function detectCurrentModel(mapping: SessionMapping | null): string | undefined {
    return mapping?.model ?? undefined
  }

  async function getFavoriteAndRecentFromFile(): Promise<{ favorites: string[], recent: string[] }> {
    try {
      const home = homedir()
      const statePath = join(home, ".local", "state", "opencode", "model.json")
      const content = await readFile(statePath, "utf-8")
      const state = JSON.parse(content) as {
        favorite?: Array<{ providerID?: string; modelID?: string }>
        recent?: Array<{ providerID?: string; modelID?: string }>
      }
      const favorites = (state?.favorite ?? [])
        .map(f => f.providerID && f.modelID ? `${f.providerID}/${f.modelID}` : "")
        .filter(Boolean)
      const recent = (state?.recent ?? [])
        .map(r => r.providerID && r.modelID ? `${r.providerID}/${r.modelID}` : "")
        .filter(Boolean)
      return { favorites, recent }
    } catch {
      return { favorites: [], recent: [] }
    }
  }

  async function getCurrentModelFromFile(): Promise<string | undefined> {
    const { favorites, recent } = await getFavoriteAndRecentFromFile()
    if (favorites.length > 0) return favorites[0]
    if (recent.length > 0) return recent[0]
    return undefined
  }

  async function handleModels(
    feishuKey: string,
    chatId: string,
    messageId: string,
    channelId: string,
    args: string[],
  ): Promise<void> {
    const locale = getLocale(channelId)
    const mapping = sessionManager.getSession(feishuKey)
    if (!mapping) {
      await replyText(chatId, messageId, t(locale, "command.noSessionBound"), channelId)
      return
    }

    const models = await listModels(feishuKey)
    const targetRaw = args[0]

    if (!targetRaw || targetRaw.toLowerCase() === "list") {
      const fileModelId = await getCurrentModelFromFile()
      const localModelId = detectCurrentModel(mapping)
      const currentModelId = fileModelId ?? localModelId

      if (channelId === "telegram") {
        const telegramCard = buildTelegramModelCard(currentModelId, models)
        if (telegramCard) {
          const text = models.length ? models.map((model) => `- ${model.id}`).join("\n") : "No models available"
          await replyCard(chatId, messageId, {
            text: `Current model: ${currentModelId ?? "unknown"}\n\nAvailable models:\n${text}`,
            card: telegramCard,
          }, channelId)
          return
        }
      }

      if (channelId === "discord") {
        const discordCard = buildDiscordModelCard(currentModelId, models)
        const text = models.length ? models.map((model) => `- ${model.id}`).join("\n") : "No models available"
        await replyCard(chatId, messageId, {
          text: `Current model: ${currentModelId ?? "unknown"}\n\nAvailable models:\n${text}`,
          card: discordCard,
        }, channelId)
        return
      }

      if (channelId === "feishu") {
        const card = buildModelSelectorCard(models, currentModelId)
        await replyCard(chatId, messageId, {
          text: models.map((model) => model.id).join("\n"),
          card,
        }, channelId)
        return
      }

      const listText = models.length
        ? models
          .map((model) => (model.id === currentModelId ? `* ${model.id}` : `- ${model.id}`))
          .join("\n")
        : "No models available"
      await replyText(
        chatId,
        messageId,
        `**Current model:** ${currentModelId ?? "unknown"}\n\n**Available models:**\n${listText}\n\n💡 Usage: \`/models {provider/model}\``,
        channelId,
      )
      return
    }

    const matched = models.find((model) => model.id.toLowerCase() === targetRaw.toLowerCase())
    if (!matched) {
      const listText = models.length ? models.map((model) => model.id).join(", ") : "none"
      await replyText(chatId, messageId, t(locale, "command.modelNotFound", { model: targetRaw, list: listText }), channelId)
      return
    }

    try {
      const home = homedir()
      const statePath = join(home, ".local", "state", "opencode", "model.json")
      const stateContent = await readFile(statePath, "utf-8").catch(() => '{"favorite":[],"recent":[]}')
      const state = JSON.parse(stateContent) as {
        favorite?: Array<{ providerID: string; modelID: string }>
        recent?: Array<{ providerID: string; modelID: string }>
      }

      const [providerID, modelID] = matched.id.split("/")
      if (providerID && modelID) {
        state.favorite = [{ providerID, modelID }]
        state.recent = state.recent?.filter(
          (m) => !(m.providerID === providerID && m.modelID === modelID),
        ) ?? []
        state.recent.unshift({ providerID, modelID })
        state.recent = state.recent.slice(0, 10)

        await writeFile(statePath, JSON.stringify(state, null, 2))
      }
    } catch (err) {
      logger.warn(`Failed to write model.json: ${err}`)
    }

    sessionManager.setModel(feishuKey, matched.id)
    recordProviderUsage(feishuKey, matched.providerId)

    if (matched.variants && matched.variants.length > 0) {
      if (channelId === "feishu") {
        const card = buildVariantSelectorCard(matched.variants, matched.id)
        await replyCard(chatId, messageId, {
          text: `Model switched to ${matched.id}. Available variants:\n${matched.variants.map(v => v.id).join("\n")}`,
          card,
        }, channelId)
        return
      }
    }

    await replyText(chatId, messageId, t(locale, "command.modelSwitched", { model: matched.id }), channelId)
  }

  async function handleVariants(
    feishuKey: string,
    chatId: string,
    messageId: string,
    channelId: string,
    args: string[],
  ): Promise<void> {
    const locale = getLocale(channelId)
    const mapping = sessionManager.getSession(feishuKey)
    if (!mapping) {
      await replyText(chatId, messageId, t(locale, "command.noSessionBound"), channelId)
      return
    }

    const currentModelId = await getCurrentModelFromFile() ?? detectCurrentModel(mapping)
    if (!currentModelId) {
      await replyText(chatId, messageId, t(locale, "command.noModelSet"), channelId)
      return
    }

    const [providerId, ...restParts] = currentModelId.split("/")
    const modelWithVariant = restParts.join("/")
    const [modelId, _currentVariant] = modelWithVariant.split("#")

    if (!providerId || !modelId) {
      await replyText(chatId, messageId, t(locale, "command.invalidModelId"), channelId)
      return
    }

    const variants = await listVariants(providerId, modelId)

    if (variants.length === 0) {
      await replyText(chatId, messageId, t(locale, "command.noVariants"), channelId)
      return
    }

    const targetRaw = args[0]
    if (targetRaw) {
      const matched = variants.find(v => v.id.toLowerCase() === targetRaw.toLowerCase())
      if (!matched) {
        await replyText(chatId, messageId, t(locale, "command.variantNotFound", { variant: targetRaw }), channelId)
        return
      }

      try {
        const home = homedir()
        const statePath = join(home, ".local", "state", "opencode", "model.json")
        const stateContent = await readFile(statePath, "utf-8").catch(() => '{"favorite":[],"recent":[]}')
        const state = JSON.parse(stateContent) as {
          favorite?: Array<{ providerID: string; modelID: string }>
        }

      if (state.favorite && state.favorite.length > 0) {
        const [_prov, ...rest] = matched.id.split("/")
        const modelWithVariant = rest.join("/")
        const firstFavorite = state.favorite[0]
        if (firstFavorite) {
          firstFavorite.modelID = modelWithVariant
          await writeFile(statePath, JSON.stringify(state, null, 2))
        }
      }
      } catch (err) {
        logger.warn(`Failed to write model.json for variant: ${err}`)
      }

      sessionManager.setModel(feishuKey, matched.id)
      await replyText(chatId, messageId, t(locale, "command.variantSwitched", { variant: matched.id }), channelId)
      return
    }


    if (channelId === "feishu") {
      const card = buildVariantSelectorCard(variants, currentModelId)
      await replyCard(chatId, messageId, {
        text: `Current model: ${currentModelId}\n\nAvailable variants:\n${variants.map(v => v.id).join("\n")}`,
        card,
      }, channelId)
      return
    }

    const listText = variants.map((v, i) => `- ${v.id}`).join("\n")
    await replyText(
      chatId,
      messageId,
      `**Current model:** ${currentModelId}\n\n**Available variants:**\n${listText}\n\n💡 Usage: \`/variants {variant}\``,
      channelId,
    )
  }

  async function handleStatus(
    feishuKey: string,
    chatId: string,
    messageId: string,
    channelId: string,
  ): Promise<void> {
    const locale = getLocale(channelId)
    const lines: string[] = []

    let serverHealthy = false
    try {
      const healthResp = await fetch(`${serverUrl}/global/health`)
      if (healthResp.ok) {
        const data = (await healthResp.json()) as { healthy?: boolean; version?: string }
        serverHealthy = data.healthy === true
        lines.push(serverHealthy ? t(locale, "status.serverOnline") : t(locale, "status.serverOffline"))
        if (data.version) lines.push(t(locale, "status.serverVersion", { version: data.version }))
      } else {
        lines.push(t(locale, "status.cannotConnect"))
      }
    } catch {
      lines.push(t(locale, "status.cannotConnect"))
    }

    const modelStr = await getCurrentModelFromFile()
    if (modelStr) {
      lines.push(t(locale, "status.model", { model: modelStr }))
    } else {
      lines.push(t(locale, "status.modelUnconfigured"))
    }

    const mapping = sessionManager.getSession(feishuKey)
    if (mapping) {
      lines.push(t(locale, "status.sessionBound", { sessionId: mapping.session_id }))
      lines.push(t(locale, "status.agent", { agent: mapping.agent }))

      try {
        const sessionResp = await fetch(`${serverUrl}/session/${mapping.session_id}`)
        if (sessionResp.ok) {
          const sessionData = (await sessionResp.json()) as {
            title?: string
          }
          if (sessionData.title) lines.push(t(locale, "status.sessionTitle", { title: sessionData.title }))
        }
      } catch {
        // Session info fetch failed — not critical
      }

      let contextUsed = 0
      let contextLimit = 0

      try {
        const cwd = process.env.OPENCODE_CWD || process.cwd()
        const msgsResp = await fetch(`${serverUrl}/session/${mapping.session_id}/message?limit=1000`, {
          headers: { "x-opencode-directory": cwd },
        })
        if (msgsResp.ok) {
          const messages = JSON.parse(await msgsResp.text()) as Array<{
            info?: {
              role?: string
              summary?: boolean
              tokens?: {
                input?: number
                cache?: { read?: number }
              }
            }
          }>
          for (const msg of messages) {
            if (msg.info?.role === "assistant" && !msg.info?.summary) {
              const tokens = msg.info?.tokens
              if (tokens) {
                const input = tokens.input ?? 0
                const cacheRead = tokens.cache?.read ?? 0
                const total = input + cacheRead
                if (total > contextUsed) contextUsed = total
              }
            }
          }
        }
      } catch {
        // Not critical
      }

      try {
        const providerResp = await fetch(`${serverUrl}/provider`)
        if (providerResp.ok) {
          const providerData = (await providerResp.json()) as {
            all?: Array<{
              id?: string
              models?: Record<string, { name?: string; limit?: { context?: number } }>
            }>
          }
          const modelStr = await getCurrentModelFromFile()
          if (modelStr) {
            const parts = modelStr.split("/")
            const provId = parts[0]
            const modelId = parts[1]
            if (provId && modelId) {
              for (const prov of providerData.all ?? []) {
                if (prov.id === provId) {
                  const modelInfo = prov.models?.[modelId]
                  if (modelInfo?.limit?.context) {
                    contextLimit = modelInfo.limit.context
                  }
                  break
                }
              }
            }
          }
        }
      } catch {
        // Not critical
      }

      if (contextUsed > 0 || contextLimit > 0) {
        if (contextLimit > 0) {
          const pct = Math.round((contextUsed / contextLimit) * 100)
          lines.push(t(locale, "status.contextWithLimit", {
            used: contextUsed.toLocaleString(),
            limit: contextLimit.toLocaleString(),
            pct: pct.toString(),
          }))
        } else {
          lines.push(t(locale, "status.context", { used: contextUsed.toLocaleString() }))
        }
      }
    } else {
      lines.push(t(locale, "status.sessionUnbound"))
      lines.push(t(locale, "status.hintStart"))
    }

    lines.push(t(locale, "status.directory", { dir: process.env.OPENCODE_CWD || process.cwd() }))

    const statusText = lines.join("\n")
    await replyText(chatId, messageId, statusText, channelId)
  }

  function extractPromptFromInput(input: string): string | undefined {
    const schedulePatterns = [
      /^每周[一二三四五六日天][^\d]*\d{1,2}[：:]?\d{1,2}/,
      /^每[隔个]?\d+小时/,
      /^每[隔个]?[零一二三四五六七八九十\d]+分钟/,
      /^每天\d{1,2}[：:]\d{1,2}/,
      /^每天[一二三四五六七八九十\d]+点[钟]?/,
      /^\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}/,
    ]
    for (const p of schedulePatterns) {
      const matched = input.match(p)
      if (matched) {
        const remaining = input.slice(matched[0].length).replace(/^[。，,、\s]+/, "").trim()
        if (remaining.length > 0) return remaining
      }
    }
    return undefined
  }

  const handleCommand = async function handleCommand(
    feishuKey: string,
    chatId: string,
    messageId: string,
    commandText: string,
    channelId: string = "feishu",
  ): Promise<boolean> {
    const trimmed = commandText.trim()
    const parts = trimmed.split(/\s+/)
    const cmd = parts[0]?.toLowerCase()

    if (!cmd || !cmd.startsWith("/")) return false

    logger.info(`Slash command: ${cmd} from ${feishuKey} (channel: ${channelId})`)

    try {
      switch (cmd) {
        case "/new":
          await handleNew(feishuKey, chatId, messageId, channelId)
          return true
        case "/abort":
          await handleAbort(feishuKey, chatId, messageId, channelId)
          return true
        case "/sessions":
          await handleSessions(feishuKey, chatId, messageId, channelId)
          return true
        case "/projects":
          await handleProjects(feishuKey, chatId, messageId, channelId, parts.slice(1))
          return true
        case "/connect": {
          const targetSessionId = parts[1]
          if (!targetSessionId) {
            await replyText(chatId, messageId, t(getLocale(channelId), "command.connectUsage"), channelId)
            return true
          }
          await handleConnect(feishuKey, chatId, messageId, targetSessionId, channelId)
          return true
        }
        case "/cron":
          await handleCron(feishuKey, chatId, messageId, channelId, parts.slice(1))
          return true
        case "/agent":
          await handleAgent(feishuKey, chatId, messageId, channelId, parts.slice(1))
          return true
        case "/models":
        case "/model":
          await handleModels(feishuKey, chatId, messageId, channelId, parts.slice(1))
          return true

        case "/variants":
        case "/variant":
          await handleVariants(feishuKey, chatId, messageId, channelId, parts.slice(1))
          return true

        case "/compact":
          await handleCompact(feishuKey, chatId, messageId, channelId)
          return true
        case "/share":
          await handleShare(feishuKey, chatId, messageId, channelId)
          return true
        case "/unshare":
          await handleUnshare(feishuKey, chatId, messageId, channelId)
          return true
        case "/rename":
          await handleRename(feishuKey, chatId, messageId, channelId, parts.slice(1))
          return true
        case "/status":
          await handleStatus(feishuKey, chatId, messageId, channelId)
          return true
        case "/":
        case "/help":
          await handleHelp(chatId, messageId, channelId)
          return true
        default:
          return false
      }
    } catch (err) {
      logger.error(`Command ${cmd} failed: ${err}`)
      try {
        await replyText(chatId, messageId, t(getLocale(channelId), "command.commandFailed", { error: String(err) }), channelId)
      } catch (replyErr) {
        logger.error(`Failed to send error reply: ${replyErr}`)
      }
      return true
    }
  }

  async function handleTaskConfirmation(
    feishuKey: string,
    chatId: string,
    messageId: string,
    channelId: string,
    userInput: string,
  ): Promise<boolean> {
    const manager = creationManagers.get(feishuKey)
    if (!manager) return false

    const state = manager.getState()
    if (!state) return false

    // Stage: awaiting_schedule — try regex fast path, then LLM slow path
    if (state.stage === "awaiting_schedule") {
      const locale = getLocale(channelId)

      // Fast path
      const fastParsed = tryParseSchedule(userInput)
      if (fastParsed) {
        manager.setSchedule(userInput, fastParsed)
        const nextState = manager.getState()
        if (nextState) {
          const result = buildTaskCreationCard(nextState.stage, nextState, locale, channelId)
          if (typeof result === "object") {
            await replyCard(chatId, messageId, { card: result, text: "" }, channelId)
          } else {
            await replyText(chatId, messageId, result, channelId)
          }
        }
        return true
      }

      // Slow path: LLM
      await replyText(chatId, messageId, "🤔 正在理解你的描述...", channelId)
      try {
        const llmParsed = await llmParseSchedule(serverUrl, userInput, new Date().toISOString())
        manager.setSchedule(userInput, llmParsed)
        if (llmParsed.taskPrompt) {
          manager.setPrompt(llmParsed.taskPrompt)
        }
        const nextState = manager.getState()
        if (nextState) {
          const result = buildTaskCreationCard(nextState.stage, nextState, locale, channelId)
          if (typeof result === "object") {
            await replyCard(chatId, messageId, { card: result, text: "" }, channelId)
          } else {
            await replyText(chatId, messageId, result, channelId)
          }
        }
      } catch (err) {
        logger.warn(`[handleTaskConfirmation] LLM schedule parse failed: ${err}`)
        await replyText(
          chatId,
          messageId,
          `⚠️ 无法理解 "${userInput}"，请尝试更具体的描述，例如：每天19:00、每周三14:30`,
          channelId,
        )
      }
      return true
    }

    // Stage: awaiting_prompt - use input as prompt
    if (state.stage === "awaiting_prompt") {
      manager.setPrompt(userInput)

      const locale = getLocale(channelId)
      const nextState = manager.getState()
      if (nextState) {
        const result = buildTaskCreationCard(nextState.stage, nextState, locale, channelId)
        if (typeof result === "object") {
          await replyCard(chatId, messageId, { card: result, text: "" }, channelId)
        } else {
          await replyText(chatId, messageId, result, channelId)
        }
      }
      return true
    }

    if (state.stage !== "preview" && state.stage !== "confirming") return false

    const normalized = userInput.trim().toLowerCase()
    const isConfirm = normalized === "y" || normalized === "yes" || normalized === "确认" || normalized === "是"

    if (!isConfirm) {
      manager.clear()
      creationManagers.delete(feishuKey)
      await replyText(chatId, messageId, t(getLocale(channelId), "scheduledTask.creation.cancelled"), channelId)
      return true
    }

    const locale = getLocale(channelId)
    const parsedSchedule = state.parsedSchedule
    const prompt = state.prompt

    if (!parsedSchedule || !prompt) {
      await replyText(chatId, messageId, "Missing schedule or prompt", channelId)
      return true
    }

    try {
      const cronJob = new CronJob(parsedSchedule.cronExpression, () => { })
      const nextDate = cronJob.nextDate()
      const nextRunAt = nextDate ? nextDate.toJSDate().toISOString() : null

      const newTask = await addScheduledTask({
        name: parsedSchedule.summary,
        kind: parsedSchedule.kind,
        prompt: prompt,
        schedule: state.scheduleText || "",
        scheduleSummary: parsedSchedule.summary,
        cronExpression: parsedSchedule.cronExpression,
        model: state.model,
        agent: state.agent,
        projectId: state.projectId,
        projectWorktree: state.projectWorktree,
        channelId,
        chatId,
        enabled: true,
        sessionId: state.sessionId || undefined,
        runAt: parsedSchedule.runAt || undefined,
        nextRunAt: nextRunAt,
        lastRunAt: null,
        lastStatus: "idle",
        lastError: null,
        runCount: 0,
        createdAt: new Date().toISOString(),
      })

      scheduledTaskRuntime.registerTask(newTask)

      manager.clear()
      creationManagers.delete(feishuKey)

      await replyText(chatId, messageId, t(locale, "scheduledTask.creation.success", { name: newTask.name }), channelId)
      logger.info(`[command-handler] Task created: ${newTask.id} - ${newTask.name}`)
    } catch (err) {
      logger.error(`[command-handler] Failed to create task:`, err)
      await replyText(chatId, messageId, `Failed to create task: ${err}`, channelId)
    }

    return true
  }

  const handlerEx: CommandHandlerEx = Object.assign(handleCommand, {
    handleTaskConfirmation,
  })

  return handlerEx
}

export type CommandHandlerEx = CommandHandler & {
  handleTaskConfirmation: (
    feishuKey: string,
    chatId: string,
    messageId: string,
    channelId: string,
    userInput: string,
  ) => Promise<boolean>
}
