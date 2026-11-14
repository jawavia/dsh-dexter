# 从 dsh-click-matrix 迁到 dsh-dexter

升级关系：**dsh-dexter 取代 dsh-click-matrix v0.9.5**。同一个 pixel 注入引擎（vendor 进来、未修改），
外面那层换了。旧 bundle `dsh-desktop-hands` **保持安装但禁用**——两套工具挂在同一个桌面上会重复，
两个 gate 会互相抢授权，两个 helper 会抢 `Ctrl+Alt+F11`。

## 工具对照

| 旧（dsh-click-matrix） | 新（dsh-dexter） | 说明 |
|---|---|---|
| `mouse_click` | `hands_act { action: 'click' }` | 坐标 / `window`+`fx,fy` / `control`（UIA 优先） |
| `mouse_move` | `hands_act { action: 'move' }` | **悬停免授权**（有审计、限速、按键按住即拒） |
| `mouse_drag` | `hands_act { action: 'drag' }` | 终点也会分类，终点不可探测即拒绝 |
| `mouse_scroll` | `hands_act { action: 'scroll' }` | |
| `type_text` | `hands_act { action: 'type' }` | 控件优先用 `setvalue`，不经过键盘 |
| `press_keys` | `hands_act { action: 'key' / 'hotkey' }` | 单键用 `key`，组合用 `keys` |
| `clipboard_get` / `clipboard_set` | `hands_act { action: 'clipboard_get' / 'clipboard_set' }` | 两个都**逐条请示**，会话授权不覆盖 |
| `mouse_batch` | `hands_run { steps: [...] }` | 一次决策，但**按步数扣额度与频率** |
| `mouse_abort` | `hands_act { action: 'stop' }` | 撤销授权，仍可用 `/dexter arm` 恢复 |
| `screen_view`（info/list/focus/capture/zoom/locate/text/read/wait/wait_window/uia） | `hands_view { action: ... }` | 动作名基本一一对应 |
| `click_matrix_doctor` | `hands_status { doctor: true }` | 附带引擎自检 |
| `audit_tail` | `hands_status { tail: N }` | 单一哈希链，含悬停 |
| `matrix_overlay`（晶格叠加层） | **没有** | 视图不画晶格；`capture` 仍返回晶格换算信息 |
| `screen_look` / 旧 `screen_*` 家族 | 合并进 `hands_view` | 工具数从 14 降到 4 |

## 命令对照

| 旧 | 新 |
|---|---|
| `/click-matrix status` | `/dexter status`（或 `hands_status`） |
| `/click-matrix arm <秒\|on>` | `/dexter arm [15m] [100]` — **没有 `on`**，永远有到期时间与次数 |
| `/click-matrix mode off\|ask\|auto` | 没有 mode：默认逐次请示，开一次会话就不问；`askOnWrite=false` 时直接拒绝而不是自动放行 |
| `/click-matrix stop` | `/dexter stop` |
| `/click-matrix hotkeys-retry` | 没有对等命令：热键健康现在直接显示在 `hands_status`，helper 泄漏已在 dispose 时回收 |
| `/click-matrix lattice coarse\|standard\|...` | 没有对等命令（引擎仍按 `standard` 输出晶格信息） |
| — | `/dexter extend`、`/dexter clear`、`/dexter panel show\|hide\|reset\|exit` |

## 行为差异（迁移时最容易踩的四处）

1. **授权不再"开一次管到底"**：默认 15 分钟 / 100 次 / 30 每分钟，到期自动回落逐次请示。
   要更宽松就调 `armMinutes` / `armActions` / `maxActionsPerMinute`，或在命令里直接给数字。
2. **批量会按步扣费**：25 步的批量要 25 次额度、25 个频率 tick。余额不足会**整批拒绝**，
   而不是跑到一半才失败。
3. **`move` 从"免授权"变成"悬停免费但留痕"**：鼠标键按下时拒绝移动（否则等于拖拽）。
4. **系统类目标由内核永久拒绝**：注册表、任务管理器、安全软件、凭据管理器、管理员窗口——
   任何授权都不覆盖；私人目标（聊天/邮件/支付/`*.kdbx`）即使有会话也逐条问。

## 迁移步骤

1. DSH → Plugins：停用 `dsh-desktop-hands`（保持安装，别删）；启用 `dsh-dexter`。
2. 打开 `hands_status`，确认 `pixel=ok · uia=ok`，看 `面板：运行中`。
3. 按习惯改设置（`armMinutes` / `armActions` / `maxActionsPerMinute` / `hoverFree` / `askOnWrite`）。
4. 第一次用：`/dexter arm 15m 100` 或 `Ctrl+Alt+F12`，然后 **先看再动**：
   `hands_view { action: 'read' }` → `hands_act`。
5. 想验证整条链路：`node tools/e2e-live.mjs`（Shell 开一个记事本 → 点 → 打 → 存 → 读回）。

## 回滚

旧包没有删除，依赖也还在：停用 `dsh-dexter`、启用 `dsh-desktop-hands` 即可回到 v0.9.5。
注意两边的 `~/.dsh/click-matrix` 数据目录共用同一个 helper 程序，但审计分属两个文件
（`~/.dsh/dexter/audit/hands.jsonl` 与 `~/.dsh/click-matrix/audit.jsonl`）。
