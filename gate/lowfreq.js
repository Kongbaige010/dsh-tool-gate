/**
 * tool-gate — 低频工具按需注入。
 *
 * 背景：62 个工具里有约 15 个低频能力（Mnemon 文档/记忆空间管理、定时提醒），
 * 每轮都带完整 JSON Schema，合计约 1.1 万字符 ≈ 3.5k token。
 *
 * 做法：与 mcp-tool-gate 同构——把「受管组中尚未开启」的工具从每轮装配出来的
 * 工具清单里滤掉。开启由模型调用 tool_gate 元工具完成。工具注册表分毫未动，
 * 失效的最坏后果是「工具看不见」。
 *
 * 2026-11-14 修复（过滤点迁移）：原实现挂在 `system-prompt/assemble` 瀑布里过滤
 * `assembly.tools`，但新版 @deepseek-ai/dsh-system-prompt 已把工具声明移出瀑布参数
 * （tools 在瀑布返回后才合并进最终结果），旧写法恒拿到空数组 → 门控静默失效。
 * 现改为包住服务方法 `systemPrompt.assemble()`：调用原方法拿到含 tools 的完整
 * 装配结果，再按组过滤后返回。同时把 schedule 组里的旧工具名
 * （schedule_delete / schedule_update）更正为现行的 schedule_edit / schedule_view。
 *
 * 分组（内置默认；可在 cordis.patch.yml 的 config.gated 覆盖）：
 *   mnemon_admin  Mnemon 文档/记忆空间管理类——日常记忆读写不在此列
 *   schedule      定时提醒
 * job_* 是高频工具，刻意不纳入门控。
 *
 * 开启状态是进程级集合：子代理天然继承；换顶层会话时清空，避免累积。
 * 零外部 import（与 mcp-tool-gate 同理，避开 profile 的模块解析限制）。
 */

/** Cordis 插件名，用于 loader 诊断。 */
// 由 bundle 入口 index.js 调用；本模块不单独作为 Cordis 插件行。

/** 需要提示词装配、工具注册表与代理注册表（后者用于判定顶层会话）。 */
// 依赖由入口 index.js 统一声明：systemPrompt / tools / agents / webServer。

/**
 * 受管组合：组名 → 工具名列表。
 * 高频工具（mnemon_recall / mnemon_remember / mnemon_runtime_memory /
 * mnemon_document_search / mnemon_view_route / mnemon_view_action）不在任何组里，
 * 因此始终可见——它们承载日常记忆读写与 View 指引。
 */
const DEFAULT_GROUPS = {
  mnemon_admin: [
    'mnemon_document_create',
    'mnemon_document_manage',
    'mnemon_forget',
    'mnemon_link',
    'mnemon_memory_bodies',
    'mnemon_memory_body_create',
    'mnemon_memory_body_merge',
    'mnemon_memory_body_update',
    'mnemon_related',
    'mnemon_status',
    'mnemon_subagent_result',
  ],
  schedule: ['schedule_create', 'schedule_edit', 'schedule_list', 'schedule_view'],
}

/** 元工具统一用文本输出。 */
const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: value }],
}

/** 把逗号/空格/顿号分隔的输入拆成小写名列表。 */
function parseNames(input) {
  return String(input ?? '')
    .split(/[\s,，、]+/)
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0)
}

export function applyLowFreqGate(ctx, config) {
  const cfg = config ?? {}
  // 组名 → 工具名集合；cordis 配置可整体覆盖。
  const groups = new Map()
  for (const [group, names] of Object.entries(cfg.gated ?? DEFAULT_GROUPS)) {
    groups.set(group, new Set(names))
  }
  const alwaysVisible = new Set(cfg.alwaysVisible ?? [])
  const hint = cfg.hint !== false

  /** 已开启的组名。进程级共享，子代理天然继承。 */
  const enabled = new Set()
  /** session.id → Agent 句柄（装配时记录，供元工具定位当前会话） */
  const agents = new Map()
  /** 最近一次见到的顶层会话 id；换成另一个顶层会话时清空开启集合。 */
  let rootSessionId
  /** 诊断：装配钩子执行次数 / 最近一次装配的关键信息。 */
  let assembleCount = 0
  let lastAssemble = '（尚未装配）'

  /** 工具名 → 组名；不在任何受管组则返回 undefined。 */
  function groupOf(toolName) {
    if (typeof toolName !== 'string' || alwaysVisible.has(toolName)) return undefined
    for (const [group, names] of groups) {
      if (names.has(toolName)) return group
    }
    return undefined
  }

  /** 定位当前 agent：优先 ctx 上的 agent，回落到最近一次装配见过的 agent。 */
  function currentAgent() {
    const agent = ctx.get('agent')
    if (agent !== undefined) return agent
    return [...agents.values()].at(-1)
  }

  /** 该 agent 是否为「无父的顶层代理」。 */
  function isRoot(agent) {
    const registry = ctx.get('agents')
    if (registry === undefined) return false
    try {
      return registry.roots().includes(agent)
    } catch {
      return false
    }
  }

  const groupNames = () => [...groups.keys()]

  // ── 过滤点：包住 systemPrompt.assemble() ──────────────────────────────────
  const service = ctx.systemPrompt
  const originalAssemble = service.assemble

  async function gatedAssemble(context) {
    const receiver = this ?? service
    const assembly = await originalAssemble.call(receiver, context ?? {})
    const all = assembly?.tools
    if (!Array.isArray(all)) {
      assembleCount += 1
      lastAssemble = '⚠ 装配结果里没有 tools 数组——接口又变了，本次门控未生效'
      return assembly
    }

    const agent = context?.agent
    const session = agent?.session
    if (agent !== undefined && session !== undefined) agents.set(session.id, agent)

    // 换顶层会话 → 清空。子代理不是顶层，从而继承父代理的开启状态。
    if (agent !== undefined && session !== undefined && isRoot(agent)) {
      if (rootSessionId !== undefined && rootSessionId !== session.id) enabled.clear()
      rootSessionId = session.id
    }

    const tools = []
    let gatedSeen = 0
    let passed = 0
    for (const tool of all) {
      const group = groupOf(tool?.name)
      if (group === undefined) {
        tools.push(tool)
        continue
      }
      gatedSeen += 1
      if (enabled.has(group)) {
        tools.push(tool)
        passed += 1
      }
    }
    assembleCount += 1
    lastAssemble =
      `会话 ${session?.id ?? '(无 agent)'}｜装配工具 ${all.length} 个｜受管 ${gatedSeen} 个｜` +
      `放行 ${passed} 个｜隐藏 ${gatedSeen - passed} 个｜当前开启 ${[...enabled].join(',') || '（空）'}`
    return { ...assembly, tools }
  }

  // ctx.effect 绑定插件生命周期：热重载时撤销覆盖，避免重复包装。
  ctx.effect(() => {
    service.assemble = gatedAssemble
    return () => {
      if (service.assemble === gatedAssemble) service.assemble = originalAssemble
    }
  })

  // ── 系统提示：一行说明，让模型知道这套机制存在 ────────────────────────────
  // order 3050：紧接 MCP gate 的提示（3000）之后、MCP_SERVERS(3100) 之前。
  if (hint) {
    ctx.effect(() =>
      ctx.systemPrompt.section({
        name: 'tool-gate',
        order: 3050,
        text:
          '部分低频工具（Mnemon 文档/记忆空间管理、定时提醒）默认不载入上下文以节省配额。' +
          '需要文档/记忆维护或定时提醒时，先调用 tool_gate 开启对应组（mnemon_admin、schedule），' +
          '工具会在下一次提示词装配时出现。',
      }),
    )
  }

  const register = (tool) => ctx.effect(() => ctx.tools.register(tool))

  // ── 只读状态端点：供界面徽章读取（GET，只读）──────────────────────────────
  ctx.inject(['webServer'], (scoped) => {
    scoped.effect(() =>
      scoped.webServer.register({
        kind: 'exact',
        path: '/plugin/tool-gate/groups',
        resource: async () =>
          new Response(
            JSON.stringify({
              ok: true,
              opened: [...enabled],
              groups: [...groups.entries()].map(([name, members]) => ({
                name,
                enabled: enabled.has(name),
                tools: members.size,
              })),
              assembleCount,
              at: Date.now(),
            }),
            {
              headers: {
                'content-type': 'application/json; charset=utf-8',
                'cache-control': 'no-store',
              },
            },
          ),
      }),
    )
  })

  // ── 元工具：列出 / 开启 / 关闭工具组 ──────────────────────────────────────
  register({
    name: 'tool_gate',
    description:
      '列出、开启或关闭按需注入的低频工具组（mnemon_admin 文档/记忆空间管理、schedule 定时提醒）。' +
      '这些工具默认不载入上下文，未开启时不在工具列表里；开启后在下一步装配出现。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'enable', 'disable'],
          description: 'list 查看各组状态；enable/disable 切换',
        },
        group: {
          type: 'string',
          description: '组名，逗号/空格分隔；或 all 表示全部。list 时可省略',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    execute(args) {
      const action = String(args?.action ?? '')
      const names = parseNames(args?.group)

      if (action === 'list') {
        const lines = groupNames().map((group) => {
          const state = enabled.has(group) ? '已开启' : '未开启'
          const members = [...groups.get(group)]
          return `- ${group} [${state}] ${members.length} 个工具：${members.join(', ')}`
        })
        return [
          `受管工具组（${groupNames().length} 个，已开启 ${enabled.size} 个）`,
          ...lines,
          '',
          '用 tool_gate(action="enable", group="...") 开启需要的组。开启状态是进程级的：所有会话与子代理共享，换新会话时自动清空。',
          '',
          `诊断：装配钩子已执行 ${assembleCount} 次；最近一次 → ${lastAssemble}`,
        ].join('\n')
      }

      if (action !== 'enable' && action !== 'disable') {
        return `未知 action "${action}"。用法：tool_gate(action="list" | "enable" | "disable", group="...")。`
      }
      if (names.length === 0) {
        return `未提供组名。可用组：${groupNames().join(', ')}。`
      }

      const targets = names.includes('all') ? groupNames() : names
      const changed = []
      const unknown = []
      for (const target of targets) {
        if (!groups.has(target)) {
          unknown.push(target)
          continue
        }
        if (action === 'enable') {
          if (!enabled.has(target)) {
            enabled.add(target)
            changed.push(target)
          }
        } else if (enabled.delete(target)) {
          changed.push(target)
        }
      }

      const parts = []
      const verb = action === 'enable' ? '已开启' : '已关闭'
      if (changed.length > 0) {
        parts.push(
          action === 'enable'
            ? `${verb}：${changed.join(', ')}。工具会在下一次提示词装配时出现。`
            : `${verb}：${changed.join(', ')}。这些工具不再出现在上下文里。`,
        )
      }
      if (unknown.length > 0) parts.push(`未知组：${unknown.join(', ')}（可用：${groupNames().join(', ')}）。`)
      if (parts.length === 0) parts.push('没有变化。')
      return parts.join('\n')
    },
  })
}
