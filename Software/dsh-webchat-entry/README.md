# dsh-webchat-entry

DeepSeek 网页对话入口 —— 在 DSH Web 侧边栏底部（设置按钮上方）加一个入口，**点击在新标签页打开 [chat.deepseek.com](https://chat.deepseek.com/)**，当前 harness 页面保持不变。

面向 **DeepSeek Harness 0.1.5-rc.1**（`web` profile）编写并实测。

```
┌ 侧边栏 ──────────┐
│ [logo] [收起]     │
│ [＋ 新会话]       │
│ 全局面板 nav      │
│ ── workspaces ──  │
│                   │
│ ── footer ──────  │
│ [💬 网页对话]     │  ← 本插件
│ [⚙ 设置]         │
└───────────────────┘
```

## 为什么用官方槽而不是 DOM 补丁

「新会话」按钮在 `SidebarRoot` 里是硬编码的，**外面没有包裹槽**；侧边栏唯一空闲的 `list` 型官方槽是 `sidebar.footer.action`。本插件注册进该槽，因此：

- **不做任何 DOM 操作** —— 不 `querySelectorAll` 找按钮、不 `insertBefore`、不挂 `MutationObserver`、不起定时器
- 侧边栏展开/收起由槽传入的 `{ wide }` 驱动，布局由 shell 自己管理
- shell 改文案、改语言、重排 DOM 都不会让入口错位或消失
- 卸载时由 fiber 直接撤下注册，没有需要手动清理的副作用

对比参考实现（`@zerorigin-studio/dsh-deepseek-chat`，靠 DOM 注入实现"新会话正下方"）：那种做法需要按 `["new session","new chat","新对话","新建会话","新会话"]` 硬编码匹配文案、手写宽度匹配与 rAF 动画补间，且在找不到按钮时会留下一个永不停止的 `MutationObserver` + 150ms 轮询。本项目用位置换取零补丁。

## 「新标签页」是如何被保证的

入口是一个**声明式锚点**：

```html
<a href="https://chat.deepseek.com/" target="_blank" rel="noopener noreferrer">…</a>
```

- 用户手势触发的锚点导航不受弹窗拦截影响，也不依赖任何宿主桥接
- `rel="noopener noreferrer"` 断开反向标签劫持，且不泄漏 referrer
- **刻意没有 `window.location` 兜底**：参考实现会在桌面桥 promise reject 时把整个 harness 页面导航走，那是必须避免的失败模式

实测：点击后当前页 URL 不变、不重载、入口仍在。

## 与原生 Settings 行的几何对齐

入口的宽态样式逐条对齐 shell 自己的 `.VOzbGW_trigger` / `.VOzbGW_triggerRow`：

```css
.VOzbGW_trigger      { height:42px; border-radius:12px; flex:1;
                       padding:0 10px 0 8px; font-size:14px; line-height:22px; gap:8px }
.VOzbGW_triggerRow   { width:calc(100% + 4px); margin:4px -2px }
.VOzbGW_trigger:hover{ background:var(--dsw-alias-interactive-bg-hover) }
```

关键的一条是 **`flex:1`**：`footerActions` 是 row flex 容器，不写 flex 的锚点会按内容收缩到 106px；加上 `flex:1` 与 `margin:0 -2px` 后，锚点精确落在 `x=10 / width=260`，与 Settings 逐像素对齐（`margin` 的负值正是 shell 让 Settings 行越过列 padding 2px 的手法）。

**高度刻意保持 34px，不跟随 Settings 的 42px。** 原因是布局约束：侧边栏列里 `regionArea` 是 `flex:1 1 0%` + `min-height:0`，`footArea` 是 `flex:0 0 auto` 且底部锚定。footer 一旦增高 8px，`regionArea` 会相应收缩、Settings 会被上推，所以保持 34px 可以确保 **Settings 的坐标一字不动**。

实测（宽态）：

| | x | y | 宽 | 高 |
|---|---|---|---|---|
| Web Chat 入口 | 10 | 630 | **260** | 34 |
| Settings（改动前后完全一致） | 10 | 668 | 260 | 42 |
| `footArea` / `regionArea`（改动前后一致） | — | 630 / 120 | 256 / 272 | 84 / 510 |

有效点击区域从 `106×34` 提升到 `260×34`（约 2.45 倍）；9×9 网格采样命中率与 Settings 同为 **81/81 = 100%**。

收起态本来就与原生一致（`36×36`、图标 `18px`、`x=10`），未做改动。唯一残留差异是圆角：收起态本插件用 `8px`，而原生 Settings 用 `50%`（圆形）、New Session 用 `12px` —— shell 自身也不统一，如需完全跟随 Settings 可改 `src/client.js` 里 rail 分支的 `borderRadius`。

## 安装

```bash
./scripts/install.sh          # 默认 profile: web
./scripts/install.sh desktop  # 其它 profile
```

安装做两件事：

1. 把包复制到 `$DSH_HOME/profiles/<name>/node_modules/dsh-webchat-entry/`
2. 往该 profile 的 `cordis.patch.yml` 追加一段**带标记**的 `insert:` 行

### 为什么装在 patch 层而不是 `dsh.profile.bundles`

profile 设置了 `dsh.profile.patchReload: live`，boot 阶段会通过 Cordis HMR 监视 `cordis.patch.yml`，文件变化时就地重放整棵 patch 树。所以**改 patch 文件可以免重启生效**——只有浏览器需要刷新一次来取新的客户端 bundle。

而 `dsh.profile.bundles` 在 boot 时只读一次，加进去必须重启服务。两者同时写还会让同一行被插入两次，被 loader 判为重复 entry id 而拒绝启动。因此只用 patch 层。

> ⚠️ 副作用：`dsh-restart-confirm` 如果装了，它会监视 `cordis.patch.yml` 并弹出"检测到插件变更"提示条（其内容是给 `dsh plugin add` 设计的，无法识别 patch 层已热加载）。点「稍后」即可；本插件不需要重启。或者直接 **POST `/__restart-confirm/respond` 传 `{"action":"later"}`** 取消其倒计时。

## 卸载

```bash
./scripts/uninstall.sh
```

按标记精确删除 patch 层那一段（不触碰其余用户 patch），并删除包目录。同样是热生效，刷新页面入口即消失。

## 设置

设置 → 通用 → **DeepSeek web chat entry**：开关侧边栏入口。

持久化在 `$DSH_HOME/settings.yaml`：

```yaml
dsh-webchat-entry:
  showEntry: true
```

命名空间由 host 半边注册（`applies` 用 settings 服务默认的 `live`，改完即时生效）。host 半边总共只做这一件事：不碰 HTTP、文件系统或网络。

## 文件结构

```
package.json          dsh.client.external = [react, react/jsx-runtime]
cordis.patch.yml      bundle 层：insert 一行
src/index.js          host：注册 dsh-webchat-entry 设置命名空间
src/client.js         客户端：注册 sidebar.footer.action + settings.general.item
lib/                  构建产物（build.mjs 原样复制，源码即产物）
scripts/build.mjs     语法校验 + bundle 协议校验 + require 审计
scripts/install.sh    安装（可免重启）
scripts/uninstall.sh  卸载
```

客户端 bundle 只 `require` 平台种子词（`react`、`react/jsx-runtime`、`@deepseek-ai/dsh-client-store`），因此**不需要打包器**，也不会随 DSH 内部客户端包漂移。

### require 审计

`scripts/build.mjs` 会拒绝任何既不是平台种子词、又没写进 `dsh.client.external` 的 `require`。这类 specifier 在运行时只能靠"别的插件先加载了它"才解析得到，属于隐式加载序依赖——参考实现正是缺了这条声明（它 `require` 了 `@deepseek-ai/dsh-client-store` 和 `@deepseek-ai/dsh-client-ui-primitives`，却没有任何 `peerDependencies`）。

```bash
node --experimental-vm-modules scripts/build.mjs --check
```

## 在本版本上实测确认的接口

| 接口 | 结果 |
|---|---|
| 槽 `sidebar.footer.action` | 存在，`kind: list`, `scope: root`，渲染传 `{ wide }` |
| 槽 `settings.general.item` | 存在 |
| `ctx.slots.inject` / `ctx.slots.register` + `hooks` | 与核心插件同构 |
| `ctx.settingsScope.bind({ namespace })` | 与核心 `ui-chat` 用法一致 |
| `ctx.inject(['settings'])` + `settings.register(ns, schema)` | 与核心插件同构 |
| `createSnapshotStore` | 平台种子词 `@deepseek-ai/dsh-client-store` 导出 |
| `patchReload: live` + `watchUserPatches` | 改 `cordis.patch.yml` 免重启生效 |

## License

MIT
