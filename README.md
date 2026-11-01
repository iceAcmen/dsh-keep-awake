# dsh-keep-awake

DeepSeek Harness 插件：让电脑在 DSH 干活时**不休眠、不熄屏**，开关由你自己掌握。

## 它做什么

用一个 PowerShell 子进程调用 `SetThreadExecutionState`（`kernel32`），持续持有电源请求。
这是 macOS `caffeinate` 的 Windows 等价物，但比它多一层**自动跟随 DSH 活动**的能力。

进程一死请求立即消失 —— 不改任何系统设置，不需要管理员权限，崩溃也不会把机器钉住。

## 它不能做什么

**绕不过锁屏。** Win+L 或系统锁屏之后，屏幕上是安全桌面（LogonUI / LockApp），
任何用户态进程都无法往里打字或点击。本插件只解决「睡眠 / 息屏」这两件事。

（顺带：插电不锁屏已通过 `powercfg` 在系统层面单独配置，与本插件无关。）

## 三种使用方式

### 1. 设置界面（带开关的设置页）

**设置 → 内置插件 → 防睡眠 / 防息屏**

这个页面由本插件的浏览器产物（`client.js`）注册进 `plugins.item` slot，提供：

- **启用自动保持** —— 总开关，对应配置的 `enabled`
- **保持模式** —— 开关在「跟随任务 / 始终保持」间切换，对应 `mode`
- **同时保持屏幕常亮** —— 对应 `keepDisplay`
- 空闲宽限（`graceMs`）与检查间隔（`pollIntervalMs`）两个数字输入

所有改动都走 `configForms` 的事务式写入，和其它官方设置页同一套机制，
点保存才落盘到 `cordis.patch.yml`，可随时「恢复默认」。

> 注意：这个卡片只在「内置插件」里出现。插件市场页只列可安装的包，
> 本地 `file:` 插件按设计不会出现在那里。

### 2. 直接叫模型做（最快，不用点界面）

```
帮我保持唤醒 30 分钟
释放唤醒
看下 keep_awake 状态
```

模型会调用 `keep_awake` 工具，`action=on / off / auto / status`。

### 3. 改配置文件

编辑 `~/.dsh/profiles/desktop/cordis.patch.yml`：

```yaml
- id: dsh-keep-awake
  config:
    enabled: true      # 改成 true
    mode: follow       # follow = 只在 DSH 忙时保持；always = 一直保持
    keepDisplay: true  # false = 只防睡眠，允许熄屏省电
    pollIntervalMs: 5000
    graceMs: 60000     # 空闲宽限，避免 turn 之间反复起停
```

保存即热重载，无需重启。

## 配置项

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `false` | 插件总开关。false 时加载但不生效 |
| `mode` | `follow` | `follow` 只在有 agent 运行时保持；`always` 配置开启后常驻 |
| `keepDisplay` | `true` | true 防息屏 + 防睡眠；false 只防睡眠 |
| `pollIntervalMs` | `5000` | 检查间隔 |
| `graceMs` | `60000` | 最后一个 agent 结束后仍保持的宽限时间 |

## 工具 `keep_awake`

| action | 行为 |
|---|---|
| `status` | 只读，返回当前是否持有点、原因、运行中 agent 数 |
| `on` | 强制开启（覆盖自动策略），可带 `keepDisplay` |
| `off` | 强制关闭 |
| `auto` | 取消强制，交回 `mode` 策略 |

## 验证方式

插件起了一个 `powershell.exe` 子进程持有请求。以管理员运行：

```
powercfg /requests
```

`DISPLAY:` 和 `SYSTEM:` 下出现 `powershell.exe` 即说明生效；
插件处于 released 状态时这两处会显示「无」。

## 测试

在插件源码目录运行（第 4、5 项需 `node_modules` 能解析 schemastery）：

```bash
node namespace-gate.mjs    # Config 能否通过 describe 的过滤（决定设置页是否出现）
node describe-e2e.mjs      # 完整模拟 describe() 全链路，含不加 volatile 的对照组
node contract.mjs          # Host 工具 schema、render、config 校验
node client-contract.mjs   # 浏览器产物：注册、工厂、apply 装配、slot、渲染、销毁
node smoke.mjs             # 真机状态机：on 起进程 / off 杀掉 / dispose 不泄漏
```

五套均 ALL PASS。

`client-contract.mjs` 用一个忠实的 `window.__ModuleLoader__` 替身捕获注册，
再用 React/primitives 的桩执行工厂函数。它能抓住语法错误、解构错、`apply()`
抛错、以及未定义引用；抓不住布局和视觉问题——那需要真实浏览器。

## 为什么设置页曾经一直不出现

这是本插件最难排查的一处，记在这里免得下次重蹈覆辙。

`settings.describe` 会逐条过滤 Loader 条目：

```js
const schema = this.schema(entry)            // 要求 entry.fiber.runtime.Config
const form   = volatileForm(schema)
if (form === undefined) return []            // 静默丢弃，无任何日志
```

而 `volatileForm` 只保留标记了 `meta.volatile` 的叶子字段。**没加
`.volatile()` 的字段一个都不算，整棵 object 子树为空时，条目直接被丢掉**，
并且**不产生任何诊断**。浏览器端的 `configForms.whileServed` 读的正是这份
列表，所以卡片永远注册不上。

两个必须同时成立的细节：

1. 五个字段都要 `.volatile()`；
2. `volatile()` 会让值变成 `{ get() }` 包装容器，`apply()` 拿到的
   `config.enabled` **不是**布尔值 —— `resolveSettings` 必须先解包，否则
   `enabled: true` 会被读成 false，插件永不启动。

## 文件构成

| 文件 | 作用 |
|---|---|
| `index.js` | Host 半边：持有者子进程的生命周期 + `keep_awake` 工具 + `Config` |
| `hold.ps1` | 真正持有电源请求的 PowerShell 子进程，15 秒重申一次 |
| `client.js` | 浏览器半边：注册进 `plugins.item` 的设置卡片 |
| `cordis.patch.yml` | bundle patch，把 Host 条目 insert 进 loader |
| `locale/*.json` | 插件清单页显示用的标题与描述 |
| `namespace-gate.mjs` | 设置命名空间准入测试 |
| `describe-e2e.mjs` | describe 全链路模拟 |

## 已知限制

- **仅 Windows**（`hold.ps1` + `SetThreadExecutionState`）。其他平台 `reason` 会报 `unsupported-platform`。
- 无法绕过锁屏安全桌面（设计如此，不是缺陷）。
- 电池供电时保持唤醒会明显加快耗电，`powercfg /requests` 可随时查看谁在持有。
- 设置卡片只在「内置插件」分区出现；插件市场页按设计不列本地 `file:` 依赖。
