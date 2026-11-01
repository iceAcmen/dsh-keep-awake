/**
 * dsh-keep-awake —— DeepSeek Harness 干活期间，让电脑不休眠、不熄屏，
 * 至于什么时候保持唤醒，由用户自己决定。
 *
 * 为什么必须用子进程：
 * `SetThreadExecutionState` 是**按线程**生效的，线程一结束，电源请求就随之消失。
 * 所以请求由一个小 PowerShell 子进程（hold.ps1）持有，它每 15 秒重申一次，
 * 直到被杀死为止。杀掉子进程就等于释放请求 —— 这正是我们想要的释放语义：
 * 全程不写任何系统全局设置，宿主就算硬崩，也不会把机器钉在不休眠的状态。
 *
 * 它做不到什么：
 * 只解决「睡眠」和「息屏」两件事。一旦安全桌面（LogonUI / LockApp）升起，
 * 任何用户态进程都无法往里打字或点击，所以「保持唤醒」永远不等于「绕过锁屏」。
 */

import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import z from '@deepseek-ai/schemastery'

/** Loader 之中用于诊断的身份标识。 */
export const name = 'keep-awake'

/** 能力接缝：工具注册表，以及用来判断活动状态的 agent 注册表。 */
export const inject = ['tools', 'agents']

const MODES = ['follow', 'always']

const HOLDER_SCRIPT = fileURLToPath(new URL('./hold.ps1', import.meta.url))

/* ------------------------------------------------------------------ */
/* 配置                                                                */
/* ------------------------------------------------------------------ */

/**
 * 配置 schema。正是这个导出让本条目成为一个**设置命名空间**；
 * 也正是给每个叶子字段加上 `volatile()`，才让它留在这个命名空间里。
 *
 * `settings.describe` 会用 `volatileForm(schema)` 过滤每一条：
 * 没标 `meta.volatile` 的叶子贡献不了任何东西，而整棵 object 子树都贡献不出东西时，
 * 这个条目会被**整个丢掉** —— 悄无声息，没有任何诊断信息。
 * 浏览器端那张卡片通过 `configForms.whileServed` 做门控，读的正是这份列表，
 * 所以少了一个 `volatile()`，页面就永远注册不上，设置卡片也就永远不出现。
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
    throw new Error(`keep-awake: ${field} 必须是非负数`)
  }
  return Math.floor(n)
}

/**
 * 读一个配置值，并把 schemastery 的 volatile 包装层层剥掉。
 *
 * 标了 `volatile()` 的字段不会直接解析成普通值：`resolveConfig` 交给 `apply()`
 * 的是一个带 `get()` 的包装对象，所以裸写 `config.enabled === true` 会永远是 false。
 * 包装可能嵌套多层，因此这里要剥到不能再剥，而不是只剥一次。
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

/** 把 loader 传进来的配置行规整成内部使用的形态。 */
export function resolveSettings(config = {}) {
  const enabled = plain(config.enabled) === true
  const mode = String(plain(config.mode) ?? 'follow').trim()
  if (!MODES.includes(mode)) {
    throw new Error(`keep-awake: mode 只能是 ${MODES.join(' / ')} 之一`)
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
/* 唤醒控制器                                                          */
/* ------------------------------------------------------------------ */

/**
 * 最多持有一个子进程，并在每次轮询时决定它该不该活着。
 *
 * 决策优先级：手动覆盖优先；否则 `always` 会永久持有请求，
 * 而 `follow` 只在有 agent 正在运行时、或自上次「有活动」起的宽限期还没过时才持有。
 * 宽限期这一环很关键：一轮对话结束后会立刻重启下一轮，
 * 没有它的话，子进程会在两个步骤之间被反复杀掉又拉起。
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
  /** 当前持有者启动时所用的 keepDisplay 值；没有持有者时为 null。 */
  #childDisplay = null

  constructor(ctx, settings) {
    this.#ctx = ctx
    this.#settings = settings
  }

  get settings() {
    return this.#settings
  }

  /**
   * 把这条 fiber 当前的配置重新读进 `#settings`。
   *
   * `volatile()` 字段被明确设计成「可在**不重挂载**的情况下编辑」，
   * 所以设置页保存后，存下来的配置变了，但 `apply()` 不一定会重新执行。
   * 每次轮询都重读一遍 fiber 配置，才是让「保存」真正落到持有者进程上的关键。
   */
  #refreshSettings() {
    try {
      const fiber = this.#ctx?.fiber
      const live = fiber?.config
      if (live !== undefined) this.#settings = resolveSettings(live)
    } catch {
      /* 宁可留住上一份好用的配置，也不要让轮询循环崩掉 */
    }
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

  /** 统计自身状态为 `running` 的 agent 数量。 */
  activeAgents() {
    try {
      return this.#ctx.agents.list().filter((agent) => agent.status === 'running').length
    } catch {
      return 0
    }
  }

  /** 启动轮询循环（可重复调用），并立刻做一次决策。 */
  start() {
    if (this.#timer !== null || this.#disposed) return
    this.tick()
    this.#timer = setInterval(() => this.tick(), this.#settings.pollIntervalMs)
    this.#timer.unref?.()
  }

  /** 轮询循环当前是否在跑。 */
  get started() {
    return this.#timer !== null
  }

  /** 重新判断此刻持有者子进程该不该活着。 */
  tick() {
    if (this.#disposed) return

    // volatile() 字段是「不重挂载」就能改的，apply() 未必会重跑，
    // 所以这个实例手上可能还是构造时的旧配置。
    // 每轮都重读一次 fiber 配置，否则设置页保存下来的值永远到不了持有者
    // （比如 keepDisplay 会一直停在旧值上）。
    this.#refreshSettings()
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

    // 活着的持有者没法改自己已经发出的请求；keepDisplay 一旦翻转，
    // 就必须换一个子进程，否则新值永远到不了 powercfg。
    const displayChanged = this.running && this.#childDisplay !== this.#settings.keepDisplay
    if (displayChanged) {
      this.#lastReason = `restart:keepDisplay=${this.#settings.keepDisplay}`
      this.#killHolder()
    }

    if (want && !this.running) this.#spawnHolder()
    else if (!want && this.running) this.#killHolder()
  }

  /** 无视活动状态强制开启／关闭请求，或清掉手动覆盖。 */
  setOverride(value) {
    this.#override = value === 'on' || value === 'off' ? value : null
    this.tick()
    return this.state
  }

  /** 在运行期启用／停用自动策略。 */
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
      // 请求随子进程一起没了，交给下一轮轮询重新决策。
      this.#lastReason = `holder-exited:${code}`
    })
    child.on('error', (error) => {
      if (this.#child !== child) return
      this.#child = null
      this.#lastReason = `holder-error:${error.message}`
    })
    this.#child = child
    this.#childDisplay = this.#settings.keepDisplay
  }

  #killHolder() {
    const child = this.#child
    if (!child) return
    this.#child = null
    this.#childDisplay = null
    try {
      child.kill()
    } catch {
      /* 已经没了 */
    }
  }

  /** 释放一切：定时器、持有者子进程，以及随之消失的电源请求。 */
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
/* 插件入口                                                            */
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
        `keep_awake ${value.action}：${value.running ? '持有中' : '已释放'}（${value.reason}）`,
        `enabled=${value.enabled} mode=${value.mode} keepDisplay=${value.keepDisplay} · 运行中 agent=${value.activeAgents}`,
        value.running && value.pid ? `持有者 PID ${value.pid}` : '',
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
