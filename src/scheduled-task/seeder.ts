import type { CronJobConfig } from "../utils/config.js"
import type { ScheduledTask } from "./types.js"
import { addScheduledTask, listScheduledTasks } from "./store.js"
import { parseSchedule } from "./schedule-parser.js"

interface SeederOptions {
  logger: {
    info: (msg: string, ...args: unknown[]) => void
    warn: (msg: string, ...args: unknown[]) => void
    debug: (msg: string, ...args: unknown[]) => void
  }
}

export async function seedScheduledTasksFromConfig(
  configJobs: CronJobConfig[],
  options: SeederOptions
): Promise<void> {
  const { logger } = options

  if (!configJobs || configJobs.length === 0) {
    logger.debug("[seeder] No jobs in config, skipping seed")
    return
  }

  logger.info(`[seeder] Seeding ${configJobs.length} scheduled task(s) from config`)

  const existingTasks = await listScheduledTasks()
  const existingIds = new Set(existingTasks.map((t) => t.id))

  for (const job of configJobs) {
    if (!job.enabled) {
      logger.debug(`[seeder] Job "${job.name}" is disabled, skipping`)
      continue
    }

    if (job.id && existingIds.has(job.id)) {
      logger.debug(`[seeder] Job "${job.name}" (id=${job.id}) already exists, skipping`)
      continue
    }

    const parsed = parseSchedule(job.schedule)
    if (!parsed) {
      logger.warn(`[seeder] Failed to parse cron expression "${job.schedule}" for job "${job.name}", skipping`)
      continue
    }

    const taskId = job.id ?? `config-${Math.random().toString(36).substring(2, 9)}`

    const newTask: Omit<ScheduledTask, "id"> & { id: string } = {
      id: taskId,
      name: job.name,
      kind: parsed.kind,
      prompt: job.prompt,
      schedule: job.schedule,
      scheduleSummary: parsed.summary,
      cronExpression: parsed.cronExpression,
      model: {
        providerID: job.modelProviderId ?? "",
        modelID: job.modelId ?? "",
      },
      agent: job.agent ?? "build",
      projectId: job.projectId ?? "default",
      projectWorktree: job.projectWorktree ?? "",
      channelId: job.channelId ?? "feishu",
      chatId: job.chatId,
      enabled: true,
      sessionId: undefined,
      runAt: undefined,
      nextRunAt: null,
      lastRunAt: null,
      lastStatus: "idle",
      lastError: null,
      runCount: 0,
      createdAt: new Date().toISOString(),
    }

    try {
      await addScheduledTask(newTask)
      logger.info(`[seeder] Added scheduled task "${job.name}" (id=${taskId})`)
    } catch (err) {
      logger.warn(`[seeder] Failed to add task "${job.name}":`, err)
    }
  }

  logger.info("[seeder] Seeding complete")
}
