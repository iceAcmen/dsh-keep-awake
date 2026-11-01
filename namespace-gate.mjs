/**
 * The settings-namespace gate, plus the volatile-value contract.
 *
 * Two things decide whether this plugin can appear as a settings page, and
 * both are easy to get wrong silently:
 *
 *   1. `settings.describe` filters every entry through `volatileForm`. A leaf
 *      field without `meta.volatile` contributes nothing, and a schema whose
 *      object subtree contributes nothing is dropped with no diagnostic —
 *      which is exactly why the browser card never registered.
 *   2. A `volatile()` field does not resolve to a plain value. `resolveConfig`
 *      hands `apply()` a wrapper with `get()`, so `config.enabled === true`
 *      is always false and the plugin never starts.
 *
 * This suite pins both.
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

/**
 * Verbatim replica of `@deepseek-ai/dsh-settings`'s `volatileForm`.
 *
 * Copied deliberately: importing the real one means reaching inside app.asar,
 * and the filter's behaviour is what this suite exists to pin down. If upstream
 * changes the filter, this copy is the line to re-read.
 */
function volatileForm(schema) {
  if (schema.meta.volatile) return { plain: true, type: schema.type }
  if (schema.type === 'object') {
    const dict = Object.fromEntries(
      Object.entries(schema.dict ?? {}).flatMap(([key, child]) => {
        const field = volatileForm(child)
        return field === undefined ? [] : [[key, field]]
      }),
    )
    return Object.keys(dict).length === 0 ? undefined : { type: 'object', dict }
  }
  return undefined
}

const mod = await import('./index.js')
const { Config, resolveSettings } = mod

console.log('\n1. Config export')
check('Config is exported', Config !== undefined && typeof Config === 'function')
check('Config has toJSON (describe requires it)', 'toJSON' in Config)

console.log('\n2. volatileForm gate — the reason the page never appeared')
const form = volatileForm(Config)
check('Config survives volatileForm', form !== undefined, 'undefined means describe drops the entry')
const fields = Object.keys(form?.dict ?? {})
check('all five fields are live', fields.length === 5, fields.join(','))
console.log(`  live fields: ${fields.join(', ')}`)

console.log('\n3. every leaf declares volatile')
const missing = Object.entries(Config.dict)
  .filter(([, child]) => !child.meta?.volatile)
  .map(([key]) => key)
check('no leaf lacks volatile', missing.length === 0, missing.join(','))

console.log('\n4. resolveConfig wraps volatile values — verify the shape')
const resolved = Config['~standard'].validate({ enabled: true }).value
check('enabled arrives wrapped', isVolatile(resolved.enabled), JSON.stringify(resolved.enabled))
check('mode arrives wrapped', isVolatile(resolved.mode), JSON.stringify(resolved.mode))

console.log('\n5. resolveSettings sees through the wrapper')
const settings = resolveSettings(resolved)
check('enabled true survives', settings.enabled === true, String(settings.enabled))
check('mode follow survives', settings.mode === 'follow', settings.mode)
check('keepDisplay true survives', settings.keepDisplay === true, String(settings.keepDisplay))
check('pollIntervalMs 5000 survives', settings.pollIntervalMs === 5000, String(settings.pollIntervalMs))
check('graceMs 60000 survives', settings.graceMs === 60000, String(settings.graceMs))

console.log('\n6. defaults, with and without the wrapper')
const defaults = Config['~standard'].validate({}).value
const plainDefaults = resolveSettings(defaults)
check('enabled defaults false', plainDefaults.enabled === false, String(plainDefaults.enabled))
check('mode defaults follow', plainDefaults.mode === 'follow', plainDefaults.mode)
check('keepDisplay defaults true', plainDefaults.keepDisplay === true, String(plainDefaults.keepDisplay))
// A raw plain object (no wrappers) must resolve identically.
const fromPlain = resolveSettings({ enabled: true, mode: 'always' })
check('plain object also accepted', fromPlain.enabled === true && fromPlain.mode === 'always')

console.log('\n7. invalid input is refused')
// The standard-schema entry point reports issues rather than throwing; only the
// callable form throws. Assert on the shape each one actually produces.
const result = Config['~standard'].validate({ mode: 'always-ish' })
check('standard validate reports an issue', Array.isArray(result.issues) && result.issues.length > 0, JSON.stringify(result.issues ?? null))
let thrownCallable = false
try {
  Config({ mode: 'always-ish' })
} catch {
  thrownCallable = true
}
check('callable form throws', thrownCallable)
let thrown = false
try {
  resolveSettings({ mode: 'always-ish' })
} catch {
  thrown = true
}
check('resolveSettings rejects unknown mode', thrown)

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}\n`)
process.exit(failures === 0 ? 0 : 1)
