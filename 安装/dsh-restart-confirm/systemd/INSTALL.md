# 启用「重启确认栏」—— root 安装步骤（只需执行一次）

插件 `dsh-restart-confirm` 已装好，确认脚本也已就位
（`~/.dsh/scripts/restart-with-confirm.sh`）。
剩下唯一需要 root 的，是把 systemd 的 `dsh-web-restart.service` 从
「直接重启」换成「先问页面再重启」。

## 执行（在终端里以 root / sudo 运行）

```bash
# U 自动取当前非 root 用户（sudo 下为 SUDO_USER），无需手写用户名
U=${SUDO_USER:-$USER}

# 1. 用带确认流程的新单元文件替换旧的（先备份；<dsh-user> 由 sed 替换成 $U）
sudo cp /etc/systemd/system/dsh-web-restart.service /etc/systemd/system/dsh-web-restart.service.bak
TMP=$(mktemp)
sed "s|<dsh-user>|$U|g" \
  "/home/$U/DSH/安装/dsh-restart-confirm/systemd/dsh-web-restart.service" > "$TMP"
sudo install -m 644 "$TMP" /etc/systemd/system/dsh-web-restart.service
rm -f "$TMP"

# 2. 重新加载 systemd 配置并重新武装 path 监视器
sudo systemctl daemon-reload
sudo systemctl restart dsh-web-restart.path
```

## 生效后的行为

下次 `dsh plugin add`（或任何修改 `~/.dsh/profiles/web/package.json` 的操作）时：

1. 页面顶部弹出确认栏：「检测到插件变更 — [立即重启] [稍后]」
2. **立即重启** → 约 2 秒内重启服务
3. **稍后** → 本次跳过，不重启（插件保持未激活，直到手动重启）
4. **3 分钟无人操作** → 自动重启（保证变更最终生效）
5. 如果确认插件没加载（页面打不开/接口 404）→ 立即重启，不等待

## 回滚

```bash
sudo mv /etc/systemd/system/dsh-web-restart.service.bak /etc/systemd/system/dsh-web-restart.service
sudo systemctl daemon-reload
sudo systemctl restart dsh-web-restart.path
```

## 验证

```bash
# 模拟一次 package.json 变更，观察确认流程
sudo touch "/home/$U/.dsh/profiles/web/package.json"
# 此时页面应出现确认栏；也可直接查接口：
curl -s http://127.0.0.1:30500/__restart-confirm/state
# 手动应答（跳过重启）：
curl -s -X POST http://127.0.0.1:30500/__restart-confirm/respond \
  -H 'content-type: application/json' -d '{"action":"later"}'
```

> `sudo touch` 触发的是空修改；系统会先等页面应答（3 分钟超时），
> 页面不点的话会自动重启一次 —— 这正好能验证整条链路。
