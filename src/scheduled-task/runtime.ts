import { CronJob } from "cron"
import type { ScheduledTask, TaskDelivery } from "./types.js"
import { executeScheduledTask } from "./executor.js"
import {
  listScheduledTasks,
  updateScheduledTask,
  removeScheduledTask as removeScheduledTaskFromStore,
} from "./store.js"

/**
 * Logger interface for runtime operations
 */
interface RuntimeLogger {
  debug: (msg: string, ...args: unknown[]) => void
  info: (msg: string, ...args: unknown[]) => void
  warn: (msg: string, ...args: unknown[]) => void
  error: (msg: string, ...args: unknown[]) => void
}

/**
 * Channel send function type
 */
type SendFn = (delivery: TaskDelivery) => Promise<void>

/**
 * Runtime configuration for initialization
 */
interface RuntimeConfig {
  serverUrl: string
  logger: RuntimeLogger
  timeoutMs?: number
  /** Called before task execution to snapshot existing attachments */
  snapshotAttachments?: (chatId: string) => Promise<void>
  /** Register an SSE listener for session.idle events */
  addSseListener?: (sessionId: string, fn: (event: unknown) => void) => void
  /** Remove a previously registered SSE listener */
  removeSseListener?: (sessionId: string, fn: (event: unknown) => void) => void
  /** Track owned sessions so EventProcessor doesn't filter them out */
  ownedSessions?: Set<string>
}

/**
 * ScheduledTaskRuntime - manages scheduled task timers and execution
 *
 * Responsibilities:
 * - Initialize runtime with channel configuration
 * - Register/remove tasks for scheduling
 * - Recover tasks on startup from persistent store
 * - Execute tasks via executor.ts when due
 * - Handle success/failure and compute next run times
 */
export class ScheduledTaskRuntime {
  private sendFn: SendFn | null = null
  private config: RuntimeConfig | null = null

  /** Map of taskId -> CronJob for active scheduled tasks */
  private taskTimers = new Map<string, CronJob>()

  /** Map of taskId -> ScheduledTask for quick lookup */
  private taskRegistry = new Map<string, ScheduledTask>()

  /**
   * Initialize the runtime with channel configuration
   */
  async initialize(sendFn: SendFn, config: RuntimeConfig): Promise<void> {
    this.sendFn = sendFn
    this.config = config

    config.logger.info("[runtime] Initializing scheduled task runtime")

    await this.recoverTasks()
  }

  private async recoverTasks(): Promise<void> {
    if (!this.config) {
      throw new Error("Runtime not initialized")
    }

    const { logger } = this.config

    logger.info("[runtime] Starting task recovery...")

    try {
      const tasks = await listScheduledTasks()
      logger.info(`[runtime] Found ${tasks.length} tasks in store, checking for enabled ones...`)

      for (const task of tasks) {
        if (task.enabled) {
          logger.info(`[runtime] Recovering enabled task: ${task.id} - ${task.name}`)
          this.taskRegistry.set(task.id, task)
          this.scheduleTask(task)
        }
      }

      logger.info(`[runtime] Successfully recovered and scheduled ${tasks.filter((t) => t.enabled).length} tasks`)
    } catch (err) {
      logger.error("[runtime] Failed to recover tasks:", err)
    }
  }

  /**
   * Register a new task for scheduling
   */
  registerTask(task: ScheduledTask): void {
    if (!task.enabled) {
      this.config?.logger.debug(`[runtime] Task "${task.name}" is disabled, not scheduling`)
      return
    }

    this.config?.logger.info(`[runtime] Registering task "${task.name}" (id=${task.id})`)

    this.taskRegistry.set(task.id, task)
    this.scheduleTask(task)
  }

  private scheduleTask(task: ScheduledTask): void {
    this.cancelTaskTimer(task.id)

    try {
      const job = new CronJob(
        task.cronExpression,
        async () => {
          await this.executeTask(task.id)
        },
        null,
        true,
      )

      this.taskTimers.set(task.id, job)

      const nextDate = job.nextDate()
      if (nextDate) {
        this.updateTaskNextRun(task.id, nextDate.toJSDate().toISOString())
      }
      this.config?.logger.info(`[runtime] Scheduled task "${task.name}" with expression "${task.cronExpression}", next: ${nextDate?.toString()}`)
    } catch (err) {
      this.config?.logger.error(`[runtime] Failed to schedule task "${task.name}":`, err)
    }
  }

  private cancelTaskTimer(taskId: string): void {
    const existingJob = this.taskTimers.get(taskId)
    if (existingJob) {
      existingJob.stop()
      this.taskTimers.delete(taskId)
    }
  }

  removeTask(taskId: string): void {
    const task = this.taskRegistry.get(taskId)
    if (task) {
      this.config?.logger.info(`[runtime] Removing task "${task.name}" (id=${taskId})`)
    }

    this.cancelTaskTimer(taskId)
    this.taskRegistry.delete(taskId)
  }

  private async executeTask(taskId: string): Promise<void> {
    if (!this.config || !this.sendFn) {
      throw new Error("Runtime not initialized")
    }

    const task = this.taskRegistry.get(taskId)
    if (!task) {
      this.config.logger.warn(`[runtime] Task ${taskId} not found in registry, skipping execution`)
      return
    }

    const { serverUrl, logger, timeoutMs, addSseListener, removeSseListener, ownedSessions } = this.config

    logger.info(`[runtime] Executing task "${task.name}" (id=${taskId})`)

    if (this.config?.snapshotAttachments) {
      await this.config.snapshotAttachments(task.chatId)
    }

    await updateScheduledTask(taskId, (t) => ({
      ...t,
      lastStatus: "running",
    }))

    const startTime = new Date().toISOString()

    try {
      const result = await executeScheduledTask(task, {
        serverUrl,
        logger,
        timeoutMs,
        addSseListener,
        removeSseListener,
        ownedSessions,
      })

      const delivery: TaskDelivery = {
        taskId,
        taskName: task.name,
        scheduleSummary: task.scheduleSummary,
        prompt: task.prompt,
        runAt: startTime,
        status: result.status,
        messageText:
          result.status === "success"
            ? result.resultText ?? "(no response)"
            : result.errorMessage ?? "Unknown error",
        sessionId: result.sessionId,
        channelId: task.channelId,
        chatId: task.chatId,
      }

      logger.info(`[runtime] Task "${task.name}" result: status=${result.status}, resultText length=${(result.resultText || "").length}, messageText length=${delivery.messageText.length}`)

      await updateScheduledTask(taskId, (t) => ({
        ...t,
        lastRunAt: startTime,
        lastStatus: result.status === "success" ? "success" : "error",
        lastError: result.errorMessage ?? null,
        runCount: t.runCount + 1,
      }))

      await this.handleDelivery(delivery)
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      logger.error(`[runtime] Task "${task.name}" threw unexpected error:`, err)

      await updateScheduledTask(taskId, (t) => ({
        ...t,
        lastRunAt: startTime,
        lastStatus: "error",
        lastError: errorMessage,
      }))

      const errorDelivery: TaskDelivery = {
        taskId,
        taskName: task.name,
        scheduleSummary: task.scheduleSummary,
        prompt: task.prompt,
        runAt: startTime,
        status: "error",
        messageText: `Execution error: ${errorMessage}`,
        channelId: task.channelId,
        chatId: task.chatId,
      }

      await this.handleDelivery(errorDelivery)
    }

    this.rescheduleTask(taskId)
  }

  private async handleDelivery(delivery: TaskDelivery): Promise<void> {
    if (!this.sendFn) {
      this.config?.logger.warn(`[runtime] handleDelivery: sendFn is not set, skipping delivery`)
      return
    }

    this.config?.logger.info(`[runtime] handleDelivery: delivering to channel=${delivery.channelId}, chatId=${delivery.chatId}`)
    await this.sendFn(delivery)
    this.config?.logger.info(`[runtime] handleDelivery: completed`)
  }

  private rescheduleTask(taskId: string): void {
    const task = this.taskRegistry.get(taskId)
    if (!task || !task.enabled) {
      return
    }

    // once 任务执行完成后自动清除
    if (task.kind === "once") {
      this.config?.logger.info(`[runtime] Once task "${task.name}" completed, removing`)
      this.cancelTaskTimer(taskId)
      this.taskRegistry.delete(taskId)
      removeScheduledTaskFromStore(taskId).catch((err) => {
        this.config?.logger.error(`[runtime] Failed to remove once task from store:`, err)
      })
      return
    }

    this.scheduleTask(task)
  }

  private async updateTaskNextRun(taskId: string, nextRunAt: string): Promise<void> {
    const task = this.taskRegistry.get(taskId)
    if (task) {
      task.nextRunAt = nextRunAt
      this.taskRegistry.set(taskId, task)
    }

    await updateScheduledTask(taskId, (t) => ({
      ...t,
      nextRunAt,
    }))
  }

  async shutdown(): Promise<void> {
    this.config?.logger.info("[runtime] Shutting down scheduled task runtime")

    for (const [taskId, job] of this.taskTimers) {
      job.stop()
      this.config?.logger.debug(`[runtime] Stopped timer for task ${taskId}`)
    }

    this.taskTimers.clear()
    this.taskRegistry.clear()
  }
}

/**
 * Default runtime instance (singleton for convenience)
 */
export const scheduledTaskRuntime = new ScheduledTaskRuntime()
