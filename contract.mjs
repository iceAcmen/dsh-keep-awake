/**
 * Load-contract test: apply the plugin through a minimal cordis-like context
 * and assert the tool it registers is well-formed for the real registry.
 *
 * This does not boot cordis itself (the real one lives inside app.asar); it
 * checks the parts a wrong plugin can get wrong: exported seams, config
 * validation, tool shape, and that `execute` never throws on the happy path.
 *
 * Run: node contract.mjs
 */

import { apply, inject, name, resolveSettings } from './index.js'

let failures = 0
function check(label, condition, detail) {
  if (condition) console.log(`  PASS  ${label}`)
  else {
    failures += 1
    console.log(`  FAIL  ${label}${detail ? ` -- ${detail}` : ''}`)
  }
}

console.log('\nexports')
check('name is keep-awake', name === 'keep-awake', name)
check('injects tools + agents', inject.includes('tools') && inject.includes('agents'), inject.join(','))

console.log('\ntool shape')
const registered = []
const ctx = {
  agents: { list: () => [{ status: 'running' }, { status: 'idle' }] },
  tools: { register: (d) => registered.push(d) },
  effect: (fn) => fn(),
}
const controller = apply(ctx, { enabled: false, mode: 'follow', keepDisplay: true })
const tool = registered[0]

check('exactly one tool registered', registered.length === 1, String(registered.length))
check('tool name', tool.name === 'keep_awake', tool.name)
check('has description', typeof tool.description === 'string' && tool.description.length > 20)
check('parameters is an object schema', tool.parameters?.type === 'object')
check(
  'action enum',
  tool.parameters?.properties?.action?.enum?.join(',') === 'status,on,off,auto',
  String(tool.parameters?.properties?.action?.enum),
)
check('output schema present', tool.output?.schema?.type === 'object')
check('output render is fn', typeof tool.output?.render === 'function')
check('execute is fn', typeof tool.execute === 'function')

console.log('\nrender does not throw on the declared shape')
const sample = {
  action: 'status',
  running: true,
  reason: 'manual-on',
  enabled: false,
  mode: 'follow',
  keepDisplay: true,
  activeAgents: 1,
  pid: 12345,
}
let rendered = ''
try {
  rendered = tool.output.render({}, sample)
} catch (error) {
  rendered = `THREW: ${error.message}`
}
check('render produced text', typeof rendered === 'string' && rendered.includes('HOLDING'), rendered)
console.log(`  render => ${JSON.stringify(rendered)}`)

console.log('\nstatus call never throws')
let status = null
try {
  status = await tool.execute({ action: 'status' })
} catch (error) {
  status = { error: error.message }
}
check('status returned', status && typeof status.running === 'boolean', JSON.stringify(status))
check('activeAgents counts only running', status.activeAgents === 1, String(status.activeAgents))

console.log('\nconfig validation')
check('defaults enabled=false', resolveSettings({}).enabled === false)
check('accepts enabled=true', resolveSettings({ enabled: true }).enabled === true)
let threw = false
try {
  resolveSettings({ mode: 'always-ish' })
} catch {
  threw = true
}
check('rejects unknown mode', threw)

controller.dispose()
console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}\n`)
process.exit(failures === 0 ? 0 : 1)
