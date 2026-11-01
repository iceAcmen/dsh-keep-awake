/**
 * Reproduce the duplicate-registration bug against a faithful slot registry.
 *
 * The real failure observed in the host log was:
 *
 *   [client-store] subscriber failed: Error: list slot "plugins.item" already
 *   has an entry with id "keep-awake" at priority 0
 *
 * A list slot throws on a second registration with the same id at the same
 * priority. `configForms.whileServed` memoizes the register callback's return
 * value as its "already registered" flag, so a callback that returns undefined
 * looks unregistered on the next settings-mirror emission and registers again.
 *
 * This suite runs the artifact's `apply()` against a registry that throws like
 * the real one, and asserts the slot ends up registered exactly once.
 *
 * Run: node registration-conflict.mjs
 */

import { readFileSync } from 'node:fs'

const TARGET = 'C:/Users/ASUS/.dsh/profiles/desktop/node_modules/@local/dsh-keep-awake/client.js'

let failures = 0
function check(label, condition, detail) {
  if (condition) console.log(`  PASS  ${label}`)
  else {
    failures += 1
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` -- ${detail}`}`)
  }
}

/* ---------- module stand-ins ---------- */

const React = {
  createElement: (type, props, children) => ({ type, props: { ...(props ?? {}), children } }),
  Component: class {},
  useState: (v) => [v, () => {}],
  useEffect: () => {},
  useMemo: (f) => f(),
  useRef: () => ({ current: null }),
  useCallback: (f) => f,
  useSyncExternalStore: (_s, g) => g(),
}

const primitives = {
  SettingsForm: function SettingsForm() {},
  SettingsValueField: function SettingsValueField() {},
  SettingsSecretField: function SettingsSecretField() {},
  Switch: function Switch() {},
  settingsNumberField: (field) => ({
    field,
    format: (v) => String(v ?? ''),
    parse: (t) => ({ kind: 'set', value: t }),
  }),
  SettingsFormModel: class {
    shell() {
      return { available: true, writable: true, dirty: false, invalid: false, saving: false, failed: false }
    }
    field() {
      return { text: '', overridden: false, invalid: false }
    }
    bind(project) {
      return { get: () => project(), subscribe: () => () => {} }
    }
    actions() {
      return { edit() {}, resetField() {}, save() {}, discard() {} }
    }
    dispose() {}
  },
}

const registrations = []
globalThis.window = { __ModuleLoader__: { load: (r) => registrations.push(r) } }
new Function('window', 'globalThis', readFileSync(TARGET, 'utf8'))(globalThis.window, globalThis)

const mod = registrations[0].factory((specifier) => {
  if (specifier === 'react') return React
  if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return primitives
  throw new Error(`unexpected require: ${specifier}`)
})

/* ---------- a registry that throws like the real one ---------- */

/** Mirrors `dsh-client-ui-slots`' list-slot collision rule. */
function makeRegistry() {
  const entries = []
  return {
    entries,
    registerCalls: 0,
    register(options) {
      this.registerCalls += 1
      const occupant = entries.find((e) => e.id === options.id && (options.priority ?? 0) === (e.priority ?? 0))
      if (occupant) {
        throw new Error(`list slot "${options.name}" already has an entry with id "${options.id}"`)
      }
      entries.push({ id: options.id, priority: options.priority ?? 0 })
      return () => {
        const at = entries.findIndex((e) => e.id === options.id)
        if (at !== -1) entries.splice(at, 1)
      }
    },
  }
}

/** Mirrors `SettingsForms.whileServed`, including its `off` memoization. */
function whileServedLike(namespaces, callback, emitCount) {
  let off
  const sync = (servedSet) => {
    const watched = namespaces.some((ns) => servedSet.has(ns))
    if (watched && off === undefined) off = callback(servedSet)
    else if (!watched && off !== undefined) {
      if (typeof off === 'function') off()
      off = undefined
    }
  }
  for (let i = 0; i < emitCount; i += 1) sync(new Set(namespaces))
  return () => {
    if (typeof off === 'function') off()
  }
}

/* ---------- the check ---------- */

console.log('\n1. three settings-mirror emissions must register once')

const registry = makeRegistry()
const ctx = {
  locale: { bind: () => (k) => k, register: () => () => {} },
  effect: (fn) => fn(),
  logger: { info() {}, error() {} },
  configForms: {
    get: () => ({ getSnapshot: () => ({ status: 'ready', writable: true }), subscribe: () => () => {} }),
    whileServed: (namespaces, callback) => whileServedLike(namespaces, callback, 3),
  },
  slots: {
    inject: (_name, fn) => fn(),
    register: (options, component) => registry.register(options, component),
  },
}

let applyError
try {
  mod.apply(ctx)
} catch (error) {
  applyError = error
}

check('apply() does not throw', applyError === undefined, applyError?.message)
check('registry.register called once', registry.registerCalls === 1, `called ${registry.registerCalls}×`)
check('one slot entry present', registry.entries.length === 1, `${registry.entries.length} entries`)
check('the entry id is keep-awake', registry.entries[0]?.id === 'keep-awake', registry.entries[0]?.id)

console.log('\n2. the register callback returns a real disposer')
// Call whileServed directly to inspect what the callback hands back; a
// non-function return is what made the flag stay undefined before.
const probeRegistry = makeRegistry()
let returned
const probeCtx = {
  ...ctx,
  configForms: {
    get: ctx.configForms.get,
    whileServed: (namespaces, callback) => {
      returned = callback(new Set(namespaces))
      return () => {}
    },
  },
  slots: {
    inject: (_n, fn) => fn(),
    register: (o, c) => probeRegistry.register(o, c),
  },
}
try {
  mod.apply(probeCtx)
} catch (error) {
  console.log(`  (probe apply threw: ${error.message})`)
}
check('callback returns a function disposer', typeof returned === 'function', typeof returned)
check('probe registered once', probeRegistry.registerCalls === 1, `${probeRegistry.registerCalls}×`)

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}\n`)
process.exit(failures === 0 ? 0 : 1)
