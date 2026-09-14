# 提交前密钥拦截（pre-commit secret scan）

拦住「误把 API Key / 密钥 / 凭据提交进版本库」这一道门。

## 组成

| 文件 | 作用 |
|---|---|
| `pre-commit` | 主防线，**零外部依赖**（bash + git + grep/awk） |
| `allowlist.txt` | 误报豁免清单（按路径或按规则精确豁免） |
| `install.sh` | 在每个 clone 里启用钩子（git 不会自动启用仓库内钩子） |
| `../.gitleaks.toml` | 可选第二道扫描；装了 gitleaks 时钩子自动叠加使用 |

## 启用

```bash
bash .githooks/install.sh          # 写入仓库级 core.hooksPath=.githooks
bash .githooks/pre-commit --scan-all   # 自检：扫描当前所有被跟踪文件
```

关闭：`bash .githooks/install.sh --uninstall`

> 为什么需要 `install.sh`：`core.hooksPath` 属于本地配置，无法随 git 提交分发。

## 扫描什么

**1. 文件名红旗**（命中即拒绝，不看内容）
`.env` / `.env.*` / `*.pem` / `*.key` / `*.p12` / `*.pfx` / `*.jks` / `id_rsa*` /
`.npmrc` / `.netrc` / `.git-credentials` / `*.token` / `*secret*.json` /
`*credential*.json` / `service-account*.json` / `cookies.txt` / `auth.json` …
（`*.example` / `*.sample` / `*.template` / `*.md` 例外放行）

**2. 内容规则**（只扫本次提交新增的行）
私钥块、AWS Access Key ID、GitHub `ghp_`/`github_pat_`、Slack `xox*`、Stripe `sk_live_`、
Google `AIza…`、OpenAI/Anthropic `sk-…`、HuggingFace `hf_`、npm `npm_`、SendGrid `SG.`、
Twilio `SK…`、JWT，以及**通用赋值规则**：`api_key/secret/token/password` 等键名 + 长度 ≥12 且
Shannon 熵 ≥ 3.2 的字面量。

**3. 可选的 gitleaks 叠加**：检测到 `gitleaks` 命令时自动追加一轮（含官方 160+ 规则），失败同样阻止提交。

### 占位符判定是「值级」的

只有**被命中的那段值本身**像占位符才放过（`example` / `placeholder` / `changeme` /
`xxxx` / `<...>` / `your_api_key` 等）。刻意不做「整行含 example 就跳过」——
那种宽松规则会让任何带 example 字样的行变成盲区。因此：

- `const k = "your_api_key_here";` → 放行（值是占位符）
- `const k = "AKIAIOSFODNN7EXAMPLE";` → 放行（AWS 官方文档示例键，值级豁免）
- `const k = "AKIA3XQ7ZP2LMN4VW6YT";` → **拦截**（真实样式的键，即使同一行还有别的词）

### 扫描器故障 = 失败即阻止（fail-closed）

若 `scan.awk` 因 `allowlist.txt` 里的非法正则而报错，钩子**阻止提交**并报
`scanner-error`，而不是「报错就当没看见」静默放过——后者会让密钥在规则写错时悄悄漏检。

## 输出安全

告警**永不回显密钥本体**，只给出前 4 个字符与长度，例如：

```
✖ [aws-access-key-id] Software/foo.js:42  →  AKIA…(20字符)
```

因此 CI 日志、终端 scrollback、截图都不会二次泄露。

## 被拦住了怎么办

1. **真密钥** → 删掉，改用环境变量或未跟踪的本地配置；然后**立即轮换**该密钥。
2. **误报** → 优先在该行加注释 `secret-scan:allow`（最小范围），
   或在 `allowlist.txt` 里加一条：
   ```
   match (?i)myPublicDemoToken
   path Software/foo/fixtures/**
   ```
3. **已经提交过** → 轮换密钥，并用 `git filter-repo`（或 BFG）清洗历史；
   仅加 `.gitignore` 或新增一次「删除提交」都不算修复，历史里依然可检出。

## 紧急跳过

```bash
SKIP_SECRET_SCAN=1 git commit -m "..."   # 本次跳过，会打印醒目警告
git commit --no-verify -m "..."          # 跳过全部钩子
```

`--scan-all` 模式下 `SKIP_SECRET_SCAN` 不生效，便于 CI 做强制审计。

## 调参

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `SECRET_SCAN_ENTROPY` | `3.2` | 通用规则的熵阈值，调低更敏感（更多误报） |
| `SKIP_SECRET_SCAN` | 未设置 | 设为 `1` 跳过本次扫描 |

## 局限（务必知晓）

- 只看**新增行**；历史遗留密钥不会因此被发现 → 需用 `--scan-all` 或 gitleaks 全历史审计。
- 无法识别**加密/编码后**的密钥（如 base64 包装、分片拼接）。
- **没有敏感键名的裸高熵字符串不会告警**（例如 `const b = "wJalrXUtn…"`）。
  这是刻意的取舍：若只看熵值，lockfile 里的 sha256 校验和、commit hash
  会大量误报。代价是「改名藏起来的密钥」可能漏过。
- 熵值法是启发式，**存在漏报可能**：本钩子是「降低概率」而非「保证安全」。
  真正的安全保障是：密钥不落到工作区文件里，改用环境变量/密钥管理服务。

## 已验证行为

在隔离仓库中跑过 23 项用例（全部通过）：

| 类别 | 覆盖 |
|---|---|
| 应拦截 (11) | AWS / GitHub / Slack / Google / JWT / PEM 私钥 / 高熵通用赋值 / `.env` / `id_rsa` / `credentials.json` / `.npmrc` |
| 应放行 (8) | 干净代码 / 占位符值 / `process.env` 引用 / `.env.example` / 文档 / 行内豁免 / AWS 官方示例键 / 低熵字符串 |
| 健壮性 (4) | 非法 allowlist 正则 fail-closed、真实 `git commit` 拦截、干净提交放行、`SKIP_SECRET_SCAN` 生效 |
| 输出安全 | 告警不含完整密钥、不含密钥后段、无运行时错误 |

性能：全仓库 `--scan-all`（26 文件 / 4.2k 行）耗时约 **0.3 秒**（单 awk 进程扫描，不逐行 fork）。
