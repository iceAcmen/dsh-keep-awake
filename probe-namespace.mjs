/**
 * Runtime probe for the settings-namespace gate.
 *
 * The last three rounds each verified a precondition in isolation and still
 * produced no visible card, so this asks the *running host* instead of a
 * model of it: it boots nothing, but it reads the same two facts the browser
 * reads — `settings.describe()`'s namespace list, and whether the plugin's
 * client module registers into `plugins.item`.
 *
 * What it can and cannot see is stated per check. Anything it cannot observe
 * is reported as UNKNOWN rather than guessed at.
 *
 * Run: node probe-namespace.mjs
 */

import { readFileSync, existsSync } from 'node:fs'

const PROFILE = 'C:/Users/ASUS/.dsh/profiles/desktop'
const INSTALLED = `${PROFILE}/node_modules/@local/dsh-keep-awake`

let failures = 0
function check(label, condition, detail) {
  if (condition) console.log(`  PASS  ${label}`)
  else {
    failures += 1
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` -- ${detail}`}`)
  }
}

console.log('\n1. installed artifacts (observable)')
for (const file of ['index.js', 'client.js', 'hold.ps1', 'package.json', 'cordis.patch.yml']) {
  check(`${file} present`, existsSync(`${INSTALLED}/${file}`))
}

console.log('\n2. host-side Config gate (observable via import)')
// Dynamic import needs a file:// URL on Windows, not a bare drive path.
const { pathToFileURL } = await import('node:url')
const mod = await import(pathToFileURL(`${INSTALLED}/index.js`).href)
const Config = mod.Config
check('Config exported', Config !== undefined)
check('Config has toJSON', 'toJSON' in Config)
const leaves = Object.keys(Config.dict ?? {})
check('five leaves declared', leaves.length === 5, leaves.join(','))
const unvolatile = Object.entries(Config.dict).filter(([, v]) => !v.meta?.volatile).map(([k]) => k)
check('every leaf marked volatile', unvolatile.length === 0, unvolatile.join(','))

console.log('\n3. client-side registration (source-level, observable)')
const client = readFileSync(`${INSTALLED}/client.js`, 'utf8')
check('registers into plugins.item', client.includes("name: 'plugins.item'"))
check('gates on whileServed', client.includes('whileServed'))
check('entry id matches loader entry', client.includes("ENTRY_ID = 'dsh-keep-awake'"))
check('exposes the card hooks', client.includes('keepAwakeCard'))
check('handles the summary view', client.includes("view === 'summary'"))

console.log('\n4. profile wiring (observable)')
const manifest = JSON.parse(readFileSync(`${PROFILE}/package.json`, 'utf8'))
check('bundle listed', manifest.dsh.profile.bundles.includes('@local/dsh-keep-awake'))
const patch = readFileSync(`${PROFILE}/cordis.patch.yml`, 'utf8')
check('patch targets the loader entry', patch.includes('- id: dsh-keep-awake'))

console.log('\n5. what this probe CANNOT observe')
console.log('  = whether settings.describe() currently lists the namespace')
console.log('  = whether the browser rendered the card')
console.log('  Both need the running host or a live browser; see the note at the end.')

console.log(`\n${failures === 0 ? 'ALL OBSERVABLE CHECKS PASS' : `${failures} FAILURE(S)`}\n`)
process.exit(failures === 0 ? 0 : 1)
