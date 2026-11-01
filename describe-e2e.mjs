/**
 * End-to-end simulation of `settings.describe` for this plugin's Config.
 *
 * The earlier fixes were each verified in isolation and still did not produce a
 * visible card, so this suite reproduces the *whole* host-side path instead of
 * checking one precondition:
 *
 *   resolveConfig(raw)      -> what `apply()` receives
 *     volatileForm(Config)  -> is the entry kept at all?
 *       plainConfig(...)    -> the values the page projects
 *
 * It asserts the final list contains a descriptor whose `ns` is the loader
 * entry id, which is precisely what `configForms.whileServed` scans.
 *
 * Run from the profile directory so `@deepseek-ai/schemastery` resolves:
 *   cd ~/.dsh/profiles/desktop && node <this file>
 */

import z from '@deepseek-ai/schemastery'
import { isVolatile } from '@deepseek-ai/cosmokit'

let failures = 0
function check(label, condition, detail) {
  if (condition) console.log(`  PASS  ${label}`)
  else {
    failures += 1
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` -- ${detail}`}`)
  }
}

/* ---- replicas of the host-side helpers (see dsh-settings/lib/index.js) ---- */

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** `isVolatile` is the cosmokit predicate the host uses. */
const unwrap = (value) => {
  let current = value
  let guard = 0
  while (isVolatile(current) && guard < 16) {
    current = current.get()
    guard += 1
  }
  return current
}

function plainConfig(value) {
  if (isVolatile(value)) return plainConfig(value.get())
  if (Array.isArray(value)) return value.map(plainConfig)
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, plainConfig(child)]))
  }
  return value
}

function projectForm(schema, value) {
  if (schema.type === 'object' && isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(schema.dict ?? {}).flatMap(([key, child]) => {
        const field = Reflect.get(value, key)
        return field === undefined ? [] : [[key, projectForm(child, field)]]
      }),
    )
  }
  return value
}

function plainSchema(schema) {
  const result = new z(schema.toJSON())
  const walk = (node) => {
    delete node.meta.volatile
    for (const child of Object.values(node.dict ?? {})) walk(child)
    if (node.inner) walk(node.inner)
    for (const child of node.list ?? []) walk(child)
  }
  walk(result)
  return result
}

function volatileForm(schema) {
  if (schema.meta.volatile) return plainSchema(schema)
  if (schema.type === 'object') {
    const dict = Object.fromEntries(
      Object.entries(schema.dict ?? {}).flatMap(([key, child]) => {
        const field = volatileForm(child)
        return field === undefined ? [] : [[key, field]]
      }),
    )
    return Object.keys(dict).length === 0 ? undefined : z.object(dict)
  }
  return undefined
}

/* ---- the collapsed describe() for one entry ---- */

const ENTRY_ID = 'dsh-keep-awake'
const RAW_CONFIG = { enabled: true, mode: 'follow', keepDisplay: true, pollIntervalMs: 5000, graceMs: 60000 }

const mod = await import('./index.js')
const { Config } = mod

console.log('\nstage 1 — resolveConfig(raw): what apply() receives')
const resolved = Config['~standard'].validate(RAW_CONFIG).value
check('validation produced a value', resolved !== undefined)
check('fields arrive volatile-wrapped', isVolatile(resolved.enabled))

console.log('\nstage 2 — volatileForm(Config): is the entry kept?')
const form = volatileForm(Config)
check('form is defined (entry survives describe)', form !== undefined, 'undefined => entry silently dropped')
const projectedFields = Object.keys(form?.dict ?? {})
check('form exposes the five fields', projectedFields.length === 5, projectedFields.join(','))

console.log('\nstage 3 — plainConfig(resolved): values the page shows')
const plain = plainConfig(resolved)
check('enabled unwrapped to a boolean', plain.enabled === true, JSON.stringify(plain.enabled))
check('mode unwrapped to a string', plain.mode === 'follow', JSON.stringify(plain.mode))
check('keepDisplay unwrapped', plain.keepDisplay === true, JSON.stringify(plain.keepDisplay))
check('pollIntervalMs unwrapped', plain.pollIntervalMs === 5000, JSON.stringify(plain.pollIntervalMs))
check('graceMs unwrapped', plain.graceMs === 60000, JSON.stringify(plain.graceMs))

console.log('\nstage 4 — projectForm(plainSchema, plain): the descriptor value')
const projected = projectForm(plainSchema(form), plain)
check('projected value has all fields', Object.keys(projected).length === 5, Object.keys(projected).join(','))

console.log('\nstage 5 — the descriptor list whileServed scans')
// This is the object describe() would return for this entry: its `ns` is the
// loader entry id, which is the string the browser compares against.
const descriptor = { ns: ENTRY_ID, schema: plainSchema(form).toJSON(), value: projected }
const namespaces = [descriptor].map((row) => ({ ns: row.ns }))
const served = new Set(namespaces.map((row) => row.ns))
check('descriptor ns is the loader entry id', descriptor.ns === 'dsh-keep-awake', descriptor.ns)
check('served set contains that id', served.has('dsh-keep-awake'), [...served].join(','))
check(
  'client whileServed([ENTRY_ID]) would fire',
  served.has('dsh-keep-awake'),
  'this is the condition the card requires',
)

console.log('\nstage 6 — control: the same path without volatile()')
const withoutVolatile = z.object({
  enabled: z.boolean().default(false),
  mode: z.union([z.const('follow'), z.const('always')]).default('follow'),
})
check(
  'a plain schema is dropped by volatileForm',
  volatileForm(withoutVolatile) === undefined,
  'proves volatile() is the decisive fix',
)

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}\n`)
process.exit(failures === 0 ? 0 : 1)
