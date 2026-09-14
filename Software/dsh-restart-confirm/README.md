# dsh-restart-confirm

DSH Web 的「插件变更 → 重启确认栏」插件。当 profile 发生变化（`dsh plugin add|remove|update`，
或手动编辑 profile 的 `package.json` / `cordis.patch.yml`）时，页面顶部弹出确认栏，让用户
选择**立即重启**或**稍后**，而不是在背后静默断线。

功能与 [`ExtraZC/dsh-plugins/dsh-restart-confirm`](https://github.com/ExtraZC/dsh-plugins/tree/main/dsh-restart-confirm)
一致，按本机 DSH `0.1.5-rc.1` 的插件 API 重新实现，并且**不再依赖仓库外的手写 systemd
单元与 `restart-with-confirm.sh`**（见下文「与上游实现的差异」）。

## 工作原理

```
profile 文件变化
      │  fs.watch + 内容哈希轮询（2s 兜底）
      ▼
 host 半边 ──► /__restart-confirm/state ──► client 半边（shell.overlay 悬浮栏）
      ▲                                            │
      └────────── /__restart-confirm/respond ◄─────┘  { action: 'now' | 'later' }
                          │
                          └─ 'now' → process.exit(0)
                                     └─ systemd Restart=always 拉起全新进程
```

- **host 半边**（`lib/index.js`）：监视 profile 目录，暴露 HTTP 接口，执行重启。
- **client 半边**（`lib/client.js`）：通过 `shell.overlay` 插槽渲染悬浮确认栏，3 秒轮询一次。
- **bundle 层**（`cordis.patch.yml`）：把这个插件作为一行注册进 profile。

## 安装

```bash
# 在插件目录内
./scripts/build.mjs 2>/dev/null || node --experimental-vm-modules scripts/build.mjs
./scripts/install.sh web
```

`install.sh` 做两件事，等价于 `dsh plugin add` 的结果：

1. 把包复制到 `$DSH_HOME/profiles/<profile>/node_modules/dsh-restart-confirm`；
2. 把 `dsh-restart-confirm` 追加进该 profile `package.json` 的 `dsh.profile.bundles`。

安装后需要重启一次服务以加载插件本身：

```bash
sudo systemctl restart dsh.service
```

> **注意**：首次激活只能靠重启服务，此时插件还没运行，所以它的重启按钮也还不存在。
> 激活之后，插件自己的重启路径**不需要任何权限**：`process-exit` 模式只是让进程正常退出，
> 由 `Restart=always` 把它拉起来，因此之后每次插件变更都能用页面上的按钮完成。
> 不要为了「立即生效」把插件行手动加进 `cordis.patch.yml`：当插件已经在
> `dsh.profile.bundles` 里时，两处都会插入同一行，Loader 会在下次启动时报
> `duplicate loader entry id` 并启动失败。

卸载：

```bash
./scripts/uninstall.sh web
```

## 配置

在 profile 的 `cordis.patch.yml` 里针对 `id: restart-confirm` 覆盖配置：

```yaml
- id: restart-confirm
  config:
    autoRestartSec: 300      # 等待用户应答的秒数；0 表示永不自动重启
    watch: true              # false = 只保留手动重启接口
    restartMode: process-exit
```

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `autoRestartSec` | `180` | 无应答超时后自动重启；`0` 关闭自动重启 |
| `watch` | `true` | 是否监视 profile 文件变化 |
| `profileDir` | 自动探测 | 要监视的 profile 目录，默认从插件安装位置向上推断 |
| `restartMode` | `process-exit` | `process-exit` 或 `command` |
| `restartCommand` | `systemctl` | `restartMode: command` 时使用 |
| `restartArgs` | `[restart, dsh.service]` | 同上 |
| `exitDelayMs` | `400` | 应答写入与退出之间的延迟，保证页面先收到响应 |

## HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/__restart-confirm/state` | 当前状态：`pending`、`restarting`、`requestedAt`、`reason`、`revision`、`autoRestartAt`、`profileDir` |
| `POST` | `/__restart-confirm/respond` | `{"action":"now"}` 立即重启；`{"action":"later"}` 取消本次重启 |
| `POST` | `/__restart-confirm/restart` | 无待定变更时也强制重启 |

「稍后」会把当前磁盘版本记为已确认，因此**不会**在下一轮轮询里再次弹栏；此后再有新的文件
变更会重新弹栏。选择「立即重启」后进程退出，由监管者拉起全新进程。

`autoRestartAt` 是**弹栏时就固定下来的截止时间**，不会随轮询后移——否则每 3 秒一次的轮询会
让倒计时永远停在同一个数字上。客户端以它为锚点做本地倒计时，所以秒数只减不增。

弹窗消失有三个条件，各自对应一条路径：

1. 点「稍后」→ 本轮变更被确认，立即隐藏；
2. 服务端报告 `pending:false` 且从未点过「立即重启」→ 隐藏；
3. 点过「立即重启」→ 先显示「正在重启…」，随后**接口先不可达、再恢复可达**时判定重启完成
   并隐藏。重启不会刷新页面，所以这个「断连后恢复」是旧页面判断新进程已起来的唯一依据；
   缺了它，弹窗就会一直留在屏幕上。

```bash
curl -s http://127.0.0.1:30500/__restart-confirm/state
curl -s -X POST http://127.0.0.1:30500/__restart-confirm/respond \
  -H 'content-type: application/json' -d '{"action":"later"}'
```

## 与上游实现的差异

| 方面 | 上游插件 | 本实现 |
| --- | --- | --- |
| 重启执行 | 外部 `restart-with-confirm.sh` + 自定义 systemd 单元 | 进程自行 `process.exit(0)`，依赖 `dsh.service` 已有的 `Restart=always`；可用 `restartMode: command` 切换 |
| 变更检测 | systemd `.path` 单元监视 `package.json` | `fs.watch` + 内容哈希轮询，无需 root |
| 状态文件 | `~/.dsh/restart-pending.json`、`restart-response.json` | 仅内存状态 + HTTP 轮询，无临时文件 |
| 客户端 UI | 直接操作 DOM 的悬浮条 | 通过 `shell.overlay` 插槽渲染的 React 组件（DSH 标准扩展点） |
| 客户端声明 | `dsh.client.inject: ["@deepseek-ai/dsh-client-runtime"]`（该包在 0.1.5 已不存在） | `dsh.client.external: ["react", "react/jsx-runtime"]`（平台基线模块） |
| 安装前置 | 必须先用 root 替换 systemd 单元 | 无 root 需求；`restartMode: command` 才需要重启权限 |

## 验证

```bash
node --experimental-vm-modules scripts/build.mjs          # 语法 + bundle 协议检查
node --experimental-vm-modules scripts/test-host.mjs      # host 半边接口/检测/应答
node --experimental-vm-modules scripts/test-client.mjs    # client 半边协议/渲染
scripts/e2e.sh 30999                                      # 隔离 profile + 真实起服务，跑完整流程
```

`e2e.sh` 会在临时 `$DSH_HOME` 里初始化一个干净的 `web` profile，装入本插件，用另一个端口
起一个一次性实例，然后依次验证：接口可达、启动时无待定变更、文件变更触发确认栏、
「稍后」在下一轮轮询后仍然有效、以及确认重启确实让进程退出。不会碰你正在用的 profile。

手动端到端（插件已激活、服务在运行）：

```bash
touch "$DSH_HOME/profiles/web/package.json"
curl -s http://127.0.0.1:30500/__restart-confirm/state    # 应返回 pending: true
curl -s -X POST http://127.0.0.1:30500/__restart-confirm/respond \
  -H 'content-type: application/json' -d '{"action":"later"}'   # 取消，避免重启
```

## 注意事项

- **`process-exit` 依赖监管**：只有服务由 `Restart=always` 的单元（如 `dsh.service`）托管时
  才会被拉起。前台运行 `dsh web` 时请用 `restartMode: command`，或手动重启。
- **「稍后」会把当前磁盘版本记为已确认**：不会在下一轮轮询里再次弹栏，此后再有新的内容变更
  会重新弹栏。
- **首次激活需要一次特权重启**：见上文「安装」。这是唯一一次需要 root 的操作。
- **自动重启兜底**：`autoRestartSec` 到期即重启，避免插件变更一直不生效。
- **检测范围**：只监视 `package.json` 与 `cordis.patch.yml`，且只看**内容**变化；`pnpm-lock.yaml`、
  `node_modules` 的变动不算。对这两个文件做单纯的 `touch`（内容不变）也不会弹栏——重启并不能
  让任何东西变得不同。

## 排障：改了插件代码怎么生效

实测结论（DSH 0.1.5-rc.1）：

| 改动 | 生效方式 |
| --- | --- |
| `lib/client.js`（前端） | 服务会重新计算该 bundle 的 rev 并在线提供新内容，**刷新页面**即可 |
| `lib/index.js`（host） | **不会**热重载，需要重启一次服务 |
| `cordis.patch.yml` 新增行 | 会热加载，但别这样做：插件已在 `dsh.profile.bundles` 里时会产生重复 id |

判断某个修复是否已经在运行中的进程里生效，最直接的办法是看接口输出而不是看文件：例如确认
host 的截止时间修复，可以连续两次轮询 `/__restart-confirm/state`，比较两次的 `autoRestartAt`
是否**完全相同**（相同＝已生效）。
