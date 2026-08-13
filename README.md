# dsh-revive · 一键复活

DSH 进程经常在跑任务时被杀死（自己杀自己、OOM、崩溃……），重启之后每个被打断的会话都要手动点开、手动发一句「继续」。这个插件把这件事变成**一键**：

- 扫描全部持久化会话，识别「被打断」的（回合没跑完、消息没处理、上次回合以中止/出错/阻塞/超长收尾的）；
- 按官方 GUI 同款路径冷恢复它们：从持久化日志重建会话、挂回它原来的 preset 组合、沿用上次的模型；
- 给每个被打断的会话发送「继续」指令，让它们接着干活；
- 子代理会话不直接复活（它们会随父会话的恢复被自动接管），正在运行的会话不动。

## 触发方式（三选一，同一套核心逻辑）

| 入口 | 用法 |
|---|---|
| **浏览器一键按钮** | 每个会话输入框下方的 dock 区有一个「⚡复活」按钮，角标显示被打断会话数，点一下全部复活 |
| **斜杠命令** | `/revive`（复活全部）、`/revive list`（只列出）、`/revive <sessionId>`（只复活一个） |
| **模型工具** | 对任意会话说「把被打断的会话都复活」，模型会调用 `revive_sessions` 工具 |

## 被打断的判定

对每个会话日志折叠出以下结论之一：

| 结论 | 含义 | 是否复活 |
|---|---|---|
| `killed-mid-turn` | 日志末尾停在未结束的回合里（进程被杀） | ✅ |
| `pending-user-message` | 有用户消息从未被处理 | ✅ |
| `aborted` / `interrupted` / `error` / `max-tokens` / `blocked` | 上一回合非正常收尾 | ✅ |
| `completed` | 上一回合正常完成 | ❌（避免无谓烧 token） |
| 空日志 | 从未动过的会话 | ❌ |

## 安装

```bash
# 已登录私有 npm registry 的 DSH 部署机
dsh plugin --profile web add dsh-revive@0.1.4

# 本地开发 checkout
dsh plugin --profile web add link:/path/to/dsh-revive
```

插件自带 Profile Bundle；`dsh plugin` 会自动维护 profile 依赖和
`dsh.profile.bundles`。不要手工编辑 profile manifest，也不要再插入同名 `revive`
loader entry，否则会触发 `duplicate loader entry id`。重启 DSH 后，任意会话输入框
下方出现「⚡复活」按钮即安装成功。

## 兼容性

| 组件 | 支持范围 |
|---|---|
| DSH | `>=0.1.0-rc.3 <0.2.0` |
| Node.js | `>=22.19.0` |
| Profile | `web`（宿主命令/工具/RPC + 浏览器 dock） |

0.1.4 以 npm DSH 0.1.0-rc.3 的 commands、agent resume、raw session persistence 和
`dsh-client-ui-conversation` 契约为准。

## 配置

在 profile 自己的 `cordis.patch.yml` 中更新插件行；不要修改安装包内的 patch：

```yaml
- update:
    id: revive
    config:
      resumePrompt: 继续
      autoReviveOnStartup: false
      startupDelayMs: 5000
      scanTtlMs: 120000
```

所有键均可选：

| 键 | 默认 | 说明 |
|---|---|---|
| `resumePrompt` | `继续` | 复活时发给会话的指令文本 |
| `autoReviveOnStartup` | `false` | DSH 启动后自动复活所有被打断会话（崩溃循环风险：若 DSH 反复崩溃会反复拉起任务，按需开启） |
| `startupDelayMs` | `5000` | 自动复活的启动延迟 |
| `scanTtlMs` | `120000` | 快照缓存时间；浏览器角标轮询（60s）与此配合，避免频繁全量扫描 |

## 开发

```bash
npm install --legacy-peer-deps
DSH_RUNTIME_NODE_MODULES=/path/to/dsh-0.1.0-rc.3/node_modules npm run setup:dsh-workspace
npm run typecheck
npm test
npm run build                 # tsc（host 半部）+ tsdown（浏览器半部 lib/client.js）
npm run test:oom              # 128 MiB V8 heap 下扫描 32 MiB raw JSONL
npm pack                      # prepack 会重跑全部 gate
```

依赖的真实类型在 `setup:dsh-workspace` 时从已安装的私有 npm DSH 运行时软链而来；用 `DSH_RUNTIME_NODE_MODULES=<path> npm run setup:dsh-workspace` 指定该运行时的 `node_modules`。

## 已知限制

- 复活后的会话沿用**上次记录的模型**；会话内切换模型需通过官方模型选择入口（插件恢复的会话不在 web 选择器的注册表里）。
- 冷扫描只使用持久化后端的 raw artifact 接口：逐会话串行读取，从 JSONL 尾部反向折叠到最近的 turn 边界，不构造完整事件数组，也不会把日志放入 DSH 的 prepared-session 缓存。结果按后端 revision 缓存在进程内，扫描前后 revision 不一致时最多重试一次，仍在变化的会话会跳过而不是误报。
- 当前只有声明 `supportsRawArtifacts` 的持久化后端能安全扫描冷会话；SQLite 等不提供独立 raw artifact 的后端会把冷会话记为 skipped，不会回退到完整日志读取。raw artifact 本身仍会以字符串形式短暂驻留，因此峰值内存与最大单个 artifact 大小相关，但不会再随多份完整事件图累积。
- 为保持尾部扫描有界，冷会话候选不会额外回溯标题；命令和界面在标题缺失时显示 session ID。
