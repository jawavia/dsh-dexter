/**
 * dsh-dexter client module — the authorize entry where the human expects it.
 *
 * Two buttons beside the composer:
 *
 *   授权  → sends `/dexter arm` with **no numbers**, so the value comes from the plugin
 *            settings (armMinutes / armActions / maxActionsPerMinute). A hardcoded
 *            15m/100 here is what made the settings page pointless for this button.
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
          onClick: () => press('/dexter arm', '授权'),
          style: buttonStyle,
          title: '开一次会话授权：时长/次数/频率都取设置里的值（armMinutes / armActions / maxActionsPerMinute）。会替换当前草稿。',
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

    /**
     * The two reasons the settings tab exists: the arm budget and its rate. Three numbers,
     * written through the host's settings document (`ctx.get('configForms')`), so the
     * values stick in the profile patch and the running plugin picks them up live.
     */
    const FIELDS = [
      { key: 'armMinutes', label: '授权时长（分钟）', min: 1, max: 480 },
      { key: 'armActions', label: '授权内最多动作次数', min: 1, max: 5000 },
      { key: 'maxActionsPerMinute', label: '每分钟动作上限（0 = 不限）', min: 0, max: 600 },
    ]
    // The Host settings entry id: a bundle-included row shows up as include:<name>, while a
    // profile-level row is just <name>. Try both and keep whichever answers.
    const ENTRY_IDS = ['include:dsh-dexter', 'dsh-dexter']

    function findForm(ctx) {
      try {
        const service = ctx.get('configForms')
        if (!service || typeof service.get !== 'function') return null
        for (const id of ENTRY_IDS) {
          try {
            const form = service.get(id)
            const snapshot = form && typeof form.getSnapshot === 'function' ? form.getSnapshot() : null
            if (snapshot) return { form, snapshot, entryId: id }
          } catch { /* try the next id */ }
        }
      } catch { /* no settings service in this composition */ }
      return null
    }

    /** Write one key through whatever write face this client version exposes. */
    async function writeKey(form, key, value) {
      const attempts = [
        () => form.set(key, value),
        () => form.mutate([{ kind: 'set', key, value }]),
        () => form.set({ [key]: value }),
        () => form.unset(key).then(() => form.set(key, value)),
      ]
      let last = null
      for (const attempt of attempts) {
        try {
          const result = attempt()
          if (result && typeof result.then === 'function') await result
          return { ok: true }
        } catch (error) {
          last = error
        }
      }
      return { ok: false, error: last && last.message ? last.message : String(last) }
    }

    function SettingsTab(props) {
      const ctx = props && props.ctx
      const resolved = React.useMemo(() => findForm(ctx), [ctx])
      const form = resolved ? resolved.form : null
      const snapshot = resolved ? resolved.snapshot : null
      const [values, setValues] = React.useState({})
      const [note, setNote] = React.useState('')

      React.useEffect(() => {
        if (!form || typeof form.subscribe !== 'function') return undefined
        const sync = () => {
          const next = form.getSnapshot()
          if (next && next.status === 'ready' && next.value && typeof next.value === 'object') {
            setValues(next.value)
          }
        }
        sync()
        return form.subscribe(sync)
      }, [form])

      if (!form) {
        return h('div', { style: { padding: 12, opacity: 0.8 } },
          '读不到本插件的设置文档。请确认插件已启用，然后用命令改：`/dexter set armMinutes 30`。')
      }

      const writable = snapshot && snapshot.writable === false ? false : true
      const save = async (key) => {
        const raw = values[key]
        const field = FIELDS.find((entry) => entry.key === key)
        const value = Number(raw)
        if (!Number.isFinite(value) || value < field.min || value > field.max) {
          setNote(`${field.label}：要在 ${field.min}..${field.max} 之间`)
          return
        }
        const result = await writeKey(form, key, Math.round(value))
        setNote(result.ok ? `已保存 ${key} = ${Math.round(value)}` : `保存失败：${result.error}`)
      }

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10, padding: 12, maxWidth: 460 } },
        h('div', { style: { fontSize: 13, opacity: 0.75 } }, '桌面双手：这三个数字决定一次授权能持续多久、能做多少动作、每分钟最多几下。改完立即生效，写入 profile 的配置补丁。'),
        ...FIELDS.map((field) => h('label', { key: field.key, style: { display: 'flex', alignItems: 'center', gap: 8 } },
          h('span', { style: { flex: '1 1 auto', fontSize: 13 } }, field.label),
          h('input', {
            type: 'number',
            min: field.min,
            max: field.max,
            value: values[field.key] === undefined ? '' : values[field.key],
            disabled: writable === false,
            onChange: (event) => setValues({ ...values, [field.key]: event.target.value }),
            style: { width: 96, padding: '4px 6px', borderRadius: 6, border: '1px solid rgba(127,127,127,.5)', background: 'transparent', color: 'inherit' },
          }),
          h('button', {
            type: 'button',
            onClick: () => void save(field.key),
            disabled: writable === false,
            style: { ...buttonStyle, height: 28 },
          }, '保存'),
        )),
        note ? h('div', { style: { fontSize: 12, opacity: 0.8 } }, note) : null,
        writable === false ? h('div', { style: { fontSize: 12, opacity: 0.7 } }, '这些值被更高优先级的配置层覆盖，界面不能改。') : null,
      )
    }

    return {
      inject: ['slots', 'configForms'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'hands-actions',
          order: 10,
        }, Dock))
        // A tab on the Built-in plugins page — where the official settings pages live. The
        // form is resolved inside the component, so the tab also appears when the settings
        // service is still warming up at apply time.
        ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
          name: 'settings.plugins.tab',
          id: 'dsh-dexter',
          order: 70,
          label: () => '桌面双手',
          inject: () => ({ ctx }),
        }, SettingsTab))
      },
    }
  },
})
