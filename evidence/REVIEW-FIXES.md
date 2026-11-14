# 评审问题清单 → 修复状态（逐条）

两份独立评审：DSH 内部 reviewer（只读、带探针）与 WorkBuddy（外部 App，通过插件驱动其 UI 送审）。
下表把**每一条**映射到状态、提交与验证方式。**blocker/high 全部关闭，medium/low 除"已知限制"外全部关闭。**

| # | 级别 | 问题 | 状态 | 提交 / 验证 |
|---|---|---|---|---|
| 1 | blocker | 模型能注入 `Ctrl+Alt+F12` 给自己开授权（stopbus 读全局键态） | 修好 | `68d5f60`；`test/07`「拒绝注入人手热键」+ 只忽略自己注入的组合 |
| 2 | blocker | `/dexter stop` 停不住正在跑的批量 | 修好 | `68d5f60`；`kernel.stop` 同时置位 stopbus；`test/07` 批量中断断言 |
| 3 | high | 授权弹窗期间按 Esc，同意后仍注入 | 修好 | `68d5f60`；await 后复查；`test/07`「stop during the prompt」 |
| 4 | high | 批量一次授权覆盖 25 次注入（授信/频率被绕过） | 修好 | `68d5f60`；按步数扣费，余额不足整批拒绝；`test/07` 三条断言 |
| 5 | high | 面板永远显示"未授权"（快照无 `active`） | 修好 | `68d5f60`；`grant.active`；`test/07` 三条断言 |
| 6 | high | 急停后批量永久不可用（stopbus 从不 clear） | 修好 | `68d5f60`；`/dexter arm`、`/dexter clear` 都清；`test/07` |
| 7 | high | 批量只在开头检查人类活动/新鲜度 | 修好 | `68d5f60`；每步 `waitForIdle` + fresh-look；`test/07` 两条断言 |
| 8 | medium | `dryRun` 对永久禁止目标报"预计可执行" | 修好 | `64be888`；先分类再预演，`ok` 反映结论；`test/08` |
| 9 | medium | 审计写失败仍注入 | 修好 | `64be888`；gate + kernel 双重 fail-closed；`test/08` |
| 10 | medium | UIA 回退可能注入到被覆盖的别的窗口 | 修好 | `64be888`；打字前校验前台 handle、坐标点击前 `probeAt` 校验落点 |
| 11 | medium | UIA 缺失时目标分类 fail-open（且 Esc/人类暂停消失） | 修好 | `64be888`；无法分类 = `unknown` → 拒绝；`test/08` |
| 12 | medium | "提权窗口永久拒绝"对窗口/键盘目标未实现 | 修好 | `64be888`；按窗口/前台中心 `probeAt` 取真实 `elevated`；拖拽终点也探测 |
| 13 | medium | `/dexter extend` 不带参数只加 1 分钟/1 次 | 修好 | `64be888`；用 `armMinutes/armActions` |
| 14 | medium | 面板源码路径用了 `URL.pathname`（含空格/中文会静默失效） | 修好 | `64be888`；改 `fileURLToPath` |
| 15 | medium | `hotkeysEnabled` 声明了没人读 | 修好 | `64be888`；为 false 不启动 stopbus 并在日志说明 |
| 16 | medium | 跟踪文件含机器路径/用户名，且 check-repo 恰好跳过那两个目录 | 修好 | `abc3ff3`；baseline 输出改 `<repo>`、证据路径改占位符、扫描范围覆盖 `baseline/`&`evidence/` |
| 17 | medium | check-repo 清单校验盲区（`ui`/`client.js`/`docs` 未检查） | 修好 | `abc3ff3`；必需运行时清单扩到 8 项 |
| 18 | medium | `E2E.md` 在 HEAD 上不可复现（批量审批标签变了） | 修好 | `41d0f94`；`tools/e2e-live.mjs` 在 HEAD 重跑：23 字符落盘、逐字一致 |
| 19 | medium | README 数字/描述漂移（6,606、latched、缺 clipboard、批量限速说法） | 修好 | `abc3ff3` + 7,034 B 全量同步；命令示例改 15/100 |
| 20 | medium | DEVIATIONS 与 patch 示例漂移（"不做 client 插件"、`dsh-stroke`、latch、D7 与 D13 冲突、`approvalMode` 等已删键） | 修好 | `abc3ff3`；D7 标注被 D13 部分取代；patch 示例改真实键 |
| 21 | medium | 验收包自相矛盾（A11 19/20 与 20/20；套件数/文件数过期） | 修好 | `abc3ff3`；统一为 19/20、9/9、235 项、89 文件 |
| 22 | low | 审计里出现字面 `"undefined"` | 修好 | `64be888`；`cleanValue` 丢弃 undefined 字段 |
| 23 | low | agent 触发的急停被记成 human | 修好 | `64be888`；`by: 'agent'` |
| 24 | low | `audit.tail(0)` 返回整块 | 修好 | `64be888`；`count<=0 → []` |
| 25 | low | 批量步骤 schema 缺 `expect` | 修好 | `64be888`；已加，`test/08` 断言 |
| 26 | low | `focus` 未经闸门改前台 | 按设计 + 记录 | `510c148`；SECURITY 明确写出 |
| 27 | low | 热键健康只在 apply 时快照 | 修好 | `64be888`；`hands_status` 每次重新探测 |
| 28 | low | CI 只监听 `main`，仓库是 `master` | 修好 | `abc3ff3`；`[master, main]` |
| 29 | low | THIRD-PARTY 只给版权行、且自称"无第三方源码" | 修好 | `510c148`；补 MIT 许可正文，改口径 |
| 30 | low | 笔画玩具不能被中断 | 修好 | `64be888`；`shouldStop` + `kernel.stop` 调 `toy.stop` |
| 31 | low | 拖拽只分类起点 | 修好 | `64be888`；分类终点，终点不可探测即拒绝 |
| 32 | low | 面板崩溃不重启、宿主被强杀留残留 | 部分按设计 | `64be888` `panel.stop` 扫残留；崩溃后由 `/dexter panel show` 重开，状态页明示"未运行" |
| 33 | nit | 自动隐藏任务栏时，右侧边条可能落在唤出区 | 修好 | `41d0f94`；边条内缩 4px；`panel-click` 复测 14×56@1422 |
| 34 | nit | `maxActionsPerMinute` 注释说 0=无上限，但 min=1 | 修好 | `64be888`；`min: 0` |
| 35 | nit | `hands_view` 可读凭据管理器窗口且不询问 | 按设计 + 记录 | `510c148`；SECURITY 写明"读不受闸门约束" |
| 36 | nit | 面板标题忽略 `askOnWrite=false` | 修好 | `64be888`；标题区分"逐次请示"与"需先授权" |

## 验证

```
node test/run-all.mjs        # 9/9 套件，235 项检查
node tools/check-repo.mjs    # 89 文件，0 FAIL / 0 WARN（现在连 baseline/evidence 一起扫）
node tools/measure-surface.mjs dexter   # 4 工具 / 7,034 B
node tools/e2e-live.mjs      # 真机闭环（Shell 开记事本 → 点 → 打 → 存 → 读回）
node test/panel-probe.mjs    # 置顶 / 工具窗口 / 工作区内 / 不抢焦点
node test/panel-click.mjs    # × 真的缩成边条
node test/panel-reopen.mjs   # 关掉后面板能重开
```

## 已知限制（明确保留，不假装修好）

1. 目标识别用**进程名 + 标题子串**：改名程序可能漏判；普通应用里的密码框识别不出（`SECURITY.md`）。
2. **读不受闸门约束**：截图/UIA 可以读到凭据管理器窗口（`SECURITY.md` 已写）。
3. `focus` 会改前台，按只读动作处理但会留审计行。
4. 人类暂停靠 150ms 轮询，不是内核钩子（最长约 160ms 反应）。
5. 面板崩溃不会自动重启（避免把"我主动退出"也当成崩溃）；状态页会显示"未运行"。
6. 自包含安装仍未做：依赖 `dsh-click-matrix` + `dsh-x2` 在位（D2）。
7. A15（CI）仍未在 GitHub 上跑过：按 R8 不推送。
