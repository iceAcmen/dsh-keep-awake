/**
 * dsh-keep-awake -- keep this machine out of sleep / display-off while DeepSeek
 * Harness is working, and let the user decide when that happens.
 *
 * WHY a child process: `SetThreadExecutionState` is per-thread, so a power
 * request dies with the thread that made it. Ownership lives in a small
 * PowerShell child (hold.ps1) that re-asserts every 15s until it is killed.
 * Killing it drops the request -- which is exactly the release semantics we
 * want: no global power setting is ever written, and even a hard crash of the
 * host leaves nothing pinned awake.
 *
 * WHAT it cannot do: this covers sleep and display-off only. Once the secure
 * desktop (LogonUI / LockApp) is up, no user-level process can type or click
 * into it, so "keep awake" never means "bypass the lock screen".
 */

import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import z from '@deepseek-ai/schemastery'

/** Loader identity used in diagnostics. */
export const name = 'keep-awake'

/** Capability seams: the tool registry plus the agent registry for activity. */
export const inject = ['tools', 'agents']

const MODES = ['follow', 'always']

const HOLDER_SCRIPT = fileURLToPath(new URL('./hold.ps1', import.meta.url))

/* ------------------------------------------------------------------ */
/* configuration                                                       */
/* ------------------------------------------------------------------ */

/**
 * The config schema. This export is what makes the entry a *settings
 * namespace*, and `volatile()` on every leaf is what keeps it there.
 *
 * `settings.describe` filters each entry through `volatileForm(schema)`:
 * a leaf without `meta.volatile` contributes nothing, and a schema whose
 * whole object subtree contributes nothing is dropped entirely -- silently,
 * with no diagnostic. The browser card gates on `configForms.whileServed`,
 * which reads exactly that list, so a missing `volatile()` means the page
 * never registers and the settings card never appears.
 */
export const Config = z.object({
  enabled: z
    .boolean()
    .default(false)
    .volatile()
    .description('启用自动保持。关闭时本插件完全不生效。'),
  mode: z
    .union([z.const('follow'), z.const('always')])
    .default('follow')
    .volatile()
    .description('follow 只在有任务运行时保持；always 一直保持。'),
  keepDisplay: z
    .boolean()
    .default(true)
    .volatile()
    .description('true 同时防息屏；false 只防睡眠，允许熄屏省电。'),
  pollIntervalMs: z
    .number()
    .default(5000)
    .volatile()
    .description('多久检查一次 agent 活动状态（毫秒）。'),
  graceMs: z
    .number()
    .default(60000)
    .volatile()
    .description('最后一个任务结束后仍保持唤醒的宽限时间（毫秒）。'),
})

function nonNegativeInteger(value, fallback, field) {
  if (value === undefined || value === null) return fallback
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`keep-awake: ${field} must be a non-negative number`)
  }
  return Math.floor(n)
}

/**
 * Read one config value, unwrapping schemastery's volatile container.
 *
 * A `volatile()` field does not resolve to its plain value: `resolveConfig`
 * hands `apply()` a wrapper exposing `get()`, and a bare `config.enabled ===
 * true` would therefore always be false. The wrapper may nest, so unwrap to
 * exhaustion rather than once.
 */
function plain(value) {
  let current = value
  let guard = 0
  while (
    current !== null &&
    typeof current === 'object' &&
    typeof current.get === 'function' &&
    guard < 16
  ) {
    current = current.get()
    guard += 1
  }
  return current
}

/** Normalize the loader-provided config row. */
export function resolveSettings(config = {}) {
  const enabled = plain(config.enabled) === true
  const mode = String(plain(config.mode) ?? 'follow').trim()
  if (!MODES.includes(mode)) {
    throw new Error(`keep-awake: mode must be one of ${MODES.join(' / ')}`)
  }
  const keepDisplay = plain(config.keepDisplay) !== false
  return {
    enabled,
    mode,
    keepDisplay,
    pollIntervalMs: nonNegativeInteger(plain(config.pollIntervalMs), 5000, 'pollIntervalMs'),
    graceMs: nonNegativeInteger(plain(config.graceMs), 60000, 'graceMs'),
  }
}

/* ------------------------------------------------------------------ */
/* the awake controller                                                */
/* ------------------------------------------------------------------ */

/**
 * Owns at most one holder child and decides, per tick, whether it should live.
 *
 * Decision order: a manual override wins; otherwise `always` holds the request
 * permanently, while `follow` holds it only while an agent is running or the
 * grace window since the last running tick has not expired. The grace window
 * matters because turns end and restart constantly -- without it the child
 * would be killed and respawned between steps.
 */
class AwakeController {
  #ctx
  #settings
  #child = null
  #timer = null
  #disposed = false
  #lastActiveAt = 0
  #override = null
  #lastReason = 'disabled'

  constructor(ctx, settings) {
    this.#ctx = ctx
    this.#settings = settings
  }

  get settings() {
    return this.#settings
  }

  get running() {
    return this.#child !== null
  }

  get state() {
    return {
      enabled: this.#settings.enabled,
      mode: this.#settings.mode,
      keepDisplay: this.#settings.keepDisplay,
      override: this.#override,
      running: this.running,
      pid: this.#child?.pid ?? null,
      reason: this.#lastReason,
      activeAgents: this.activeAgents(),
    }
  }

  /** Count agents whose own status is `running`. */
  activeAgents() {
    try {
      return this.#ctx.agents.list().filter((agent) => agent.status === 'running').length
    } catch {
      return 0
    }
  }

  /** Start the poll loop (idempotent) and decide immediately. */
  start() {
    if (this.#timer !== null || this.#disposed) return
    this.tick()
    this.#timer = setInterval(() => this.tick(), this.#settings.pollIntervalMs)
    this.#timer.unref?.()
  }

  /** Whether the poll loop is active. */
  get started() {
    return this.#timer !== null
  }

  /** Re-evaluate whether the holder child should be alive right now. */
  tick() {
    if (this.#disposed) return

    const active = this.activeAgents()
    if (active > 0) this.#lastActiveAt = Date.now()

    let want = false
    let reason = 'disabled'

    if (this.#override === 'off') {
      want = false
      reason = 'manual-off'
    } else if (this.#override === 'on') {
      want = true
      reason = 'manual-on'
    } else if (!this.#settings.enabled) {
      want = false
      reason = 'disabled'
    } else if (this.#settings.mode === 'always') {
      want = true
      reason = 'always'
    } else if (active > 0) {
      want = true
      reason = `follow:${active}-running`
    } else {
      const idleFor = Date.now() - this.#lastActiveAt
      want = this.#lastActiveAt > 0 && idleFor < this.#settings.graceMs
      reason = want ? 'follow:grace' : 'follow:idle'
    }

    this.#lastReason = reason

    if (want && !this.running) this.#spawnHolder()
    else if (!want && this.running) this.#killHolder()
  }

  /** Force the request on/off regardless of activity, or clear the override. */
  setOverride(value) {
    this.#override = value === 'on' || value === 'off' ? value : null
    this.tick()
    return this.state
  }

  /** Enable/disable the automatic policy at runtime. */
  setEnabled(enabled) {
    this.#settings.enabled = enabled === true
    if (this.#settings.enabled) this.start()
    this.tick()
    return this.state
  }

  #spawnHolder() {
    if (process.platform !== 'win32') {
      this.#lastReason = 'unsupported-platform'
      return
    }
    const args = [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      HOLDER_SCRIPT,
      '-Display',
      this.#settings.keepDisplay ? '1' : '0',
    ]
    let child
    try {
      child = spawn('powershell.exe', args, { windowsHide: true, stdio: 'ignore' })
    } catch (error) {
      this.#lastReason = `spawn-failed:${error.message}`
      return
    }
    child.on('exit', (code) => {
      if (this.#child !== child) return
      this.#child = null
      // The request died with the child; let the next tick re-decide.
      this.#lastReason = `holder-exited:${code}`
    })
    child.on('error', (error) => {
      if (this.#child !== child) return
      this.#child = null
      this.#lastReason = `holder-error:${error.message}`
    })
    this.#child = child
  }

  #killHolder() {
    const child = this.#child
    if (!child) return
    this.#child = null
    try {
      child.kill()
    } catch {
      /* already gone */
    }
  }

  /** Release everything: timer, holder child, and the request with it. */
  dispose() {
    this.#disposed = true
    if (this.#timer !== null) {
      clearInterval(this.#timer)
      this.#timer = null
    }
    this.#killHolder()
  }
}

/* ------------------------------------------------------------------ */
/* plugin entry                                                        */
/* ------------------------------------------------------------------ */

export function apply(ctx, config = {}) {
  const settings = resolveSettings(config)
  const controller = new AwakeController(ctx, settings)

  if (settings.enabled) controller.start()

  ctx.effect(() => () => {
    controller.dispose()
  })

  ctx.tools.register({
    name: 'keep_awake',
    description:
      '控制「防睡眠 / 防息屏」：让电脑在 DeepSeek Harness 工作时不进入睡眠、不熄屏。action=status 查询当前状态；on 强制开启；off 强制关闭；auto 取消强制并交回自动跟随策略。注意：本工具不能让键鼠穿过 Windows 锁屏安全桌面。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'on', 'off', 'auto'],
          description: 'status=查询状态；on=强制开启；off=强制关闭；auto=取消强制，回到自动策略。',
        },
        keepDisplay: {
          type: 'boolean',
          description: '仅对 on 生效：true 同时防息屏（默认），false 只防睡眠并允许息屏省电。',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['action', 'running', 'reason', 'enabled', 'mode', 'keepDisplay', 'activeAgents'],
        properties: {
          action: { type: 'string' },
          running: { type: 'boolean', description: '电源请求当前是否生效' },
          reason: { type: 'string', description: '当前决策原因' },
          enabled: { type: 'boolean' },
          mode: { type: 'string' },
          keepDisplay: { type: 'boolean' },
          activeAgents: { type: 'integer', description: '正在运行的 agent 数量' },
          pid: { type: 'integer', description: '持有者子进程 PID' },
        },
      },
      render: (_args, value) => [
        `keep_awake ${value.action}: ${value.running ? 'HOLDING' : 'released'} (${value.reason})`,
        `enabled=${value.enabled} mode=${value.mode} keepDisplay=${value.keepDisplay} · running agents=${value.activeAgents}`,
        value.running && value.pid ? `holder pid ${value.pid}` : '',
      ].filter(Boolean).join('\n'),
    },
    async execute(args) {
      const action = String(args?.action ?? 'status')
      if (action === 'on') {
        if (args?.keepDisplay !== undefined) settings.keepDisplay = args.keepDisplay !== false
        controller.setOverride('on')
      } else if (action === 'off') {
        controller.setOverride('off')
      } else if (action === 'auto') {
        controller.setOverride(null)
        if (settings.enabled) controller.start()
      }

      const state = controller.state
      return {
        action,
        running: state.running,
        reason: state.reason,
        enabled: state.enabled,
        mode: state.mode,
        keepDisplay: state.keepDisplay,
        activeAgents: state.activeAgents,
        ...(state.pid ? { pid: state.pid } : {}),
      }
    },
  })

  return controller
}
