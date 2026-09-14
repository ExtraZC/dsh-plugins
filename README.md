# dsh-plugins

[DSH（DeepSeek Harness）](https://github.com/deepseek-ai/dsh) 插件集合。每个插件位于独立目录，
各自维护完整的 `README.md`、源码、构建与安装脚本。

面向 **DSH `0.1.5-rc.1`**（`web` profile）编写并实测 · Node ≥ 20 · MIT

## 插件一览

| 插件 | 版本 | 作用 | 文档 |
| --- | --- | --- | --- |
| [`dsh-restart-confirm`](Software/dsh-restart-confirm/README.md) | 0.1.0 | 插件变更后先在页面弹出确认栏，自行选择「立即重启 / 稍后」，而不是被静默断线 | [README](Software/dsh-restart-confirm/README.md) |
| [`dsh-webchat-entry`](Software/dsh-webchat-entry/README.md) | 0.1.0 | 侧边栏底部新增入口，在**新标签页**打开 chat.deepseek.com，当前页面不动 | [README](Software/dsh-webchat-entry/README.md) |

两个插件互相独立，可单独安装。同时安装时有一处已知交互，见下文
[「两个插件同时使用」](#两个插件同时使用)。

---

## dsh-restart-confirm

**问题**：安装插件（或任何改动 profile 的操作）后 dsh web 会自动重启，页面被瞬间断开。
**做法**：在重启前弹出确认栏，把时机交还给你。

```
profile 文件变化
      │  fs.watch + 内容哈希轮询（2s 兜底）
      ▼
  host 半边 ──► GET /__restart-confirm/state ──► client 半边（shell.overlay 悬浮栏）
      ▲                                                    │
      └──────── POST /__restart-confirm/respond ◄──────────┘  { action: 'now' | 'later' }
                        │
                        └─ 'now' → process.exit(0)
                                   └─ dsh.service 的 Restart=always 拉起全新进程
```

- **host 半边**（`lib/index.js`）：监视 profile 的 `package.json` / `cordis.patch.yml`，暴露 HTTP 接口并执行重启
- **client 半边**（`lib/client.js`）：通过官方 `shell.overlay` 槽渲染 React 悬浮确认栏，3 秒轮询一次
- **重启方式**：`process.exit(0)`，由已有的 `dsh.service`（`Restart=always`）拉起全新进程
  —— **首次激活之后不需要任何 root 权限**
- **超时兜底**：默认 180 秒无人应答则自动重启，保证变更最终生效
- **只认内容变化**：对文件单纯 `touch`（内容不变）不会弹栏——重启并不能让任何东西变得不同

| 接口 | 说明 |
| --- | --- |
| `GET /__restart-confirm/state` | 当前状态：`pending`、`restarting`、`autoRestartAt`、`reason`、`profileDir` … |
| `POST /__restart-confirm/respond` | `{"action":"now"}` 立即重启 · `{"action":"later"}` 本轮跳过 |
| `POST /__restart-confirm/restart` | 无待定变更时也强制重启 |

```bash
cd Software/dsh-restart-confirm
./scripts/build.mjs 2>/dev/null || node --experimental-vm-modules scripts/build.mjs
./scripts/install.sh web
sudo systemctl restart dsh.service     # 仅首次激活需要这一次特权重启
```

主要配置项（在 profile 的 `cordis.patch.yml` 里覆盖）：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `autoRestartSec` | `180` | 无应答超时后自动重启；`0` 表示永不自动重启 |
| `watch` | `true` | 是否监视 profile 文件变化 |
| `restartMode` | `process-exit` | `process-exit` 或 `command` |

**完整文档**：[`Software/dsh-restart-confirm/README.md`](Software/dsh-restart-confirm/README.md)
（全部配置项、HTTP 语义、与上游 systemd 实现的逐项差异、排障表）

---

## dsh-webchat-entry

在侧边栏底部（设置按钮上方）加一个入口，点击在**新标签页**打开 [chat.deepseek.com](https://chat.deepseek.com/)，
当前 harness 页面保持不变。

```
┌ 侧边栏 ──────────┐
│ [logo] [收起]     │
│ [＋ 新会话]       │
│ 全局面板 nav      │
│ ── workspaces ──  │
│ ── footer ──────  │
│ [💬 网页对话]     │  ← 本插件
│ [⚙ 设置]         │
└───────────────────┘
```

- **零 DOM 补丁**：注册进官方 `sidebar.footer.action` 槽，不 `querySelectorAll`、不 `insertBefore`、
  不挂 `MutationObserver`、不起定时器；shell 改文案或重排 DOM 都不会让入口错位
- **新标签页有保证**：声明式 `<a target="_blank" rel="noopener noreferrer">`，
  用户手势触发的锚点导航不受弹窗拦截影响；**刻意不做 `window.location` 兜底**
  （那会在桥接失败时把整个 harness 页面导航走）
- **与原生对齐**：宽态 `260×34`，与 Settings 行逐像素对齐（点击区域较朴素实现提升约 2.45 倍）；
  高度刻意保持 34px，避免把 Settings 上推
- **免重启安装**：写 profile 的 `cordis.patch.yml`（profile 设了 `patchReload: live`），
  改完只需刷新浏览器一次

```bash
cd Software/dsh-webchat-entry
./scripts/install.sh          # 默认 profile: web
./scripts/install.sh desktop  # 其它 profile
# 无需重启服务，刷新页面即可
```

设置项：**设置 → 通用 → DeepSeek web chat entry**，持久化在 `$DSH_HOME/settings.yaml`：

```yaml
dsh-webchat-entry:
  showEntry: true
```

**完整文档**：[`Software/dsh-webchat-entry/README.md`](Software/dsh-webchat-entry/README.md)
（槽位选择理由、几何对齐实测数据、`require` 审计、实测确认的接口清单）

---

## 两个插件同时使用

`dsh-restart-confirm` 监视 `cordis.patch.yml`，而 `dsh-webchat-entry` 恰好通过该文件安装。
因此安装 webchat-entry 时，前者可能弹出「检测到插件变更」确认栏。

**该变更实际已经热加载，不需要重启**——点「稍后」即可，或者直接取消它的倒计时：

```bash
curl -s -X POST http://127.0.0.1:30500/__restart-confirm/respond \
  -H 'content-type: application/json' -d '{"action":"later"}'
```

## 仓库结构

```
Software/
├── dsh-restart-confirm/       README.md · package.json · cordis.patch.yml
│   ├── src/                   源码（host 半边 + client 半边）
│   ├── lib/                   构建产物
│   └── scripts/               build.mjs · install.sh · uninstall.sh · e2e.sh · test-*.mjs
└── dsh-webchat-entry/         同上
    └── scripts/               build.mjs · install.sh · uninstall.sh
.githooks/                     提交前密钥拦截（见下）
.gitleaks.toml                 可选的 gitleaks 规则集
```

两个插件的客户端 bundle 只 `require` 平台种子词（`react`、`react/jsx-runtime`、
`@deepseek-ai/dsh-client-store`），因此**不需要打包器**，也不会随 DSH 内部客户端包漂移。

## 开发约定：提交前密钥拦截

仓库自带一个**零依赖**的 pre-commit 钩子（bash + git + awk），阻止 API Key、私钥、
凭据类文件被误提交。git 出于安全不会自动启用仓库内钩子，**clone 后需手动启用一次**：

```bash
bash .githooks/install.sh              # 设置仓库级 core.hooksPath=.githooks
bash .githooks/pre-commit --scan-all   # 全仓库自检
```

它扫描本次提交的新增行与文件名红旗，命中即阻止提交，告警输出始终脱敏（只显示前 4 字符与长度）；
扫描器自身报错时同样阻止提交（fail-closed，避免规则写错导致静默漏检）。
若本机装了 [gitleaks](https://github.com/gitleaks/gitleaks)，会自动叠加第二道扫描。

详见 [`.githooks/README.md`](.githooks/README.md)。

## License

MIT
