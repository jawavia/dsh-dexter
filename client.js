/**
 * dsh-dexter client module — a floating status chip you can drag anywhere and hide.
 *
 * Why an overlay: a widget that sits in a fixed flow position either covers the taskbar
 * (bottom) or bumps into the app's own header/overlays (top). So this one is
 * viewport-positioned, draggable, clamped inside the window, and hideable; the position
 * and hidden state live in localStorage and survive reloads.
 *
 * It is intentionally dumb: it shows the four commands that matter and nothing else. It
 * never reads the page's DOM, never touches another plugin's styles, and adds no global
 * CSS — every style is inline, so unmounting removes everything.
 */
window.__ModuleLoader__.load({
  id: 'dsh-dexter',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const STORE_KEY = 'dsh-dexter.panel.v1'
    const SIZE = { w: 176, h: 34 }
    const EDGE = 8

    function readState() {
      try {
        const raw = window.localStorage.getItem(STORE_KEY)
        return raw ? JSON.parse(raw) : {}
      } catch {
        return {}
      }
    }

    function writeState(patch) {
      try {
        window.localStorage.setItem(STORE_KEY, JSON.stringify({ ...readState(), ...patch }))
      } catch {
        /* private mode / quota — the widget still works, it just forgets */
      }
    }

    /**
     * Keep the chip inside the window. The window is what we can see: the Windows taskbar
     * lives outside it, so an in-page overlay can never cover the taskbar — only the
     * window's own edges. Clamping here is what stops "it slides under the composer".
     */
    function clamp(point) {
      const maxX = Math.max(EDGE, window.innerWidth - SIZE.w - EDGE)
      const maxY = Math.max(EDGE, window.innerHeight - SIZE.h - EDGE)
      return {
        x: Math.min(maxX, Math.max(EDGE, Math.round(point.x))),
        y: Math.min(maxY, Math.max(EDGE, Math.round(point.y))),
      }
    }

    function defaultPosition() {
      // Top-right, a little below the header: the spot that is free on a fresh window.
      return clamp({ x: window.innerWidth - SIZE.w - 24, y: 88 })
    }

    const baseStyle = {
      position: 'fixed',
      zIndex: 2147483000,
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      height: SIZE.h,
      padding: '0 8px',
      borderRadius: 999,
      border: '1px solid rgba(127,127,127,.45)',
      background: 'rgba(127,127,127,.16)',
      backdropFilter: 'blur(10px)',
      WebkitBackdropFilter: 'blur(10px)',
      color: 'inherit',
      font: '12px/1 system-ui, "Segoe UI", sans-serif',
      boxShadow: '0 4px 16px rgba(0,0,0,.18)',
      userSelect: 'none',
      touchAction: 'none',
      cursor: 'grab',
    }

    function Panel() {
      const stored = React.useMemo(readState, [])
      const [pos, setPos] = React.useState(() => {
        if (Number.isFinite(stored.x) && Number.isFinite(stored.y)) return clamp({ x: stored.x, y: stored.y })
        return defaultPosition()
      })
      const [hidden, setHidden] = React.useState(stored.hidden === undefined ? true : stored.hidden === true)
      const [open, setOpen] = React.useState(false)
      const [drag, setDrag] = React.useState(null)
      const posRef = React.useRef(pos)
      posRef.current = pos

      React.useEffect(() => {
        const onResize = () => setPos((current) => clamp(current))
        window.addEventListener('resize', onResize)
        onResize()
        return () => window.removeEventListener('resize', onResize)
      }, [])

      const onPointerDown = (event) => {
        if (event.button !== 0) return
        setDrag({ dx: event.clientX - posRef.current.x, dy: event.clientY - posRef.current.y })
        try {
          event.currentTarget.setPointerCapture(event.pointerId)
        } catch {
          /* capture is a nicety */
        }
      }

      const onPointerMove = (event) => {
        if (!drag) return
        setPos(clamp({ x: event.clientX - drag.dx, y: event.clientY - drag.dy }))
      }

      const onPointerUp = () => {
        if (!drag) return
        setDrag(null)
        writeState({ x: posRef.current.x, y: posRef.current.y })
      }

      const hide = (event) => {
        event.stopPropagation()
        setHidden(true)
        setOpen(false)
        writeState({ hidden: true })
      }

      const show = () => {
        setHidden(false)
        writeState({ hidden: false })
      }

      const reset = () => {
        const next = defaultPosition()
        setPos(next)
        writeState({ x: next.x, y: next.y })
      }

      if (hidden) {
        // A 14 px tab on the right edge: always reachable, never in the way.
        return h('div', {
          role: 'button',
          title: 'hands 状态条（点一下显示）',
          onClick: show,
          style: {
            position: 'fixed',
            right: 0,
            top: '50%',
            transform: 'translateY(-50%)',
            zIndex: 2147483000,
            width: 14,
            height: 56,
            borderRadius: '8px 0 0 8px',
            border: '1px solid rgba(127,127,127,.45)',
            borderRight: 'none',
            background: 'rgba(127,127,127,.18)',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'inherit',
            font: '10px/1 system-ui, sans-serif',
            writingMode: 'vertical-rl',
          },
        }, 'hands')
      }

      const rows = [
        ['拖我', '按住这块拖动'],
        ['隐藏', '点右上的 × ，从右侧小条唤回'],
        ['状态', '/dexter status'],
        ['授权', '/dexter arm 15m 100'],
        ['急停', '/dexter stop 或 Ctrl+Alt+F11'],
      ]

      return h('div', {
        onPointerDown,
        onPointerMove,
        onPointerUp,
        onPointerCancel: onPointerUp,
        onDoubleClick: () => setOpen((value) => !value),
        style: { ...baseStyle, left: pos.x, top: pos.y, width: open ? 300 : SIZE.w, height: 'auto', minHeight: SIZE.h, flexDirection: 'column', alignItems: 'stretch', padding: open ? '8px 10px' : '0 8px', cursor: drag ? 'grabbing' : 'grab' },
      },
        open
          ? null
          : h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, height: SIZE.h - 2 } },
            h('span', { style: { width: 7, height: 7, borderRadius: '50%', background: '#3fbf6f', flex: 'none' } }),
            h('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, 'hands'),
            h('span', { onClick: hide, title: '隐藏', style: { cursor: 'pointer', padding: '0 4px', opacity: 0.75 } }, '×'),
          ),
        open
          ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 } },
            h('span', { style: { width: 7, height: 7, borderRadius: '50%', background: '#3fbf6f', flex: 'none' } }),
            h('span', { style: { flex: 1, fontWeight: 600 } }, 'dsh-dexter'),
            h('span', { onClick: reset, title: '复位到右上角', style: { cursor: 'pointer', padding: '0 4px', opacity: 0.75 } }, '⌂'),
            h('span', { onClick: hide, title: '隐藏', style: { cursor: 'pointer', padding: '0 4px', opacity: 0.75 } }, '×'),
          )
          : null,
        open
          ? h('div', { style: { display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 10px', fontSize: 11, lineHeight: 1.5 } },
            rows.map(([key, value]) => [
              h('span', { key: `k-${key}`, style: { opacity: 0.6 } }, key),
              h('span', { key: `v-${key}`, style: { wordBreak: 'break-all' } }, value),
            ]).flat(),
            h('span', { key: 'hint', style: { gridColumn: '1 / -1', opacity: 0.55, marginTop: 2 } }, '双击展开/收起'),
          )
          : null,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'hands-pill', order: 50 }, Panel))
      },
    }
  },
})
