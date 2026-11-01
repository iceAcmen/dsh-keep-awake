/**
 * dsh-keep-awake -- browser artifact.
 *
 * Registers a card into the Plugins page's `plugins.item` slot. The card edits
 * the `dsh-keep-awake` profile entry's config through `configForms`, so a save
 * goes through the same transactional write the other settings pages use.
 *
 * The page only registers while the Host serves that namespace
 * (`configForms.whileServed`), so a deployment without this plugin shows no
 * trace of it.
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-keep-awake',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')

    const { SettingsForm, SettingsValueField, Switch, settingsNumberField, SettingsFormModel } = primitives

    /** Locale namespace owned by this plugin. */
    const NS = 'keepAwake'

    /** Profile entry id: both the config namespace and the loader entry id. */
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
     * A boolean field spec. The shared form ships only number/text helpers,
     * and a staged draft is text, so a boolean round-trips as 'true'/'false'.
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

    /** An enum field spec limited to the given values. */
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

    /** Bridges the entry's config section onto one staged form. */
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

      /** The face the slot registration injects. */
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

    /** One labelled switch row plus its hint line. */
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
     * Render the plugin's one-liner or its settings form, as the Plugins page asks.
     * @param props - the view asked for, locale copy, the form snapshot, and actions.
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

      ctx.effect(
        () =>
          ctx.configForms.whileServed([ENTRY_ID], (served) => {
            if (!served.has(ENTRY_ID)) return
            ctx.slots.inject('plugins.item', () =>
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
