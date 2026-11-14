/**
 * dsh-dexter client module — the authorize entry where the human expects it.
 *
 * Two buttons beside the composer:
 *
 *   授权  → sends `/dexter arm 15m 100` (15 minutes / 100 actions / 30 per minute)
 *   面板  → sends `/dexter panel show` (brings the desktop strip back)
 *
 * Both go through the documented InputActions facet of the composer
 * (`captureInsertion` / `insertText` / `setDraft` / `submit`), because granting authority
 * has to be the human's own action: the click is the human's, and the host command is what
 * actually opens the grant. If the draft already held text, replacing it is reported in the
 * note instead of silently swallowed.
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

    function currentDraft(props) {
      try {
        const state = props && props.input
        if (state && typeof state.draft === 'string') return state.draft
      } catch { /* input state is optional */ }
      return ''
    }

    /** Send one command through the composer, using only documented InputActions. */
    function send(inputActions, command) {
      if (!inputActions || typeof inputActions.setDraft !== 'function') return 'unavailable'
      try {
        if (typeof inputActions.captureInsertion === 'function' && typeof inputActions.insertText === 'function') {
          const span = inputActions.captureInsertion()
          const inserted = inputActions.insertText(command, span)
          if (inserted === false) inputActions.setDraft(command)
        } else {
          inputActions.setDraft(command)
        }
        if (typeof inputActions.submit === 'function') {
          inputActions.submit()
          return 'sent'
        }
        return 'filled'
      } catch (error) {
        return `error: ${error && error.message ? error.message : error}`
      }
    }

    function Dock(props) {
      const inputActions = props && props.inputActions
      const [note, setNote] = React.useState('')
      const say = (text) => {
        setNote(text)
        setTimeout(() => setNote(''), 5000)
      }
      const press = (command, what) => {
        const hadDraft = currentDraft(props).trim() !== ''
        const result = send(inputActions, command)
        if (result === 'sent') say(`${what}已发送${hadDraft ? '（原有草稿已被替换）' : ''}`)
        else if (result === 'filled') say(`${what}已填入，回车生效`)
        else if (result === 'unavailable') say('输入框接口不可用，请直接输入 /dexter arm')
        else say(`失败：${result.replace(/^error: /, '')}`)
      }

      return h('div', {
        style: { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '0 4px' },
        title: 'dsh-dexter：授权 / 桌面面板',
      },
        h('button', {
          type: 'button',
          onClick: () => press('/dexter arm 15m 100', '授权'),
          style: buttonStyle,
          title: '开一次会话授权：15 分钟 / 100 次（频率 30/分）。会替换当前草稿。',
        }, '授权'),
        h('button', {
          type: 'button',
          onClick: () => press('/dexter panel show', '面板命令'),
          style: buttonStyle,
          title: '把桌面小条叫回来（/dexter panel show）。会替换当前草稿。',
        }, '面板'),
        note ? h('span', { style: { fontSize: 11, opacity: 0.75 } }, note) : null,
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
