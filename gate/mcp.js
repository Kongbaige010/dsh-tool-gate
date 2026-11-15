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
 * 本插件不内置任何服务名、服务清单或使用场景：受管范围默认为空——
 * 门控不干预任何服务，只有 config.gated 显式列出、或运行时用 mcp_gate 纳入的服务才受管。
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
  // 管辖范围：默认「一个都不管」——装了插件不改变任何现有行为。
  // 只有显式配置的 gated、或运行时用 mcp_gate 纳入的服务才会被门控。
  // 这是与其它可见性机制（reveal / restrict / 权限插件）共存的前提：
  // 门控只减自己点名的服务，别人管的东西一根手指都不碰。
  const managed = new Set(
    Array.isArray(cfg.gated) ? cfg.gated.map((name) => String(name).toLowerCase()) : [],
  )
  // 可选的展示文字：{ '<server>': { title, use } }，不影响门控行为。
  const catalog = cfg.catalog ?? {}
  // 例外：永远可见的工具名（受管服务里也不想藏的那些）。
  const alwaysVisible = new Set(cfg.alwaysVisible ?? [])
  // 宿主自带的系统级能力（桌面控制、CAD 预览）。它们不是"低频工具"：
  // 默认关掉会让模型突然失去基础能力、且完全无从得知原因（表现为"之前能用，现在不能"）。
  // 纳入管辖的服务默认关闭（纳管即省配额）；defaultEnabled 用来指定例外。
  // 默认开启的集合：显式配置优先，未配置时放行系统服务。
  const defaultEnabled = new Set(
    Array.isArray(cfg.defaultEnabled) ? cfg.defaultEnabled.map((name) => String(name).toLowerCase()) : [],
  )
  // 是否注入一行系统提示，告诉模型这套机制的存在。
  const hint = cfg.hint !== false
  // 空闲回收：默认关闭（0 = 纯主动开关，由模型在任务结束时 mcp_disable）。
  // 需要兜底时可在 profile 里配 idleTtlMs（毫秒），例如 3600000 = 1 小时兜底。
  const idleTtlMs = typeof cfg.idleTtlMs === 'number' && cfg.idleTtlMs >= 0 ? cfg.idleTtlMs : 0

  /** 已开启的服务名集合。进程级共享，故子代理天然继承父代理。初始含系统服务。 */
  const enabled = new Set(defaultEnabled)
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

  /** 纯解析工具名里的服务名，不判是否受管（供列出"可发现的服务"）。 */
  function mcpServerOf(toolName) {
    if (typeof toolName !== 'string' || !toolName.startsWith('mcp__')) return undefined
    const end = toolName.indexOf('__', 5)
    if (end < 0) return undefined
    return toolName.slice(5, end)
  }

  /** 工具名 → 受管服务名；不受管则返回 undefined（不受管 = 一律放行，门控不干预）。 */
  function serverOf(toolName) {
    const server = mcpServerOf(toolName)
    return server !== undefined && managed.has(server) ? server : undefined
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

  /** 当前受管的服务名列表。 */
  function gatedServers() {
    return [...managed].sort()
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

    // 换顶层会话 → 回到默认集合（不是空集：系统服务始终放行）。子代理不是顶层，从而继承父代理的开启状态。
    if (agent !== undefined && session !== undefined && isRoot(agent)) {
      if (rootSessionId !== undefined && rootSessionId !== session.id) {
        enabled.clear()
        for (const name of defaultEnabled) enabled.add(name)
      }
      rootSessionId = session.id
    }

    const allow = enabled
    const tally = new Map()
    const tools = []
    let gatedSeen = 0
    let passed = 0
    for (const tool of all) {
      const name = tool?.name
      // 先记录所有见过的 MCP 服务（含未受管的），供 mcp_services 列出可选项。
      const raw = mcpServerOf(name)
      if (raw !== undefined) seenServers.add(raw)
      const server = raw !== undefined && managed.has(raw) ? raw : undefined
      // 不受管，或显式豁免：原样保留。
      if (server === undefined || alwaysVisible.has(name)) {
        tools.push(tool)
        continue
      }
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
      (managed.size === 0
        ? '｜门控空转（当前无受管服务）'
        : gatedSeen === 0
          ? '｜⚠ 受管服务本次未出现在工具表中'
          : '')

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
          'MCP 工具可由门控按需注入以节省配额。门控默认不干预任何服务——只有被 mcp_gate 纳入管辖的服务才会被隐藏。' +
          '需要这类能力时，先调用 mcp_services 查看现状（受管 / 未受管 / 开启状态），再用 mcp_enable 开启，工具会在下一步装配时出现。' +
          '若发现某个工具或能力突然不见了，先查 mcp_services：可能是它所属的服务已被纳入管辖、且当前未开启。' +
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
      '列出 MCP 工具服务的现状：哪些被门控管辖、哪些未受管（始终可见），各自工具数量与开启状态。' +
      '需要某类 MCP 能力时先看这里，再决定 mcp_enable 还是 mcp_gate。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: TEXT_OUTPUT,
    execute() {
      const session = currentSession()
      const tally = session === undefined ? new Map() : (counts.get(session.id) ?? new Map())
      const managedList = gatedServers()
      const discovered = [...seenServers].sort()
      const unmanaged = discovered.filter((server) => !managed.has(server))
      const lineOf = (server, isManaged) => {
        const meta = catalog[server]
        const title = typeof meta?.title === 'string' ? meta.title : server
        const use = typeof meta?.use === 'string' ? meta.use : 'MCP 服务'
        const n = tally.get(server)
        const count = n === undefined ? '' : ` ${n} 个工具`
        const state = !isManaged ? '未受管·始终可见' : enabled.has(server) ? '已开启' : '未开启'
        return `- ${server} [${state}]${count} — ${title}：${use}`
      }
      const opened = managedList.filter((server) => enabled.has(server)).length
      const out = [
        `受管 MCP 工具服务（${managedList.length} 个，已开启 ${opened} 个）`,
        ...managedList.map((server) => lineOf(server, true)),
      ]
      if (managedList.length === 0) out.push('- （无）门控当前空转：没有服务被纳入管辖。')
      if (unmanaged.length > 0) {
        out.push('', `可发现但未受管（${unmanaged.length} 个，门控不干预，始终可见）`)
        out.push(...unmanaged.map((server) => lineOf(server, false)))
      }
      out.push(
        '',
        '用 mcp_gate(action="manage", services="…") 把服务纳入管辖（纳入后默认不载入，需 mcp_enable 才可见）；',
        'mcp_gate(action="unmanage", services="…") 移出管辖。开启状态是进程级的：所有会话共享，换新会话回到 defaultEnabled。',
        '',
        `诊断：装配钩子已执行 ${assembleCount} 次；最近一次 → ${lastAssemble}`,
      )
      return out.join('\n')
    },
  })

  // ── 元工具 2：管辖范围（"自己选择管控哪些"的入口）────────────────────────
  register({
    name: 'mcp_gate',
    description:
      '管理门控的管辖范围。默认没有任何服务受管，门控完全不干预。' +
      'manage=把 MCP 服务纳入管辖（纳入后默认不载入上下文，需要 mcp_enable 才可见）；' +
      'unmanage=移出管辖（移出后始终可见）；clear=清空全部管辖；list=查看当前范围。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['manage', 'unmanage', 'clear', 'list'],
          description: 'manage / unmanage / clear / list',
        },
        services: {
          type: 'string',
          description: '服务名，逗号/空格分隔；manage 与 unmanage 时需要',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    execute(args) {
      const action = String(args?.action ?? '').trim().toLowerCase()
      const names = parseNames(args?.services)
      const currentLine = () => {
        const current = gatedServers()
        return current.length === 0
          ? '当前没有服务受管：门控空转，所有 MCP 工具始终可见。'
          : `当前受管服务（${current.length} 个）：${current.join(', ')}`
      }
      if (action === 'list') {
        const unmanaged = [...seenServers].sort().filter((server) => !managed.has(server))
        return [
          currentLine(),
          unmanaged.length === 0 ? '' : `未受管但可发现：${unmanaged.join(', ')}`,
        ].filter((part) => part !== '').join('\n')
      }
      if (action === 'clear') {
        const removed = gatedServers()
        managed.clear()
        enabled.clear()
        for (const name of defaultEnabled) enabled.add(name)
        return removed.length === 0
          ? '管辖范围本来就是空的，无需清空。'
          : `已清空管辖范围（移除 ${removed.length} 个：${removed.join(', ')}）：门控不再干预任何 MCP 服务。`
      }
      if (action !== 'manage' && action !== 'unmanage') {
        return 'action 只能是 manage / unmanage / clear / list。'
      }
      if (names.length === 0) {
        return `action=${action} 需要提供 services，例如 services="my-server, another-server"。`
      }
      const changes = []
      for (const name of names) {
        if (action === 'manage') {
          if (managed.has(name)) continue
          managed.add(name)
          changes.push(`+ ${name}`)
          if (defaultEnabled.has(name)) enabled.add(name)
        } else if (managed.delete(name)) {
          enabled.delete(name)
          lastUsed.delete(name)
          changes.push(`- ${name}`)
        }
      }
      return [
        changes.length === 0 ? '范围没有变化。' : `已更新管辖范围：${changes.join('，')}。`,
        currentLine(),
        action === 'manage'
          ? '纳入的服务默认不载入上下文，需要 mcp_enable 开启；下一步装配时生效。'
          : '移出的服务不再被门控干预，始终可见。',
      ].join('\n')
    },
  })

  // ── 元工具 3：开启服务 ────────────────────────────────────────────────────
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
        if (!managed.has(target)) {
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

  // ── 元工具 4：关闭服务 ────────────────────────────────────────────────────
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
        if (!managed.has(target)) {
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
