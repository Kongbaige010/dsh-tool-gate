/**
 * mcp-tool-gate — MCP 工具按需注入。
 *
 * 背景：MCP 服务通常一个服务挂几十到上百个工具，每个都带完整 JSON Schema。默认（native 呈现）
 * 每一轮请求都要把这些 JSON Schema 全塞进上下文——实测一个多服务 profile 可达数十万字符
 * ≈ 数万 token，而实际一轮里通常只用得到 0～3 个。
 *
 * 做法：把「受管 MCP 工具」从每轮装配出来的工具清单里滤掉，只放行已开启的服务。
 * 开启动作由模型通过 mcp_enable 元工具完成。
 *
 * 2026-11-14 修复（过滤点迁移）：
 *   原实现挂在 `system-prompt/assemble` 瀑布里过滤 `assembly.tools`。新版
 *   @deepseek-ai/dsh-system-prompt 已把工具声明移出瀑布参数——瀑布只拿到
 *   sections / contexts / variables，`tools` 是在瀑布返回之后才由
 *   `return { ...transformed, tools }` 合并进最终结果的。于是旧写法遍历
 *   `assembled.tools ?? []` 恒为空数组，门控静默失效、全部工具每轮照旧全量注入
 *   （诊断行一直显示「过滤前受管 0 个」就是这么来的）。
 *   现改为包住服务方法 `systemPrompt.assemble()`：调用原方法拿到含 tools 的完整
 *   装配结果，再按开启状态过滤后返回。每轮装配都会经过这里，开启/关闭即时生效。
 *
 * 关键性质：滤掉的工具只是在提示词里不出现——工具注册表分毫未动，随时原样放回。
 * 所以本插件失效的最坏后果是「工具看不见」，而不是「工具坏了」。
 *
 * 零外部 import（与 tool-gate 同理）：避免依赖解析路径问题，只用平台自带的
 * JSON 与字符串操作。
 */

/** Cordis 插件名，用于 loader 诊断。 */
// 由 bundle 入口 index.js 调用；本模块不单独作为 Cordis 插件行。

/** 需要提示词装配、工具注册表与代理注册表（后者用于判定顶层会话）。 */
// 依赖由入口 index.js 统一声明：systemPrompt / tools / agents / webServer。

/**
 * 本插件不内置任何服务名、服务清单或使用场景：受管范围默认覆盖所有
 * `mcp__<server>__*` 工具（自动发现），也可以用 config.gated 显式列出。
 * config.catalog 可选，仅用于给 mcp_services 的输出补上文字说明：
 *   catalog: { '<server>': { title: '…', use: '…' } }
 */

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

export function applyMcpGate(ctx, config) {
  const cfg = config ?? {}
  // 受管范围：显式配置优先；未配置时「所有 mcp__<server>__* 工具」都受管（自动发现）。
  const gated = Array.isArray(cfg.gated) ? new Set(cfg.gated) : undefined
  // 可选的展示文字：{ '<server>': { title, use } }，不影响门控行为。
  const catalog = cfg.catalog ?? {}
  // 例外：永远可见的工具名（受管服务里也不想藏的那些）。
  const alwaysVisible = new Set(cfg.alwaysVisible ?? [])
  // 是否注入一行系统提示，告诉模型这套机制的存在。
  const hint = cfg.hint !== false
  // 空闲回收：默认关闭（0 = 纯主动开关，由模型在任务结束时 mcp_disable）。
  // 需要兜底时可在 profile 里配 idleTtlMs（毫秒），例如 3600000 = 1 小时兜底。
  const idleTtlMs = typeof cfg.idleTtlMs === 'number' && cfg.idleTtlMs >= 0 ? cfg.idleTtlMs : 0

  /** 已开启的服务名集合。进程级共享，故子代理天然继承父代理。 */
  const enabled = new Set()
  /** 装配中实际出现过的 MCP 服务名（自动发现模式下的服务清单）。 */
  const seenServers = new Set()
  /** 服务名 → 最后一次被调用（或开启）的时间戳，用于空闲回收。 */
  const lastUsed = new Map()
  /** 最近一次装配时被自动回收的服务名。 */
  let lastAutoClosed = []
  /** session.id → Agent 句柄（装配时记录，供元工具定位当前会话） */
  const agents = new Map()
  /** session.id → 上次装配里各受管服务实际有多少工具 */
  const counts = new Map()
  /** 最近一次见到的顶层会话 id；换成另一个顶层会话时清空开启集合。 */
  let rootSessionId
  /** 诊断：装配次数 / 最近一次装配的关键信息。 */
  let assembleCount = 0
  let lastAssemble = '（尚未装配）'
  /** 最近一次装配的计数快照，供界面徽章读取。 */
  let lastCounts = { injected: 0, hidden: 0, total: 0, at: 0 }

  /** 工具名 → 受管服务名；不受管则返回 undefined。MCP 工具名形如 mcp__<server>__<tool>。 */
  function serverOf(toolName) {
    if (typeof toolName !== 'string' || !toolName.startsWith('mcp__')) return undefined
    const end = toolName.indexOf('__', 5)
    if (end < 0) return undefined
    const server = toolName.slice(5, end)
    if (gated !== undefined && !gated.has(server)) return undefined
    return server
  }

  /** 定位当前 agent：优先 ctx 上的 agent，回落到最近一次装配见过的 agent。 */
  function currentAgent() {
    const agent = ctx.get('agent')
    if (agent !== undefined) return agent
    return [...agents.values()].at(-1)
  }

  /** 定位当前会话。 */
  function currentSession() {
    const agent = currentAgent()
    return agent === undefined ? undefined : agent.session
  }

  /**
   * 该 agent 是否为「无父的顶层代理」。
   * 用于「换顶层会话就清空开启集合」——子代理不是顶层，所以不会触发清空，
   * 从而自然继承父代理已开启的服务。
   */
  function isRoot(agent) {
    const registry = ctx.get('agents')
    if (registry === undefined) return false
    try {
      return registry.roots().includes(agent)
    } catch {
      return false
    }
  }

  /** 受管服务名列表：显式配置优先，否则用装配中实际见到的服务。 */
  function gatedServers() {
    if (gated !== undefined) return [...gated]
    return [...seenServers].sort()
  }

  // ── 过滤点：包住 systemPrompt.assemble() ──────────────────────────────────
  // 调用原方法拿到含 tools 的完整装配结果，再按开启状态裁掉未开启服务的工具。
  const service = ctx.systemPrompt
  const originalAssemble = service.assemble

  /** 关掉长时间没被调用的服务；返回这一次回收掉的名字。 */
  function sweepIdle(now) {
    const closed = []
    if (idleTtlMs <= 0) return closed
    for (const server of [...enabled]) {
      const used = lastUsed.get(server)
      if (used === undefined) {
        lastUsed.set(server, now)
        continue
      }
      if (now - used > idleTtlMs) {
        enabled.delete(server)
        lastUsed.delete(server)
        closed.push(server)
      }
    }
    return closed
  }

  async function gatedAssemble(context) {
    const receiver = this ?? service
    lastAutoClosed = sweepIdle(Date.now())
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

    const allow = enabled
    const tally = new Map()
    const tools = []
    let gatedSeen = 0
    let passed = 0
    for (const tool of all) {
      const name = tool?.name
      const server = serverOf(name)
      // 不受管，或显式豁免：原样保留。
      if (server === undefined || alwaysVisible.has(name)) {
        tools.push(tool)
        continue
      }
      seenServers.add(server)
      tally.set(server, (tally.get(server) ?? 0) + 1)
      gatedSeen += 1
      if (allow.has(server)) {
        tools.push(tool)
        passed += 1
      }
    }

    if (session !== undefined) counts.set(session.id, tally)
    assembleCount += 1
    let knownCount = -1
    let hiddenNames = []
    try {
      const toolsService = ctx.get('tools')
      const view = typeof toolsService?.view === 'function' ? toolsService.view(agent) : undefined
      knownCount = view?.knownNames?.size ?? -1
      if (view?.knownNames !== undefined && view?.visible !== undefined) {
        for (const name of view.knownNames) {
          if (!view.visible.has(name)) hiddenNames.push(name)
          if (hiddenNames.length >= 60) break
        }
      }
    } catch {
      knownCount = -2
    }
    lastCounts = { injected: passed, hidden: gatedSeen - passed, total: gatedSeen, at: Date.now(), knownCount }
    lastAssemble =
      `会话 ${session?.id ?? '(无 agent)'}｜装配工具 ${all.length} 个｜受管 ${gatedSeen} 个｜` +
      `放行 ${passed} 个｜隐藏 ${gatedSeen - passed} 个｜当前开启 ${[...allow].join(',') || '（空）'}` +
      (gatedSeen === 0 ? '｜⚠ 未匹配到受管工具' : '')

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
  // order 3000 落在工具说明段落之后、TOOLS_SDK(5000) 之前。
  if (hint) {
    ctx.effect(() =>
      ctx.systemPrompt.section({
        name: 'mcp-tool-gate',
        order: 3000,
        text:
          'MCP 服务提供的工具默认不载入上下文以节省配额。' +
          '当任务需要其中某类能力时，先调用 mcp_enable 开启对应服务，工具会在下一步装配时出现。' +
          '用完即关：该任务不再需要这个服务时，在同一条回复结束前调用 mcp_disable 把它关掉；' +
          '不要因为"也许以后还要用"而留着——需要时再开一次的成本只有一步。',
      }),
    )
  }

  // 任何一次对受管服务工具的调用都刷新空闲计时，避免"正在用却被回收"。
  ctx.on('tools/pre-execute', async (exec, next) => {
    const name = exec?.name
    if (typeof name === 'string' && name.startsWith('mcp__')) {
      const server = serverOf(name)
      if (server !== undefined && enabled.has(server)) lastUsed.set(server, Date.now())
    }
    return next()
  })

  const register = (tool) => ctx.effect(() => ctx.tools.register(tool))

  // ── 只读状态端点：供界面徽章读取（GET，只暴露状态，不提供任何写操作）──────
  // 可选注入：profile 没有 webServer 时插件照常工作，只是没有这个端点。
  ctx.inject(['webServer'], (scoped) => {
    scoped.effect(() =>
      scoped.webServer.register({
        kind: 'exact',
        path: '/plugin/tool-gate/mcp',
        resource: async () =>
          new Response(
            JSON.stringify({
              ok: true,
              ready: assembleCount > 0,
              opened: [...enabled],
              servers: gatedServers().length,
              injected: lastCounts.injected,
              hidden: lastCounts.hidden,
              total: lastCounts.total,
              idleTtlMinutes: idleTtlMs <= 0 ? 0 : Math.round(idleTtlMs / 60000),
              autoClosed: lastAutoClosed,
              assembleCount,
              at: lastCounts.at,
              knownCount: lastCounts.knownCount,
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

  // ── 元工具 1：列出服务 ────────────────────────────────────────────────────
  register({
    name: 'mcp_services',
    description:
      '列出受管的 MCP 工具服务：服务名、工具数量，以及是否已开启。' +
      '需要某类 MCP 能力时先看这里，再决定开启哪个服务。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: TEXT_OUTPUT,
    execute() {
      const session = currentSession()
      const tally = session === undefined ? new Map() : (counts.get(session.id) ?? new Map())
      const entries = gatedServers()
      const lines = entries.map((server) => {
        const state = enabled.has(server) ? '已开启' : '未开启'
        const n = tally.get(server)
        const count = n === undefined ? '' : ` ${n} 个工具`
        const meta = catalog[server]
        const title = typeof meta?.title === 'string' ? meta.title : server
        const use = typeof meta?.use === 'string' ? meta.use : 'MCP 服务'
        return `- ${server} [${state}]${count} — ${title}：${use}`
      })
      const opened = entries.filter((server) => enabled.has(server)).length
      return [
        `受管 MCP 工具服务（${entries.length} 个，已开启 ${opened} 个）`,
        ...lines,
        '',
        '用 mcp_enable 开启需要的服务。开启状态是进程级的：所有会话与子代理共享，换新会话时自动清空。',
        '',
        `诊断：装配钩子已执行 ${assembleCount} 次；最近一次 → ${lastAssemble}`,
      ].join('\n')
    },
  })

  // ── 元工具 2：开启服务 ────────────────────────────────────────────────────
  register({
    name: 'mcp_enable',
    description:
      '开启一个或多个受管的 MCP 工具服务。这些服务默认不载入上下文，' +
      '未开启时它们的工具不在你的工具列表里。' +
      'services 传服务名（逗号或空格分隔），传 all 开启全部。',
    parameters: {
      type: 'object',
      properties: {
        services: {
          type: 'string',
          description: '服务名，逗号/空格分隔，例如 "my-server, another-server"；或 all 表示全部',
        },
      },
      required: ['services'],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    execute(args) {
      const names = parseNames(args?.services)
      if (names.length === 0) return '未提供服务名。用法：mcp_enable(services="my-server, another-server")。'

      const known = gatedServers()
      const opened = []
      const already = []
      const unknown = []
      const wantsAll = names.includes('all')

      const targets = wantsAll ? known : names
      for (const target of targets) {
        if (gated !== undefined && !gated.has(target)) {
          unknown.push(target)
          continue
        }
        if (enabled.has(target)) already.push(target)
        else {
          enabled.add(target)
          lastUsed.set(target, Date.now())
          opened.push(target)
        }
      }

      const parts = []
      if (opened.length > 0) {
        parts.push(
          `已开启：${opened.join(', ')}。工具会在下一次提示词装配时出现；` +
            '若本回合内工具表未刷新，下一轮对话必定生效。' +
            (idleTtlMs > 0 ? `兜底：空闲 ${Math.round(idleTtlMs / 60000)} 分钟会自动关闭。` : '用完请主动 mcp_disable 关闭。'),
        )
      }
      if (already.length > 0) parts.push(`本来已开启：${already.join(', ')}。`)
      if (unknown.length > 0) parts.push(`未受管/未知服务：${unknown.join(', ')}（可用：${known.join(', ')}）。`)
      if (parts.length === 0) parts.push('没有变化。')
      return parts.join('\n')
    },
  })

  // ── 元工具 3：关闭服务 ────────────────────────────────────────────────────
  register({
    name: 'mcp_disable',
    description:
      '关闭已开启的受管 MCP 工具服务，关闭后这些工具不再出现在上下文里。' +
      'services 传服务名（逗号或空格分隔）或 all。任务不再需要该服务时可以主动关闭以释放配额。',
    parameters: {
      type: 'object',
      properties: {
        services: {
          type: 'string',
          description: '服务名，逗号/空格分隔；或 all 表示全部关闭',
        },
      },
      required: ['services'],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    execute(args) {
      const names = parseNames(args?.services)
      if (names.length === 0) return '未提供服务名。用法：mcp_disable(services="my-server")。'

      const closed = []
      const unknown = []
      const wantsAll = names.includes('all')
      const targets = wantsAll ? gatedServers() : names

      for (const target of targets) {
        if (gated !== undefined && !gated.has(target)) {
          unknown.push(target)
          continue
        }
        if (enabled.delete(target)) {
          lastUsed.delete(target)
          closed.push(target)
        }
      }

      const parts = []
      if (closed.length > 0) parts.push(`已关闭：${closed.join(', ')}。`)
      if (unknown.length > 0) parts.push(`未受管/未知服务：${unknown.join(', ')}。`)
      if (parts.length === 0) parts.push('没有变化（这些服务本来就没开启）。')
      return parts.join('\n')
    },
  })
}
