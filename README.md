# dsh-plugins

dsh（DeepSeek Harness）插件集合。每个插件位于独立目录，各自维护自己的 `README.md`；
本主页由 [`scripts/build-readme.sh`](scripts/build-readme.sh) 自动汇总生成——修改任一插件 README 后请重新运行该脚本并提交。

## 插件列表

- **[dsh-restart-confirm](#dsh-restart-confirm)**：Confirmation bar before the automatic dsh web restart: after a plugin install changes the profile, the page asks the user to restart now or defer, instead of disconnecting instantly.

---

## dsh-restart-confirm

安装插件（或任何修改 `~/.dsh/profiles/web/package.json` 的操作）后，dsh web 服务会自动重启以加载新插件。本插件在重启前于页面顶部弹出**确认栏**，让你选择「立即重启」或「稍后」，而不是被瞬间断开。

- 版本：0.1.0 · License：MIT · 环境：Node ≥ 20
- 依赖：dsh `webServer`（宿主侧）与 dsh client runtime（页面侧）

### 特性

- 🔔 页面顶部确认栏：插件变更被检测到时出现，显示变更原因与请求时间
- ⏱️ 两种选择：
  - **立即重启** → 约 2 秒内服务重启，页面短暂断开后自动恢复
  - **稍后** → 本次跳过，插件保持未激活，直到手动重启
- ⏰ **3 分钟无人操作自动重启**，保证变更最终生效
- 🌐 自动中英文（按浏览器语言首选项）
- 🧹 无框架依赖：纯 DOM + `--dsw-*` 主题变量，跟随 dsh 主题
- 📦 通过 cordis bundle 补丁接入，插件卸载时确认栏一并移除

### 工作原理

整条链路由三部分组成：

```
dsh plugin add
    │  (修改 ~/.dsh/profiles/web/package.json)
    ▼
systemd dsh-web-restart.path ──触发──► dsh-web-restart.service (oneshot)
    │                                   │
    │  restart-with-confirm.sh          │ 1. 写入 ~/.dsh/restart-pending.json
    │                                   │ 2. 轮询 ~/.dsh/restart-response.json（最长 3 分钟）
    │                                   │ 3. 超时或收到 "now" → 重启服务；"later" → 跳过
    ▼                                   ▼
页面（client 半部）         宿主（index.js 半部）
    │  每 3s GET /__restart-confirm/state
    ▼                                   │
确认栏 [立即重启] [稍后] ──POST /__restart-confirm/respond──► 写入 restart-response.json
```

- **宿主半部**（`src/index.js`）：注册两个 HTTP 端点，把 `~/.dsh/restart-pending.json` 的状态暴露给页面，并把用户的选择原子写入 `~/.dsh/restart-response.json`（临时文件 + rename，轮询方不会读到半截内容）。
- **客户端半部**（`src/client.js`）：每 3 秒轮询状态端点；`pending: true` 时显示确认栏，用户点击后提交选择。
- **systemd 助手**：`restart-with-confirm.sh`（dsh 安装时已就位于 `~/.dsh/scripts/`）负责写入待重启标记、轮询应答、超时兜底重启。

#### HTTP 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/__restart-confirm/state` | `{ pending: true, requestedAt, reason }` 或 `{ pending: false }`；用户已应答后也返回 `pending: false` |
| `POST` | `/__restart-confirm/respond` | 请求体 `{ "action": "now" \| "later" }`，成功返回 `{ ok: true, action }` |

#### 状态文件（`~/.dsh/` 下）

| 文件 | 写入方 | 含义 |
|---|---|---|
| `restart-pending.json` | systemd 助手 | 有待处理的重启请求（含 `requestedAt`、`reason`） |
| `restart-response.json` | 本插件 | 用户的选择（含 `action`、`respondedAt`） |

### 安装

插件本体已可通过 dsh 插件机制加载（见 `cordis.patch.yml` 的 bundle 层定义）。

剩下唯一需要 root 的一次性步骤，是把 systemd 的 `dsh-web-restart.service` 从「直接重启」换成「先问页面再重启」——完整安装、回滚与验证步骤见 **[systemd/INSTALL.md](dsh-restart-confirm/systemd/INSTALL.md)**。

> 注意：仓库中的 `dsh-web-restart.service` 使用 `<dsh-user>` 占位符，`INSTALL.md` 中的安装命令会用 `sed` 自动替换为当前用户名。

### 文件结构

```
dsh-restart-confirm/
├── package.json            # 插件元信息与 dsh bundle/client 配置
├── cordis.patch.yml        # cordis bundle 层：插入 restart-confirm 行
├── src/
│   ├── index.js            # 宿主半部：HTTP 端点 + 状态文件读写
│   └── client.js           # 客户端半部：确认栏 UI + 轮询
└── systemd/
    ├── dsh-web-restart.service   # systemd oneshot 单元（带确认流程）
    └── INSTALL.md                # root 安装 / 回滚 / 验证说明
```

### 行为细节

- 页面已应答（无论 now/later）后，`state` 即返回 `pending: false`，确认栏立即隐藏，无需等助手清理。
- 页面在服务重启瞬间的轮询请求失败会被静默忽略，保持当前状态。
- 端点有 64KB 请求体上限；非法 action 返回 `400`。
- 确认栏置顶悬浮、边缘可点击穿透，不遮挡页面操作。

### 安全说明

- 本插件**不存储任何密钥**：只读写 `~/.dsh/` 下两个 JSON 状态文件，无凭据、无网络外呼。
- 两个端点为本地 dsh web 服务内的内部接口（无鉴权），与 dsh 自身的本地服务边界一致，请勿将 dsh web 直接暴露到公网。

### License

MIT License © ExtraZC

