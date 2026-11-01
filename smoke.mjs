/**
 * Standalone smoke test for the keep-awake plugin.
 *
 * Runs `apply()` against a stub cordis context and a stub agent registry, then
 * exercises the state machine: disabled holds nothing, `on` spawns a holder,
 * `off` kills it, `auto` returns control to the activity policy.
 *
 * Run: node smoke.mjs
 */

import { apply, resolveSettings } from './index.js'

const registered = []
const cleanups = []

const ctx = {
  agents: {
    list() {
      return [
        { status: 'idle' },
        { status: 'running' },
      ]
    },
  },
  tools: {
    register(definition) {
      registered.push(definition)
    },
  },
  effect(fn) {
    cleanups.push(fn())
  },
}

const controller = apply(ctx, { enabled: false, mode: 'follow', keepDisplay: true })

const tool = registered.find((d) => d.name === 'keep_awake')
if (!tool) throw new Error('keep_awake tool was not registered')

const call = (args) => tool.execute(args)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let failures = 0
function check(label, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL  ${label}${detail ? ` -- ${detail}` : ''}`)
  }
}

console.log('\nresolved settings (disabled):')
console.log(' ', resolveSettings({ enabled: false, mode: 'follow' }))

console.log('\n1. disabled start: nothing should be held')
let state = await call({ action: 'status' })
check('not running while disabled', state.running === false, `reason=${state.reason}`)
check('reason is disabled', state.reason === 'disabled', state.reason)

console.log('\n2. action=on: holder child should spawn')
state = await call({ action: 'on' })
check('running after on', state.running === true, `reason=${state.reason}`)
check('has a pid', typeof state.pid === 'number' && state.pid > 0, String(state.pid))
await sleep(1500)

console.log('\n3. holder process is alive on this machine')
const holderPid = state.pid
let alive = false
if (holderPid) {
  try {
    process.kill(holderPid, 0)
    alive = true
  } catch {
    alive = false
  }
}
check('holder pid responds', alive, `pid=${holderPid}`)

console.log('\n4. action=off: holder should be killed')
state = await call({ action: 'off' })
check('not running after off', state.running === false, `reason=${state.reason}`)
check('reason is manual-off', state.reason === 'manual-off', state.reason)
await sleep(1000)

// Probe the pid captured at step 2 -- never pid 0, which would signal the
// whole process group and always "look alive".
let stillAlive = false
try {
  process.kill(holderPid, 0)
  stillAlive = true
} catch {
  stillAlive = false
}
check('old holder pid is gone', stillAlive === false, `pid=${holderPid}`)

console.log('\n5. action=auto with enabled=false: stays released')
state = await call({ action: 'auto' })
check('released after auto', state.running === false, `reason=${state.reason}`)

console.log('\n6. enabled + follow: a running agent should hold the request')
controller.setEnabled(true)
await sleep(200)
state = controller.state
check('started with enabled=true', controller.started === true)
check('running because an agent is running', state.running === true, `reason=${state.reason}`)
check('reason mentions follow', String(state.reason).startsWith('follow'), state.reason)

console.log('\n7. dispose releases the holder')
controller.dispose()
await sleep(1000)
let leaked = false
if (state.pid) {
  try {
    process.kill(state.pid, 0)
    leaked = true
  } catch {
    leaked = false
  }
}
check('no leaked holder after dispose', leaked === false)

console.log('\n8. config validation rejects bad values')
for (const bad of [{ mode: 'nope' }, { pollIntervalMs: -1 }]) {
  let threw = false
  try {
    resolveSettings(bad)
  } catch {
    threw = true
  }
  check(`rejects ${JSON.stringify(bad)}`, threw)
}

await sleep(300)
console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}\n`)
process.exit(failures === 0 ? 0 : 1)
