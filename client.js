/**
 * Client half of the tool-gate badge.
 *
 * Adds one small read-only chip to the assistant action row
 * (`conversation.chat.assistant-actions`, a list slot) so the tool-gate state is
 * visible on every assistant message:
 *
 *   [copy] [like] [dislike] [branch]  ( gate 0/9 )   usage 124K tok  22:14
 *
 * Hovering the chip opens a styled read-only card (same visual language as the
 * usage popover: rounded surface, title row with an emphasised figure, hairline
 * divider, label/value rows). The native `title` attribute is deliberately NOT
 * used — it renders as a grey OS tooltip and cannot be styled.
 *
 * Design constraints, so the existing row keeps rendering exactly as before:
 * - the entry is last in the list and sizes itself to content (`flex: 0 0 auto`);
 * - the chip itself never positions itself absolutely and never wraps;
 * - the card is absolutely positioned *inside* a zero-size relative wrapper, so
 *   it cannot affect layout, and it is `pointer-events: none` so it never
 *   swallows clicks meant for the row;
 * - it only reads Host state over two GET endpoints and degrades silently when
 *   they are missing or slow, because a throwing slot entry blanks its row;
 * - it owns no timers outside its own effect and clears them on unmount.
 *
 * State comes from the two gate plugins' read-only endpoints, never from
 * another plugin's DOM or internals.
 */

window.__ModuleLoader__.load({
  id: '@kongbaige010/dsh-tool-gate',
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
      titleHeader: 'MCP 工具门控',
      titleHeaderNote: '进程级：换顶层会话时开启状态重置；重启回到配置',
      services: 'MCP 服务已开启',
      silenced: '本轮静默的受管工具',
      groups: '低频工具组',
      unitServices: '服务',
      on: '开',
      off: '关',
      none: '无',
      idle: '未纳管',
      stateOffline: '状态端点不可用',
    }

    const en = {
      loading: 'MCP …',
      loadingTitle: 'Reading MCP tool-gate state',
      offline: 'MCP ?',
      offlineTitle: 'State endpoint unavailable: the gate plugin is not running, or this profile has no webServer',
      pendingTitle: 'Waiting for the next prompt assembly to count managed tools (click to retry)',
      badge: 'MCP gate',
      titleHeader: 'MCP tool gate',
      titleHeaderNote: 'Process-wide: open state resets on a new session; restart returns to config',
      services: 'MCP services open',
      silenced: 'Managed MCP tools silenced this turn',
      groups: 'Low-frequency groups',
      unitServices: 'services',
      on: 'on',
      off: 'off',
      none: 'none',
      idle: 'idle',
      stateOffline: 'State endpoint unavailable',
    }

    /** The chip itself — unchanged from the shipped look. */
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

    /** Zero-size anchor: gives the card an offset parent without joining the row's flex flow. */
    const ANCHOR = {
      position: 'relative',
      display: 'inline-flex',
      flex: '0 0 auto',
    }

    /* ---- hover card: same specification as DSH's own `.lc-card` ----
     * layer-1 surface + border-l2 hairline + 10px radius + 14/16 padding: copying
     * the reference card's exact variable pair is what makes the surface tone
     * match on both light and dark themes. */

    const CARD = {
      position: 'absolute',
      bottom: 'calc(100% + 8px)',
      right: 0,
      zIndex: 60,
      boxSizing: 'border-box',
      minWidth: '300px',
      maxWidth: '340px',
      padding: '14px 16px',
      borderRadius: '10px',
      border: '1px solid var(--dsw-alias-border-l2)',
      background: 'var(--dsw-alias-bg-layer-1)',
      boxShadow: 'var(--dsw-shadow-lv3, 0 2px 8px #0000002e)',
      color: 'var(--dsw-alias-label-primary)',
      fontSize: '13px',
      lineHeight: 1.5,
      textAlign: 'left',
      whiteSpace: 'normal',
      fontVariantNumeric: 'tabular-nums',
      pointerEvents: 'none',
      userSelect: 'none',
    }

    const HEAD = { display: 'flex', alignItems: 'center', gap: '7px' }

    const HEAD_ICON = {
      width: '16px',
      height: '16px',
      flex: 'none',
      opacity: 0.75,
      color: 'var(--dsw-alias-label-secondary)',
    }

    const HEAD_LABEL = {
      fontSize: '15px',
      fontWeight: 600,
      whiteSpace: 'nowrap',
    }

    const HEAD_VALUE = {
      marginLeft: 'auto',
      paddingLeft: '12px',
      fontSize: '17px',
      fontWeight: 700,
      lineHeight: 1.2,
      whiteSpace: 'nowrap',
      color: 'var(--dsw-alias-label-primary)',
    }

    const HEAD_UNIT = {
      marginLeft: '4px',
      fontSize: '12px',
      fontWeight: 500,
      color: 'var(--dsw-alias-label-secondary)',
    }

    const DIVIDER = {
      height: '1px',
      margin: '12px 0 10px',
      background: 'var(--dsw-alias-border-l2)',
    }

    const ROW = {
      display: 'flex',
      alignItems: 'baseline',
      justifyContent: 'space-between',
      gap: '18px',
      padding: '4px 0',
    }

    const ROW_LABEL = {
      color: 'var(--dsw-alias-label-secondary)',
      fontSize: '13px',
      whiteSpace: 'nowrap',
    }

    const ROW_VALUE = {
      color: 'var(--dsw-alias-label-primary)',
      fontSize: '13px',
      fontWeight: 600,
      whiteSpace: 'nowrap',
      textAlign: 'right',
    }

    const SECTION = {
      marginTop: '6px',
      paddingTop: '8px',
      borderTop: '1px solid var(--dsw-alias-border-l2)',
    }

    const NOTE = {
      marginTop: '10px',
      color: 'var(--dsw-alias-label-tertiary)',
      fontSize: '11px',
      lineHeight: 1.5,
      whiteSpace: 'normal',
    }

    /** Read one endpoint; any failure becomes null so the badge degrades instead of throwing. */
    function pull(path) {
      return fetch(path, { cache: 'no-store', headers: { accept: 'application/json' } })
        .then((response) => (response.ok ? response.json() : null))
        .catch(() => null)
    }

    /** One label/value line of the card. */
    function Row(props) {
      return h('div', { style: ROW },
        h('span', { style: ROW_LABEL }, props.label),
        h('span', { style: ROW_VALUE }, props.value),
      )
    }

    /** Half-open door / gate glyph: reads as "what is let through". */
    function GateIcon() {
      return h('svg', {
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.4,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        style: HEAD_ICON,
        'aria-hidden': 'true',
      },
        h('path', { d: 'M2.5 4h11' }),
        h('path', { d: 'M2.5 8h6' }),
        h('path', { d: 'M2.5 12h3' }),
        h('circle', { cx: 12.6, cy: 12, r: 1.5, fill: 'currentColor', stroke: 'none' }),
      )
    }

    /** The hover card. Pure render: everything it shows comes from props. */
    function GateCard(props) {
      const t = props.t
      const mcp = props.mcp
      const groups = props.groups

      const ready = mcp != null && mcp.ready === true
      const open = Array.isArray(mcp?.opened) ? mcp.opened.length : 0
      const servers = typeof mcp?.servers === 'number' ? mcp.servers : 0
      const hidden = typeof mcp?.hidden === 'number' ? mcp.hidden : 0
      const total = typeof mcp?.total === 'number' ? mcp.total : 0

      const head = h('div', { style: HEAD },
        h(GateIcon),
        h('span', { style: HEAD_LABEL }, t('titleHeader')),
        h('span', { style: HEAD_VALUE },
          ready ? (servers > 0 ? `${open}/${servers}` : t('idle')) : '—',
          servers > 0 ? h('span', { style: HEAD_UNIT }, t('unitServices')) : null,
        ),
      )

      if (props.offline) {
        return h('div', { style: CARD }, head,
          h('div', { style: DIVIDER }),
          h('div', { style: ROW_LABEL }, t('stateOffline')),
          h('div', { style: NOTE }, t('offlineTitle')),
        )
      }

      if (!ready) {
        return h('div', { style: CARD }, head,
          h('div', { style: DIVIDER }),
          h('div', { style: NOTE }, t('pendingTitle')),
        )
      }

      const groupRows = Array.isArray(groups?.groups) && groups.groups.length > 0
        ? groups.groups.map((group) =>
          h(Row, {
            key: group.name,
            label: group.name,
            value: `${group.enabled ? t('on') : t('off')}${typeof group.tools === 'number' ? ` · ${group.tools}` : ''}`,
          }),
        )
        : [h(Row, { key: 'none', label: t('groups'), value: t('none') })]

      return h('div', { style: CARD },
        head,
        h('div', { style: DIVIDER }),
        h(Row, { label: t('services'), value: `${open} / ${servers}` }),
        h(Row, { label: t('silenced'), value: total > 0 ? `${hidden} / ${total}` : '—' }),
        h('div', { style: SECTION }, groupRows),
        h('div', { style: NOTE }, t('titleHeaderNote')),
      )
    }

    function Badge(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => key
      const [snapshot, setSnapshot] = React.useState(null)
      const [offline, setOffline] = React.useState(false)
      const [hovered, setHovered] = React.useState(false)
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
      let label = t('loadingTitle')

      if (offline) {
        text = t('offline')
        label = t('offlineTitle')
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
          label = t('pendingTitle')
        } else {
          const groupLabels = Array.isArray(groups?.groups) && groups.groups.length > 0
            ? groups.groups.map((group) => `${group.name} ${group.enabled ? t('on') : t('off')}`).join(' · ')
            : t('none')

          text = servers > 0 ? `${t('badge')} ${open}/${servers}` : `${t('badge')} · ${t('idle')}`
          label = [
            t('titleHeader'),
            `${t('services')}: ${servers > 0 ? `${open}/${servers}` : t('idle')}`,
            `${t('silenced')}: ${total > 0 ? `${hidden}/${total}` : '—'}`,
            `${t('groups')}: ${groupLabels}`,
          ].join('\n')
        }
      }

      // 停留意图：进入立即显示，离开后保留一小会儿再收起，避免指针穿过缝隙时闪烁。
      const show = () => setHovered(true)
      const hide = () => setHovered(false)

      return h('span', {
        style: ANCHOR,
        onMouseEnter: show,
        onMouseLeave: hide,
        onFocus: show,
        onBlur: hide,
      },
        h('span', {
          // 原生 title 会渲染成不可控的灰色系统提示，这里只用 aria-label 承载无障碍描述。
          'aria-label': label,
          role: 'status',
          onClick: () => {
            const refresh = refreshRef.current
            if (typeof refresh === 'function') refresh()
          },
          style: CHIP,
        }, text),
        hovered && snapshot !== null
          ? h(GateCard, { t, mcp: snapshot.mcp, groups: snapshot.groups, offline })
          : null,
      )
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
