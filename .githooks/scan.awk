# ==============================================================================
# .githooks/scan.awk — 密钥规则扫描核心（由 pre-commit 调用）
#
# 输入（stdin）：每行 "行号<TAB>文本"
# 输出（stdout）：每行 "文件<TAB>行号<TAB>规则名<TAB>命中的密钥原文"
#                 （密钥原文仅用于脱敏显示，pre-commit 不会原样打印）
# 参数：  -v fname=<路径>  [-v allowlist_file=<路径>]  [-v entropy_min=3.2]
#
# 说明：整个扫描在单个 awk 进程内完成（每文件一次），避免逐行 fork grep，
#       这也是本仓库能在 0.1s 级别扫完全部源码的原因。
# ==============================================================================
BEGIN {
    FS = "\t"

    # --- 规则表：rn[] 名称，rr[] 正则，rc[] 是否忽略大小写 --------------------
    n = 0
    n++; rn[n] = "private-key-block";          rr[n] = "-----BEGIN [A-Z ]*PRIVATE KEY-----";                         rc[n] = 0
    n++; rn[n] = "aws-access-key-id";          rr[n] = "(AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA)[A-Z0-9]{16}"; rc[n] = 0
    n++; rn[n] = "github-token";               rr[n] = "gh[pousr]_[A-Za-z0-9]{36,}";                                rc[n] = 0
    n++; rn[n] = "github-fine-grained-pat";    rr[n] = "github_pat_[A-Za-z0-9_]{22,}";                              rc[n] = 0
    n++; rn[n] = "slack-token";                rr[n] = "xox[abprs]-[A-Za-z0-9-]{10,}";                              rc[n] = 0
    n++; rn[n] = "stripe-live-key";            rr[n] = "[rs]k_live_[A-Za-z0-9]{16,}";                               rc[n] = 0
    n++; rn[n] = "google-api-key";             rr[n] = "AIza[0-9A-Za-z_-]{35}";                                     rc[n] = 0
    n++; rn[n] = "openai-anthropic-key";       rr[n] = "sk-(ant-)?[A-Za-z0-9_-]{24,}";                              rc[n] = 0
    n++; rn[n] = "huggingface-token";          rr[n] = "hf_[A-Za-z0-9]{30,}";                                       rc[n] = 0
    n++; rn[n] = "npm-token";                  rr[n] = "npm_[A-Za-z0-9]{36}";                                       rc[n] = 0
    n++; rn[n] = "sendgrid-api-key";           rr[n] = "SG\\.[A-Za-z0-9_-]{16,}\\.[A-Za-z0-9_-]{16,}";              rc[n] = 0
    n++; rn[n] = "twilio-api-key";             rr[n] = "SK[0-9a-fA-F]{32}";                                         rc[n] = 0
    n++; rn[n] = "jwt";                        rr[n] = "eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}"; rc[n] = 0
    n++; rn[n] = "generic-secret-assignment";  rr[n] = "(api[_-]?key|apikey|secret|token|passwd|password|passphrase|credential|private[_-]?key|access[_-]?key|client[_-]?secret|auth[_-]?token)[\"']?[[:space:]]*[:=][[:space:]]*[\"'][^\"']{12,}[\"']"; rc[n] = 1

    for (i = 1; i <= n; i++) if (rc[i]) rr[i] = tolower(rr[i])

    # 需要熵值过滤的规则
    entropy_rule["generic-secret-assignment"] = 1
    if (entropy_min == "") entropy_min = 3.2
    entropy_min += 0

    # 占位符 / 非密钥值的特征
    placeholders = "example|placeholder|change[_-]?me|redacted|dummy|fake|sample|your[_-]?(api|key|token|secret)|xxxx|\\*\\*\\*|<[^>]*>|\\$\\{|\\$\\(|%s|\\.\\.\\."

    # allowlist 中的 match 规则（path 规则由 pre-commit 处理）
    am = 0
    if (allowlist_file != "") {
        while ((getline l < allowlist_file) > 0) {
            sub(/#.*/, "", l)
            gsub(/^[[:space:]]+/, "", l)
            gsub(/[[:space:]]+$/, "", l)
            if (l == "") continue
            if (l ~ /^match[[:space:]]/) {
                pat = substr(l, 7)
                sub(/^\(\?i\)/, "", pat)      # 容错：吞掉 PCRE 的 (?i) 前缀
                am++
                ar[am] = tolower(pat)          # 统一小写，配合 low 实现忽略大小写
            }
        }
        close(allowlist_file)
    }
}

# Shannon 熵（bit/字符）
function shannon(s,    i, n, c, p, h) {
    n = length(s)
    if (n < 2) return 0
    delete seen
    for (i = 1; i <= n; i++) { c = substr(s, i, 1); seen[c]++ }
    h = 0
    for (c in seen) { p = seen[c] / n; h -= p * log(p) / log(2) }
    return h
}

# 明显是占位符/文档占位的「值」（对所有规则生效）
function is_obvious_placeholder(v,    lv) {
    lv = tolower(v)
    if (lv ~ placeholders) return 1
    return 0
}

# 不可能是真实密钥的值：占位符，或纯标识符/变量引用（仅用于通用赋值规则）
function is_non_secret_value(v,    lv) {
    lv = tolower(v)
    if (lv ~ placeholders) return 1
    if (lv ~ /^[a-z_][a-z0-9_]*$/) return 1
    if (lv ~ /^[a-z_$][a-z0-9_$]*(\.[a-z_$][a-z0-9_$]*)+$/) return 1
    return 0
}

{
    lineno = $1 + 0
    p = index($0, "\t")
    if (p == 0) next
    text = substr($0, p + 1)
    if (text == "") next

    low = tolower(text)

    # 行内豁免标记
    if (low ~ /gitleaks:allow|secret-scan:allow|pragma: allowlist secret/) next

    # allowlist match 豁免
    skip = 0
    for (j = 1; j <= am; j++) if (low ~ ar[j]) { skip = 1; break }
    if (skip) next

    for (i = 1; i <= n; i++) {
        target = rc[i] ? low : text
        if (target !~ rr[i]) continue

        hit = ""
        if (entropy_rule[rn[i]]) {
            # 逐个检查本行所有引号值（长度 >= 12），取第一个通过熵值判定的
            s = text
            while (match(s, /["'][^"']{12,}["']/)) {
                cand = substr(s, RSTART + 1, RLENGTH - 2)
                s = substr(s, RSTART + RLENGTH)
                if (length(cand) < 12) continue
                if (is_non_secret_value(cand)) continue
                if (shannon(cand) >= entropy_min) { hit = cand; break }
            }
            if (hit == "") continue
        } else {
            if (match(target, rr[i])) {
                if (rc[i]) hit = substr(text, RSTART, RLENGTH)
                else       hit = substr(text, RSTART, RLENGTH)
            }
            if (hit == "") continue
            # 格式类规则也要放过明显的占位符值，
            # 例如 AWS 官方文档里的 AKIAIOSFODNN7EXAMPLE。
            # 注意：这是「值级」判定，绝不会因为整行出现 "example" 就放过该行。
            if (is_obvious_placeholder(hit)) continue
        }

        printf "%s\t%d\t%s\t%s\n", fname, lineno, rn[i], hit
        break   # 每行只报最高优先级的一条，避免刷屏
    }
}
