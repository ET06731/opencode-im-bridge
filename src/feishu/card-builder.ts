/**
 * Feishu interactive card builder.
 *
 * Card size limit: 28KB
 * Docs: https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-components/content-components/rich-text
 */


export function buildThinkingCard(): Record<string, unknown> {
  return {
    schema: "2.0",
    config: { wide_screen_mode: true },
    header: {
      title: {
        tag: "plain_text",
        content: "🤔 思考中...",
      },
      template: "blue",
    },
    body: {
      elements: [
        {
          tag: "div",
          text: {
            tag: "lark_md",
            content: "正在处理你的消息，请稍候...",
          },
        },
        {
          tag: "button",
          text: { tag: "plain_text", content: "🔄 切换会话" },
          type: "default",
          value: { action: "command_execute", command: "/sessions" },
        },
      ],
    },
  }
}


export function buildResponseCard(text: string): Record<string, unknown> {
  // Feishu card limit is 28KB; truncate if needed
  const truncated =
    text.length > 4000
      ? text.slice(0, 4000) + "\n\n...(内容过长，已截断)"
      : text

  return {
    schema: "2.0",
    config: { wide_screen_mode: true },
    header: {
      title: {
        tag: "plain_text",
        content: "✅ 回复",
      },
      template: "green",
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content: truncated,
        },
        {
          tag: "button",
          text: { tag: "plain_text", content: "🔄 切换会话" },
          type: "default",
          value: { action: "command_execute", command: "/sessions" },
        },
      ],
    },
  }
}

export function buildProjectSelectorCard(sessions: any[], currentSessionId?: string): Record<string, unknown> {
  const recentSessions = sessions.slice(0, 10)
  return {
    schema: "2.0",
    config: { wide_screen_mode: true },
    header: {
      title: {
        tag: "plain_text",
        content: "📋 选择项目会话",
      },
      template: "blue",
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content: "**点击连接到对应项目：**",
        },
        ...recentSessions.map((s) => {
          const isCurrentSession = s.id === currentSessionId
          return {
            tag: "button",
            text: {
              tag: "plain_text",
              content: `${isCurrentSession ? "▶ " : ""}${s.title ? s.title + " — " : ""}${s.id}`,
            },
            type: isCurrentSession ? "primary" : "default",
            value: { action: "command_execute", command: `/connect ${s.id}` },
          }
        }),
      ],
    },
  }
}

export function buildHelpCard(): Record<string, unknown> {
  return {
    schema: "2.0",
    config: { wide_screen_mode: true },
    header: {
      title: {
        tag: "plain_text",
        content: "⚡ 命令菜单",
      },
      template: "blue",
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content: "**选择要执行的命令：**",
        },
        {
          tag: "button",
          text: { tag: "plain_text", content: "🆕 新建会话" },
          type: "primary",
          value: { action: "command_execute", command: "/new" },
        },
        {
          tag: "button",
          text: { tag: "plain_text", content: "🔌 连接会话" },
          type: "primary",
          value: { action: "command_execute", command: "/sessions" },
        },
        {
          tag: "button",
          text: { tag: "plain_text", content: "📂 项目" },
          value: { action: "command_execute", command: "/projects" },
        },
        {
          tag: "button",
          text: { tag: "plain_text", content: "📊 状态" },
          value: { action: "command_execute", command: "/status" },
        },
        {
          tag: "button",
          text: { tag: "plain_text", content: "🤖 选择 Agent" },
          value: { action: "command_execute", command: "/agent" },
        },
        {
          tag: "button",
          text: { tag: "plain_text", content: "🧠 Model" },
          value: { action: "command_execute", command: "/models" },
        },
        {
          tag: "button",
          text: { tag: "plain_text", content: "📦 压缩历史" },
          value: { action: "command_execute", command: "/compact" },
        },
        {
          tag: "button",
          text: { tag: "plain_text", content: "🔗 分享会话" },
          value: { action: "command_execute", command: "/share" },
        },
        {
          tag: "button",
          text: { tag: "plain_text", content: "🔓 取消分享" },
          value: { action: "command_execute", command: "/unshare" },
        },
        {
          tag: "button",
          text: { tag: "plain_text", content: "✏️ 重命名" },
          value: { action: "command_execute", command: "/rename" },
        },
        {
          tag: "button",
          text: { tag: "plain_text", content: "🕒 定时任务" },
          value: { action: "command_execute", command: "/cron" },
        },
        {
          tag: "button",
          text: { tag: "plain_text", content: "🛑 中止任务" },
          type: "danger",
          value: { action: "command_execute", command: "/abort" },
        },
      ],
    },
  }
}

export function buildAgentSelectorCard(
  agents: string[],
  currentAgent?: string,
): Record<string, unknown> {
  const visibleAgents = agents.slice(0, 12)
  const truncatedCount = Math.max(0, agents.length - visibleAgents.length)

  return {
    schema: "2.0",
    config: { wide_screen_mode: true },
    header: {
      title: {
        tag: "plain_text",
        content: "🤖 Agent",
      },
      template: "blue",
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content: currentAgent
            ? `**Current agent:** \`${currentAgent}\`\n\nChoose an agent below.`
            : "**Choose an agent below.**",
        },
        ...visibleAgents.map((agent) => {
          const isCurrent = agent.toLowerCase() === currentAgent?.toLowerCase()
          return {
            tag: "button",
            text: {
              tag: "plain_text",
              content: `${isCurrent ? "* " : ""}${agent}`,
            },
            type: isCurrent ? "primary" : "default",
            value: { action: "command_execute", command: `/agent ${agent}` },
          }
        }),
        ...(truncatedCount > 0
          ? [{
            tag: "markdown",
            content: `And ${truncatedCount} more. Use \`/agent {name}\` to switch directly.`,
          }]
          : []),
      ],
    },
  }
}


export function buildModelSelectorCard(
  models: Array<{ id: string; providerName: string; modelName: string }>,
  currentModelId?: string,
): Record<string, unknown> {
  const currentModel = models.find((m) => m.id === currentModelId)
  const otherModels = models.filter((m) => m.id !== currentModelId)

  return {
    schema: "2.0",
    config: { wide_screen_mode: true },
    header: {
      title: {
        tag: "plain_text",
        content: "🧠 Model",
      },
      template: "indigo",
    },
    body: {
      elements: [
        ...(currentModel
          ? [{
            tag: "div",
            text: {
              tag: "lark_md",
              content: `**当前模型:** ${currentModel.providerName} / ${currentModel.modelName}`,
            },
          }]
          : [{
            tag: "div",
            text: {
              tag: "lark_md",
              content: "**当前模型:** 点击按钮切换",
            },
          }]),
        {
          tag: "markdown",
          content: otherModels.length > 0 ? "**选择要切换的模型：**" : "当前已是全部可用模型。",
        },
        ...otherModels.slice(0, 8).map((model) => ({
          tag: "button",
          text: {
            tag: "plain_text",
            content: `${model.providerName} / ${model.modelName}`,
          },
          type: "default",
          value: { action: "command_execute", command: `/models ${model.id}` },
        })),
        ...(otherModels.length > 8
          ? [{
            tag: "overflow",
            options: otherModels.slice(8, 18).map((model) => ({
              text: {
                tag: "plain_text",
                content: `${model.providerName} / ${model.modelName}`,
              },
              value: `/models ${model.id}`,
            })),
          }]
          : []),
        ...(otherModels.length > 18
          ? [{
            tag: "markdown",
            content: `_还有 ${otherModels.length - 18} 个模型，使用 \`/models provider/model\` 直接切换_`,
          }]
          : []),
        ...(otherModels.length === 0 && !currentModel
          ? [{
            tag: "markdown",
            content: "暂无可用模型。",
          }]
          : []),
        ],
    },
  }
}

export function buildVariantSelectorCard(
  variants: Array<{ id: string; name?: string }>,
  currentModelId?: string,
): Record<string, unknown> {
  const currentVariantId = currentModelId ? currentModelId.split('/').pop() : undefined

  return {
    schema: "2.0",
    config: { wide_screen_mode: true },
    header: {
      title: {
        tag: "plain_text",
        content: "🧬 Model Variant",
      },
      template: "purple",
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content: "**选择要使用的模型变体：**",
        },
        ...variants.slice(0, 10).map((variant) => ({
          tag: "button",
          text: {
            tag: "plain_text",
            content: `${variant.id === currentVariantId ? "* " : ""}${variant.name ?? variant.id}`,
          },
          type: variant.id === currentVariantId ? "primary" : "default",
          value: { action: "command_execute", command: `/variants ${variant.id}` },
        })),
        ...(variants.length > 10
          ? [{
              tag: "markdown",
              content: `_还有 ${variants.length - 10} 个变体，使用 \`/variants {variant}\` 直接切换_`,
            }]
          : []),
      ],
    },
  }
}

export function buildProjectCard(
  projects: Array<{ id: string; worktree: string; name?: string }>,
  currentWorktree?: string,
): Record<string, unknown> {
  const normalizedCurrent = (currentWorktree || "").replace(/\\/g, "/").toLowerCase()
  const visibleProjects = projects.slice(0, 10)
  const truncatedCount = Math.max(0, projects.length - visibleProjects.length)

  return {
    schema: "2.0",
    config: { wide_screen_mode: true },
    header: {
      title: {
        tag: "plain_text",
        content: "📂 项目列表",
      },
      template: "blue",
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content: "**点击按钮切换到对应项目：**",
        },
        ...visibleProjects.map((p) => {
          const name = p.name || p.worktree.split("/").pop() || p.worktree
          const isCurrent = p.worktree.replace(/\\/g, "/").toLowerCase() === normalizedCurrent
          return {
            tag: "button",
            text: {
              tag: "plain_text",
              content: `${isCurrent ? "✓ " : ""}${name}`,
            },
            type: isCurrent ? "primary" : "default",
            value: { action: "command_execute", command: `/projects ${name}` },
          }
        }),
        ...(truncatedCount > 0
          ? [{
            tag: "markdown",
            content: `还有 ${truncatedCount} 个项目，使用 \`/projects <名称>\` 直接切换`,
          }]
          : []),
        ...(projects.length === 0
          ? [{
            tag: "markdown",
            content: "暂无可用项目。",
          }]
          : []),
      ],
    },
  }
}

export function buildErrorCard(msg: string): Record<string, unknown> {
  return {
    schema: "2.0",
    config: { wide_screen_mode: true },
    header: {
      title: {
        tag: "plain_text",
        content: "❌ 出错了",
      },
      template: "red",
    },
    body: {
      elements: [
        {
          tag: "div",
          text: {
            tag: "lark_md",
            content: msg || "处理请求时发生错误，请稍后重试。",
          },
        },
      ],
    },
  }
}
