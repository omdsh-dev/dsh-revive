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

1. 把本目录 `link` 进 DSH profile 的依赖，并把 `dsh-revive` 加进 `dsh.profile.bundles`：
   ```jsonc
   // ~/.dsh/profiles/web/package.json
   {
     "dependencies": {
       "dsh-revive": "link:/path/to/dsh-revive"
     },
     "dsh": {
       "profile": {
         "bundles": [ "@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-revive" ]
       }
     }
   }
   ```
2. 在 profile 目录执行 `pnpm install`，重启 DSH。
3. 打开任意会话，输入框下方出现「⚡复活」按钮即安装成功。

## 配置（`cordis.patch.yml` 行内 `config:`，均可选）

| 键 | 默认 | 说明 |
|---|---|---|
| `resumePrompt` | `继续` | 复活时发给会话的指令文本 |
| `autoReviveOnStartup` | `false` | DSH 启动后自动复活所有被打断会话（崩溃循环风险：若 DSH 反复崩溃会反复拉起任务，按需开启） |
| `startupDelayMs` | `5000` | 自动复活的启动延迟 |
| `scanTtlMs` | `120000` | 快照缓存时间；浏览器角标轮询（60s）与此配合，避免频繁全量扫描 |
| `scanConcurrency` | `1` | 同时读取的冷会话日志数；巨型日志会占用大量内存，除非已压测验证，否则建议保持 `1` |

## 开发

```bash
npm install
npm run setup:dsh-workspace   # 将 @deepseek-ai/* 内部包软链到本地 DSH 源码 checkout
npm run typecheck
npm test
npm run build                 # tsc（host 半部）+ tsdown（浏览器半部 lib/client.js）
```

依赖的真实类型在 `setup:dsh-workspace` 时从 DSH 源码 workspace 软链而来（内部包不在公共 npm 上）；若 checkout 路径不同，用 `DSH_WORKSPACE_ROOT=<path> npm run setup:dsh-workspace` 指定。

## 已知限制

- 复活后的会话沿用**上次记录的模型**；会话内切换模型需通过官方模型选择入口（插件恢复的会话不在 web 选择器的注册表里）。
- 扫描需要读取每个持久化会话的日志，巨型会话（10 万级事件）单次读取可能耗时数秒~十余秒并占用大量内存。冷日志默认串行读取（`scanConcurrency: 1`），并配合 single-flight 与 120s 快照缓存，避免并发请求复制整轮扫描；提高并发前应使用真实语料压测峰值 RSS。
