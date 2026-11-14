/**
 * dsh-dexter client module — the authorize entry where the human expects it.
 *
 * Two small buttons in the composer dock (the row that already owns input state, so the
 * buttons sit where the input is, not floating over the page):
 *
 *   授权   → fills `/dexter arm 15m 100` into the composer, so one click + Enter opens a
 *            bounded session (15 minutes / 100 actions / 30 per minute)
 *   面板   → fills `/dexter panel show`, which brings the desktop strip back
 *
 * Why fill the composer instead of calling a host API: granting authority is a user-only
 * action, and the composer is the one place every DSH version exposes to a plugin
 * (`inputActions.insertText`). Nothing here grants anything by itself — the human still
 * presses Enter, and the host command is what actually opens the grant.
 */
window.__ModuleLoader__.load({
  id: 'dsh-dexter',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const buttonStyle = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 4,
      height: 26,
      padding: '0 10px',
      borderRadius: 13,
      border: '1px solid rgba(127,127,127,.45)',
      background: 'transparent',
      color: 'inherit',
      font: '12px/1 system-ui, "Segoe UI", sans-serif',
      cursor: 'pointer',
      whiteSpace: 'nowrap',
    }

    function fill(inputActions, text) {
      try {
        if (inputActions && typeof inputActions.insertText === 'function') {
          inputActions.insertText(text)
          return 'ok'
        }
      } catch (error) {
        return String(error && error.message ? error.message : error)
      }
      return 'unavailable'
    }

    function Dock(props) {
      const inputActions = props && props.inputActions
      const [note, setNote] = React.useState('')
      const say = (text) => {
        setNote(text)
        const timer = setTimeout(() => setNote(''), 4000)
        return timer
      }
      const arm = () => {
        const result = fill(inputActions, '/dexter arm 15m 100')
        if (result === 'ok') say('已填入授权命令，回车生效')
        else if (result === 'unavailable') say('输入框不可用，请直接输入 /dexter arm')
        else say(`填入失败：${result}`)
      }
      const panel = () => {
        const result = fill(inputActions, '/dexter panel show')
        if (result === 'ok') say('已填入面板命令，回车唤回面板')
        else if (result === 'unavailable') say('请直接输入 /dexter panel show')
        else say(`填入失败：${result}`)
      }

      return h('div', {
        style: { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '0 4px' },
        title: 'dsh-dexter：授权 / 桌面面板',
      },
        h('button', { type: 'button', onClick: arm, style: buttonStyle, title: '填入手命令：/dexter arm 15m 100（回车即开授权）' }, '授权'),
        h('button', { type: 'button', onClick: panel, style: buttonStyle, title: '填入命令：/dexter panel show（回车唤回桌面面板）' }, '面板'),
        note ? h('span', { style: { fontSize: 11, opacity: 0.7 } }, note) : null,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'hands-actions',
          order: 10,
        }, Dock))
      },
    }
  },
})
