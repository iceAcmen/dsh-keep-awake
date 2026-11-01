/**
 * Client-artifact smoke test.
 *
 * The real browser module loader (`window.__ModuleLoader__`) is not available
 * under Node, so this test supplies a faithful stand-in: it captures the
 * `load({id, factory})` registration, then runs the factory with a `require`
 * shim that returns the React-shaped objects the plugin actually touches.
 *
 * What this catches: syntax faults inside the factory, a bad destructure of the
 * primitives module, an `apply()` that throws on a missing service, and any
 * reference to a name that was never defined. What it cannot catch: layout and
 * visual faults, which need a real browser.
 *
 * Run: node client-contract.mjs
 */

import { readFileSync } from 'node:fs'

let failures = 0
function check(label, condition, detail) {
  if (condition) console.log(`  PASS  ${label}`)
  else {
    failures += 1
    console.log(`  FAIL  ${label}${detail ? ` -- ${detail}` : ''}`)
  }
}

/* ---------- a faithful-enough module virtual machine ---------- */

/** Minimal React stand-in: createElement plus the hooks the card uses. */
const React = {
  createElement(type, props, children) {
    return { type, props: props ?? {}, children }
  },
  Component: class {
    constructor(props) {
      this.props = props
      this.state = {}
    }
  },
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
}

/** Primitives stand-in: the names the plugin destructures must all exist. */
const primitives = {
  SettingsForm: function SettingsForm() {},
  SettingsValueField: function SettingsValueField() {},
  SettingsSecretField: function SettingsSecretField() {},
  Switch: function Switch() {},
  settingsNumberField: (field) => ({
    field,
    format: (v) => (typeof v === 'number' ? String(v) : ''),
    parse: (text) => {
      const trimmed = text.trim()
      if (trimmed === '') return { kind: 'clear' }
      const n = Number(trimmed)
      return Number.isFinite(n) ? { kind: 'set', value: n } : undefined
    },
  }),
  SettingsFormModel: class {
    constructor(scope, specs) {
      this.scope = scope
      this.specs = new Map(specs.map((s) => [s.field, s]))
      this.staged = new Map()
    }
    shell() {
      return { available: true, writable: true, dirty: false, invalid: false, saving: false, failed: false }
    }
    field(field) {
      const spec = this.specs.get(field)
      const stored = this.scope.getSnapshot()?.sections?.base ?? {}
      return {
        text: spec.format(stored[field]),
        overridden: stored[field] !== undefined,
        invalid: false,
      }
    }
    bind(project) {
      const store = { get: () => project(), subscribe: () => () => {} }
      this.store = store
      return store
    }
    actions() {
      return {
        edit: (field, text) => this.staged.set(field, text),
        resetField: (field) => this.staged.set(field, null),
        save: () => {},
        discard: () => this.staged.clear(),
      }
    }
    dispose() {}
  },
}

const store = { createSnapshotStore: (initial) => ({ get: () => initial, set: () => {}, subscribe: () => () => {} }) }

/* ---------- capture the registration ---------- */

const registrations = []
globalThis.window = {
  __ModuleLoader__: {
    load(registration) {
      registrations.push(registration)
    },
  },
}

const source = readFileSync(new URL('./client.js', import.meta.url), 'utf8')
let loadError
try {
  // eslint-disable-next-line no-new-func -- executing the artifact is the point
  new Function('window', 'globalThis', source)(globalThis.window, globalThis)
} catch (error) {
  loadError = error
}

console.log('\n1. registration')
check('script executed without throwing', loadError === undefined, loadError && loadError.message)
check('registered exactly one module', registrations.length === 1, String(registrations.length))

const registration = registrations[0]
check('module id is the package name', registration?.id === '@local/dsh-keep-awake', registration?.id)
check('factory is a function', typeof registration?.factory === 'function')

console.log('\n2. factory materialization')
let exportsObject
let factoryError
try {
  exportsObject = registration.factory((specifier) => {
    if (specifier === 'react') return React
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    if (specifier === '@deepseek-ai/dsh-client-store') return store
    throw new Error(`unexpected require: ${specifier}`)
  })
} catch (error) {
  factoryError = error
}
check('factory ran without throwing', factoryError === undefined, factoryError && factoryError.message)
check('exports an apply function', typeof exportsObject?.apply === 'function')
check('exports the locale namespace', exportsObject?.NS === 'keepAwake', exportsObject?.NS)
check(
  'declares the three services it needs',
  Array.isArray(exportsObject?.inject) &&
    ['slots', 'locale', 'configForms'].every((name) => exportsObject.inject.includes(name)),
  JSON.stringify(exportsObject?.inject),
)

/* ---------- apply() against a stub context ---------- */

console.log('\n3. apply() wiring')
const effects = []
const registeredSlots = []
const localeNamespaces = []
const servedCallbacks = []

const ctx = {
  effect(fn, label) {
    effects.push({ label, disposer: fn() })
  },
  locale: {
    bind: (ns) => (key) => `${ns}.${key}`,
    register: (ns, dict) => {
      localeNamespaces.push(ns)
      if (dict) {
        check(`dictionary for ${ns} has zh and en`, Boolean(dict.zh) && Boolean(dict.en))
        check(`dictionary for ${ns} has a title`, Boolean(dict.zh?.title))
      }
    },
  },
  configForms: {
    get: (ns) => ({
      getSnapshot: () => ({ status: 'ready', writable: true, sections: { base: { enabled: true, mode: 'follow' } } }),
      subscribe: () => () => {},
    }),
    whileServed: (namespaces, callback) => {
      servedCallbacks.push({ namespaces, callback })
      callback(new Set(namespaces))
    },
  },
  slots: {
    inject: (slotName, fn) => fn(),
    register: (options, component) => registeredSlots.push({ options, component }),
  },
}

let applyError
try {
  exportsObject.apply(ctx)
} catch (error) {
  applyError = error
}
check('apply() ran without throwing', applyError === undefined, applyError && applyError.message)
check('registered a locale dictionary', localeNamespaces.includes('keepAwake'), localeNamespaces.join(','))
check('asked configForms to gate on the entry id', servedCallbacks.some((c) => c.namespaces.includes('dsh-keep-awake')))
check('registered into plugins.item', registeredSlots.length === 1, String(registeredSlots.length))

const slot = registeredSlots[0]
check('slot name is plugins.item', slot?.options?.name === 'plugins.item', slot?.options?.name)
check('slot id is keep-awake', slot?.options?.id === 'keep-awake', slot?.options?.id)
check('slot carries the injected form face', typeof slot?.options?.inject === 'function')

console.log('\n4. injected face')
let face
try {
  face = slot.options.inject()
} catch (error) {
  face = { error: error.message }
}
check('inject() returns hooks + actions', Boolean(face?.hooks?.keepAwakeCard) && typeof face?.save === 'function')
check('face offers edit/discard/resetField', ['edit', 'discard', 'resetField'].every((k) => typeof face[k] === 'function'))

console.log('\n5. component renders')
const component = slot.component
/** A snapshot shaped exactly like the controller's projection. */
const snapshot = {
  available: true,
  writable: true,
  dirty: false,
  invalid: false,
  saving: false,
  failed: false,
  enabled: { text: 'true', overridden: false, invalid: false },
  keepDisplay: { text: 'true', overridden: false, invalid: false },
  mode: { text: 'follow', overridden: false, invalid: false },
  graceMs: { text: '60000', overridden: false, invalid: false },
  pollIntervalMs: { text: '5000', overridden: false, invalid: false },
}

let summary
try {
  summary = component({ t: (k) => `t:${k}`, view: 'summary', useKeepAwakeCard: (sel) => sel(snapshot) })
} catch (error) {
  summary = `THREW: ${error.message}`
}
check('summary view renders text', typeof summary === 'string' && !summary.startsWith('THREW'), String(summary))
console.log(`  summary => ${JSON.stringify(summary)}`)

let form
try {
  form = component({
    t: (k) => `t:${k}`,
    view: 'form',
    useKeepAwakeCard: (sel) => sel(snapshot),
    edit: () => {},
    save: () => {},
    discard: () => {},
    resetField: () => {},
  })
} catch (error) {
  form = `THREW: ${error.message}`
}
check('form view renders an element', typeof form === 'object' && !String(form).startsWith('THREW'), String(form))
check('form is the SettingsForm', form?.type === primitives.SettingsForm, String(form?.type?.name ?? form?.type))

/* ---------- teardown ---------- */

console.log('\n6. disposal')
let disposeError
try {
  for (const effect of effects) {
    if (typeof effect.disposer === 'function') effect.disposer()
  }
} catch (error) {
  disposeError = error
}
check('disposing every effect does not throw', disposeError === undefined, disposeError && disposeError.message)

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}\n`)
process.exit(failures === 0 ? 0 : 1)
