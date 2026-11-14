/**
 * Client half of the tool-gate badge.
 *
 * Adds one small read-only chip to the assistant action row
 * (`conversation.chat.assistant-actions`, a list slot) so the tool-gate state is
 * visible on every assistant message:
 *
 *   [copy] [like] [dislike] [branch]  ( gate 0/9 )   usage 124K tok  22:14
 *
 * Design constraints, so the existing row keeps rendering exactly as before:
 * - the entry is last in the list and sizes itself to content (`flex: 0 0 auto`);
 * - it never positions itself absolutely and never wraps;
 * - it only reads Host state over two GET endpoints and degrades silently when
 *   they are missing or slow, because a throwing slot entry blanks its row;
 * - it owns no timers outside its own effect and clears them on unmount.
 *
 * State comes from the two gate plugins' read-only endpoints, never from
 * another plugin's DOM or internals.
 */

window.__ModuleLoader__.load({
  id: '@kongbaige010/dsh-tool-gate-badge',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Locale namespace owned by this plugin. */
    const NS = 'tool-gate-badge'

    const zh = {
      loading: 'MCP …',
      loadingTitle: '正在读取 MCP 工具门控状态',
      offline: 'MCP ?',
      offlineTitle: '状态端点不可用：host 侧门控插件未运行，或本 profile 没有 webServer',
      pendingTitle: '等待本轮提示词装配完成后才能统计受管工具数（点一下可立即重试）',
      badge: 'MCP 门控',
      titleHeader: 'MCP 工具门控（进程级：换顶层会话时清空，重启回到全关）',
      services: 'MCP 服务已开启',
      silenced: '本轮静默的受管 MCP 工具',
      groups: '低频工具组',
      on: '开',
      off: '关',
      none: '无',
    }

    const en = {
      loading: 'MCP …',
      loadingTitle: 'Reading MCP tool-gate state',
      offline: 'MCP ?',
      offlineTitle: 'State endpoint unavailable: the gate plugin is not running, or this profile has no webServer',
      pendingTitle: 'Waiting for the next prompt assembly to count managed tools (click to retry)',
      badge: 'MCP gate',
      titleHeader: 'MCP tool gate (process-wide: cleared on a new top-level session, all off after restart)',
      services: 'MCP services open',
      silenced: 'Managed MCP tools silenced this turn',
      groups: 'Low-frequency groups',
      on: 'on',
      off: 'off',
      none: 'none',
    }

    const CHIP = {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '4px',
      height: '20px',
      padding: '0 7px',
      margin: '0 2px',
      borderRadius: '10px',
      fontSize: '11px',
      lineHeight: '1',
      fontVariantNumeric: 'tabular-nums',
      whiteSpace: 'nowrap',
      flex: '0 0 auto',
      color: 'var(--dsw-alias-text-3, #8a8f99)',
      background: 'var(--dsw-alias-fill-2, rgba(128, 128, 128, 0.10))',
      cursor: 'pointer',
      userSelect: 'none',
    }

    /** Read one endpoint; any failure becomes null so the badge degrades instead of throwing. */
    function pull(path) {
      return fetch(path, { cache: 'no-store', headers: { accept: 'application/json' } })
        .then((response) => (response.ok ? response.json() : null))
        .catch(() => null)
    }

    function Badge(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => key
      const [snapshot, setSnapshot] = React.useState(null)
      const [offline, setOffline] = React.useState(false)
      const refreshRef = React.useRef(null)

      React.useEffect(() => {
        let alive = true
        const refresh = () => {
          Promise.all([pull('/plugin/tool-gate/mcp'), pull('/plugin/tool-gate/groups')])
            .then(([mcp, groups]) => {
              if (!alive) return
              setOffline(mcp === null && groups === null)
              setSnapshot({ mcp, groups })
            })
            .catch(() => {
              if (alive) setOffline(true)
            })
        }
        refreshRef.current = refresh
        refresh()
        const timer = setInterval(refresh, 20000)
        return () => {
          alive = false
          refreshRef.current = null
          clearInterval(timer)
        }
      }, [])

      let text = t('loading')
      let title = t('loadingTitle')

      if (offline) {
        text = t('offline')
        title = t('offlineTitle')
      } else if (snapshot !== null) {
        const mcp = snapshot.mcp
        const groups = snapshot.groups
        const open = Array.isArray(mcp?.opened) ? mcp.opened.length : 0
        const servers = typeof mcp?.servers === 'number' ? mcp.servers : 0
        const hidden = typeof mcp?.hidden === 'number' ? mcp.hidden : 0
        const total = typeof mcp?.total === 'number' ? mcp.total : 0
        const ready = mcp?.ready === true

        if (!ready) {
          // 宿主刚启动或还没装配过：不要用 0/0 冒充"没有工具"。
          text = t('loading')
          title = t('pendingTitle')
        } else {
          const groupLabels = Array.isArray(groups?.groups) && groups.groups.length > 0
            ? groups.groups.map((group) => `${group.name} ${group.enabled ? t('on') : t('off')}`).join(' · ')
            : t('none')

          text = `${t('badge')} ${open}/${servers}`
          title = [
            t('titleHeader'),
            `${t('services')}: ${open}/${servers}`,
            `${t('silenced')}: ${total > 0 ? `${hidden}/${total}` : '—'}`,
            `${t('groups')}: ${groupLabels}`,
          ].join('\n')
        }
      }

      return h('span', {
        title,
        role: 'status',
        'aria-label': title,
        onClick: () => {
          const refresh = refreshRef.current
          if (typeof refresh === 'function') refresh()
        },
        style: CHIP,
      }, text)
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'tool-gate-badge: dictionaries')
        const t = ctx.locale.bind(NS)
        ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
          name: 'conversation.chat.assistant-actions',
          id: 'tool-gate-badge',
          order: 40,
          locale: NS,
          inject: () => ({ t }),
        }, Badge))
      },
    }
  },
})
