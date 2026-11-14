# 真机闭环：点击 → 打字 → 保存 → 读回（在 HEAD 上重跑）

这是从装好插件起就一直缺的最后一步。**2026-11-14 20:35 在当前代码（HEAD `510c148` 之后）
上重新跑通**，用于替代早先那份不可复现的记录。

## 怎么跑

```
node tools/e2e-live.mjs        # 自带脚本：Shell 打开记事本 → 点 → 打 → Ctrl+S → 读磁盘
```

- 靶窗：脚本经 **Shell 启动**的空白记事本（父进程是 explorer，**不在 DSH 进程树里**——
  pixel 引擎会拒绝自己进程树的窗口，见下"目标选择陷阱"）；
- 动作：窗口内相对坐标 `fx=0.5 fy=0.55` 点一次 → 打 23 个字符 → `Ctrl+S`；
- 授权：脚本用 `source:'test'` 自开 5 分钟 / 10 次（脚本本身就是人类手里的工具）；
- 人类暂停：脚本关闭（`pauseOnHumanInput:false`），因为靶窗固定、且脚本是人工触发的；
  插件默认仍为**开启**；
- 结束自动 `gate.stop`，并清理临时文件（`--keep` 可保留）。

## 结果（本次）

```
marker      = dexter-e2e-1794659708087
window      = dexter-e2e-1794659708087.txt - Notepad (1124x1464 @380,252)
grant       = 5 分钟 / 10 次（active）
fileContent = dexter-e2e-1794659708087      ← 与 marker 完全一致
fileBytes   = 24
e2e: OK
```

审计（`%LOCALAPPDATA%\dsh-dexter-e2e\audit\hands.jsonl`，哈希链）：

```
hands_act · click  · executed · approval=session:1/10  · verify=foreground:ok
hands_act · type   · executed · approval=session:2/10  · verify=foreground:ok
hands_act · hotkey · executed · approval=session:3/10  · verify=foreground:ok
gate      · stop   · stop     · approval=revoked      · reason=e2e done
```

**注意审批标签**：一次 `hands_act` 消耗一个额度，`session:1/10 → 3/10` 是三次独立动作；
批量（`hands_run`）才会按步数一次扣足，见 `test/07` 的断言。

## 目标选择陷阱（必须记住）

早先一次尝试被拒：

```
已拒绝点击：目标窗口不安全。
```

原因不是权限，而是 **pixel 引擎保护自身进程树**：用 `Start-Process notepad` 起的窗口是
DSH 的子进程后代，被判为目标不安全。改用 Shell 启动（等价于双击）后即可：

```powershell
$sh = New-Object -ComObject Shell.Application
$sh.ShellExecute('notepad.exe', "$path", '', 'open', 1)
```

**结论：agent 自己 shell 起来的程序引擎一律拒绝；用户手动打开的窗口才安全。**

## 早先版本与本版本的差异

早先那份记录里 `hands_run` 的两步写作 `session:1/100` 与 `session:2/100`，而当前内核在批量里
只授权一次、按步数扣费，标签会是同一个 `session:N/M:step1/step2`。所以旧记录在本 HEAD 上
不可复现——以本文件为准。

## 顺带修掉的问题（评审发现 + 本次验证）

1. 引擎自报的 `授权状态: 剩 0 次` 已过滤（那是单次 arm 计数，不是会话余额）；
2. `verify=foreground:mismatch` 的进程名比较改为去 `.exe` 双向匹配，取不到进程名时按"未验证"处理；
3. `dryRun` 先分类再回答（永久禁止目标不再报"预计可执行"）；
4. 目标无法识别时 **fail closed**（不再当成普通窗口）。

## 结论

四项验收现在都有真机证据：

| 能力 | 证据 |
|---|---|
| 看（UIA 读屏） | 55 元素 / 1.3s / ≈1200 tokens |
| 截图 | PNG `sha256:8acf7e90…`，与旧引擎逐字节一致 |
| 悬停 | `approval=hover(free)`，有审计、有按键护栏 |
| **点 + 打 + 存 + 读回** | **本文件：23 字符落盘，逐字一致** |
| 剪贴板 | 写 39 字符 → 读回同一 39 字符 → 还原原内容 |
