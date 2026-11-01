/**
 * dsh-keep-awake —— 浏览器端产物。
 *
 * 往「插件」页面的 `plugins.item` slot 注册一张卡片。卡片通过 `configForms`
 * 编辑 `dsh-keep-awake` 这个 profile 条目的配置，所以保存走的是和官方设置页
 * 完全同一套事务式写入。
 *
 * 只有宿主端供应了这个命名空间（`configForms.whileServed`）时才会注册，
 * 因此一个没装本插件的部署，看不出任何痕迹。
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-keep-awake',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')

    const { SettingsForm, SettingsValueField, Switch, settingsNumberField, SettingsFormModel } = primitives

    /** 本插件独占的 locale 命名空间。 */
    const NS = 'keepAwake'

    /** profile 条目 id：既是配置命名空间，也是 loader 条目 id。 */
    const ENTRY_ID = 'dsh-keep-awake'

    const zh = {
      title: '防睡眠 / 防息屏',
      description: 'DSH 工作期间保持电脑不休眠、不熄屏。',
      enabled: '启用自动保持',
      enabledHint: '开启后按下面的模式自动控制；关闭时本插件完全不生效。',
      mode: '保持模式',
      modeAlwaysHint: '开启后一直保持，直到你手动关闭。',
      modeFollowHint: '只在有任务运行时保持，空闲后自动释放。推荐。',
      always: '始终保持',
      keepDisplay: '同时保持屏幕常亮',
      keepDisplayHint: '关闭则只防睡眠，允许息屏省电。笔记本长期亮屏会发热。',
      grace: '空闲宽限（毫秒）',
      graceHint: '最后一个任务结束后继续保持的时间，避免任务之间反复启停。',
      poll: '检查间隔（毫秒）',
      pollHint: '多久检查一次任务状态。',
      unavailable: '本插件未加载，暂时无法配置。',
      readOnly: '本部署的设置为只读。',
      saveFailed: '部署未接受这些值，已保留供你修改。',
      save: '保存',
      saving: '保存中…',
      invalidNumber: '请填数字，留空表示使用默认值。',
      overridden: '已覆盖',
      reset: '恢复默认',
    }

    const en = {
      title: 'Keep awake',
      description: 'Keeps this machine from sleeping or turning its display off while DSH works.',
      enabled: 'Enable automatic keep-awake',
      enabledHint: 'When off, this plugin does nothing at all.',
      mode: 'Mode',
      modeAlwaysHint: 'Holds permanently until you turn it off.',
      modeFollowHint: 'Holds only while a task runs, releasing shortly after idle.',
      always: 'Always',
      keepDisplay: 'Keep the display on too',
      keepDisplayHint: 'Off: prevent sleep only, letting the display turn off to save power.',
      grace: 'Idle grace (ms)',
      graceHint: 'How long to keep holding after the last task ends, so steps do not churn the holder.',
      poll: 'Poll interval (ms)',
      pollHint: 'How often to re-check activity.',
      unavailable: 'This plugin is not loaded, so it cannot be configured right now.',
      readOnly: 'This deployment stores settings read-only.',
      saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
      save: 'Save',
      saving: 'Saving…',
      invalidNumber: 'Enter a number, or leave blank to use the default.',
      overridden: 'Overridden',
      reset: 'Reset to default',
    }

    /**
     * 布尔字段的规格。共享表单只提供 number 和 text 两种辅助函数，
     * 而暂存的草稿本质是文本，所以布尔值以 'true' / 'false' 往返。
     */
    function settingsBooleanField(field) {
      return {
        field,
        format: (value) => (value === true ? 'true' : value === false ? 'false' : ''),
        parse: (text) => {
          const trimmed = String(text).trim()
          if (trimmed === '') return { kind: 'clear' }
          if (trimmed === 'true') return { kind: 'set', value: true }
          if (trimmed === 'false') return { kind: 'set', value: false }
          return undefined
        },
      }
    }

    /** 枚举字段的规格，取值限定在给定集合内。 */
    function settingsEnumField(field, allowed) {
      return {
        field,
        format: (value) => (typeof value === 'string' && allowed.includes(value) ? value : ''),
        parse: (text) => {
          const trimmed = String(text).trim()
          if (trimmed === '') return { kind: 'clear' }
          return allowed.includes(trimmed) ? { kind: 'set', value: trimmed } : undefined
        },
      }
    }

    function formLabels(t) {
      return {
        unavailable: t('unavailable'),
        readOnly: t('readOnly'),
        saveFailed: t('saveFailed'),
        save: t('save'),
        saving: t('saving'),
      }
    }

    /** 把条目的配置节桥接到一份可暂存的表单上。 */
    class KeepAwakeController {
      constructor(scope) {
        this.form = new SettingsFormModel(scope, [
          settingsBooleanField('enabled'),
          settingsBooleanField('keepDisplay'),
          settingsEnumField('mode', ['follow', 'always']),
          settingsNumberField('graceMs'),
          settingsNumberField('pollIntervalMs'),
        ])
        this.store = this.form.bind(() => this.projection())
      }

      projection() {
        return {
          ...this.form.shell(),
          enabled: this.form.field('enabled'),
          keepDisplay: this.form.field('keepDisplay'),
          mode: this.form.field('mode'),
          graceMs: this.form.field('graceMs'),
          pollIntervalMs: this.form.field('pollIntervalMs'),
        }
      }

      /** slot 注册时注入给卡片的那份数据面。 */
      inject() {
        return {
          hooks: { keepAwakeCard: this.store },
          ...this.form.actions(),
        }
      }

      dispose() {
        this.form.dispose()
      }
    }

    /** 一行带标签的开关，以及它下面那行说明文字。 */
    function toggleRow(props) {
      const { label, hint, checked, disabled, onChange, rightSlot } = props
      return h('div', { className: 'dka-feature' }, [
        h(
          'label',
          { className: 'dka-toggleRow', key: 'row' },
          h('span', null, label),
          rightSlot ??
            h(Switch, {
              checked,
              label,
              disabled,
              onChange,
            }),
        ),
        h('p', { className: 'dka-hint', key: 'hint' }, hint),
      ])
    }

    /**
     * 按「插件」页的要求，渲染插件的一行简介，或者它的设置表单。
     * @param props - 请求的视图、本地化文案、表单快照，以及各种操作。
     */
    function KeepAwakeCard(props) {
      const { t } = props
      const state = props.useKeepAwakeCard((snapshot) => snapshot)
      if (props.view === 'summary') return t('description')

      const disabled = !state.writable || state.saving
      const boolOf = (field) => state[field].text === 'true'

      const numberField = (field, label, hint) =>
        h(SettingsValueField, {
          key: field,
          id: `plugin-config-keep-awake-${field}`,
          label,
          hint,
          numeric: true,
          disabled,
          overriddenLabel: t('overridden'),
          resetLabel: t('reset'),
          invalidLabel: t('invalidNumber'),
          ...state[field],
          onEdit: (text) => props.edit(field, text),
          onReset: () => props.resetField(field),
        })

      return h(
        SettingsForm,
        {
          labels: formLabels(t),
          state,
          onSave: props.save,
          onDiscard: props.discard,
        },
        [
          toggleRow({
            key: 'enabled',
            label: t('enabled'),
            hint: t('enabledHint'),
            checked: boolOf('enabled'),
            disabled,
            onChange: (checked) => props.edit('enabled', String(checked)),
          }),
          toggleRow({
            key: 'mode',
            label: t('mode'),
            hint: state.mode.text === 'always' ? t('modeAlwaysHint') : t('modeFollowHint'),
            checked: state.mode.text === 'always',
            disabled,
            onChange: (checked) => props.edit('mode', checked ? 'always' : 'follow'),
          }),
          toggleRow({
            key: 'keepDisplay',
            label: t('keepDisplay'),
            hint: t('keepDisplayHint'),
            checked: boolOf('keepDisplay'),
            disabled,
            onChange: (checked) => props.edit('keepDisplay', String(checked)),
          }),
          numberField('graceMs', t('grace'), t('graceHint')),
          numberField('pollIntervalMs', t('poll'), t('pollHint')),
        ],
      )
    }

    const inject = ['slots', 'locale', 'configForms']

    function apply(ctx) {
      const t = ctx.locale.bind(NS)

      ctx.effect(
        () =>
          ctx.locale.register(NS, {
            zh,
            en,
          }),
        'dsh-keep-awake: dictionaries',
      )

      const card = new KeepAwakeController(ctx.configForms.get(ENTRY_ID))

      ctx.effect(
        () => () => {
          card.dispose()
        },
        'dsh-keep-awake: form subscription',
      )

      // whileServed 会把 register 回调的返回值当作「是否已注册」的标志，
      // 并在命名空间离开服务集时回调它做清理。如果「未服务」那一支直接返回
      // undefined，那么设置镜像每刷新一次就会把同一个 slot id 重新注册一遍，
      // 第二次就会抛：
      //   下面这条是宿主日志里的原文（list slot "plugins.item" 已存在 id "keep-awake"）
      // 这个异常会中断订阅链，卡片在整个会话里都不会再注册上。
      // 所以这里必须始终返回一个真正的 disposer。
      ctx.effect(
        () =>
          ctx.configForms.whileServed([ENTRY_ID], (served) => {
            if (!served.has(ENTRY_ID)) return () => {}
            return ctx.slots.inject('plugins.item', () =>
              ctx.slots.register(
                {
                  name: 'plugins.item',
                  id: 'keep-awake',
                  order: 50,
                  label: () => t('title'),
                  locale: NS,
                  inject: () => card.inject(),
                },
                KeepAwakeCard,
              ),
            )
          }),
        'dsh-keep-awake: page',
      )
    }

    return { NS, inject, apply }
  },
})
