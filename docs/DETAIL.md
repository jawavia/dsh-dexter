# dsh-dexter 详情

## 这个插件解决的问题

旧包（`dsh-desktop-hands` 0.2.6）把三套引擎（pixel / control / stroke）直接拼在一个
bundle 里：25 个工具、35,201 B 的工具描述、三份格式各不相同的审计、两套写入口、只有
一套有安全语义。它"能干活"，但"声称的东西"和"实现的东西"对不上：一份审计、一处设置、
共用安全设施——这三条都不成立。

`dsh-dexter` 只重写**内核**，不碰注入实现：

| 层 | 谁负责 |
|---|---|
| 任务状态机 / 授权 / 暂停 / 验证 / 审计 / 路由 | 本插件（`kernel/`） |
| Win32 注入、晶格坐标、UIA 桥、窗口拒绝清单 | 原引擎（`backends/legacy-*` 适配器） |

## 对外工具面

默认 **4 个**：

- `hands_view`：只读，11 个 action（看环境/列窗口/切前台/截图/放大/坐标换算/UIA 文字/自动读屏/等稳定/等窗口/控件树）；
- `hands_act`：**唯一**写入口（移动/点击/拖拽/滚动/输入/按键/快捷键，另有 `stop` 只能收权）；
- `hands_run`：批量步骤，一次人类授权、每步一行审计、失败给 `resumeFrom`；
- `hands_status`：只读状态（授权/急停/暂停/后端/配置/审计尾部）。

开启 `toyStrokeEnabled` 后**多一个**、且只有一个 `stroke_toy`：只画预设图形
（circle/square/triangle/heart/star/wave），点数有硬上限，描述里写清"玩法/演示，不是
生产力工具"。默认关闭时，笔画引擎根本不会被加载。

## 授权模型（会话制 + 两层硬约束）

1. **没开会话**：每次写动作逐条请示（`askOnWrite`，默认开）；
2. **开会话**（`/dexter arm` 或 `Ctrl+Alt+F12`）：在**分钟数 / 次数 / 每分钟频率**三个上限内不再询问；
   数值在设置页改（`armMinutes` 30、`armActions` 200、`maxActionsPerMinute` 60），也可单次
   `/dexter arm 45m 300` 覆盖；`Ctrl+Alt+F10` 续期；
3. **系统/安全类目标永久禁止**：注册表、任务管理器、服务/组策略/事件查看器、安全软件面板、
   凭据管理器、系统设置、管理员权限窗口——**任何授权都不覆盖**，且这张清单**不可配置**（只能改代码）；
4. **私人相关逐条请示**：聊天、邮件、支付/银行、标题像密码/登录的目标，**会话授权也不覆盖**，
   每次仍单独问；
5. 急停（`hands_act action=stop`、`/dexter stop`、`Esc`、`Ctrl+Alt+F11`、`stop.signal`）**撤销**授权，
   下一次写动作一律拒绝；模型可以收权，永远不能给自己授权。

## 审计

一次运行只有一份：`<DSH_HOME>/dexter/audit/hands.jsonl`，append-only、带
`seq/prev/h` 哈希链。每个"已执行"动作都有一行，包含 capability、backend、engineTool、
approval、result、verify、argsHash、durationMs；`forwarded` 行是原引擎的决策转发，
`mode:"toy"` 标记玩具笔画。审计**不是**安全边界（key-less 链，只能发现"被人改过一行"，
挡不住整文件重写）。

## 桌面面板与界面

- **桌面小条**（`ui/Panel.cs` → 系统自带 `csc` 编译成 `Panel.exe`，进程独立）：置顶、不抢焦点
  （`WS_EX_NOACTIVATE`）、不占任务栏也不进 Alt+Tab（`WS_EX_TOOLWINDOW`）、按 `Screen.WorkingArea`
  夹住所以**压不到任务栏**；可拖、`×` 缩成右边 14px 竖条、双击展开、右键/托盘同一套中文菜单；
  位置存 `panel-pos.txt`，文字每秒从插件写入的 `state.txt` 读取（第一行状态、第二行"在看/在操作/在等待"）；
  `panel.ensure()` 会在进程被关掉后重新拉起（`/dexter panel show` 调用它）。
- **输入框旁两个按钮**（`client.js` → `conversation.composer.dock`）：`授权` 发送 `/dexter arm 15m 100`，
  `面板` 发送 `/dexter panel show`。都走 `InputActions`（`captureInsertion`/`insertText`/`setDraft`/`submit`），
  按钮本身不授予任何权限——按下去的是人，真正开授权的是 `/dexter arm`。
- **没有页内悬浮件**：页面元素一旦被别的窗口盖住就没了，那正是状态条要解决的场景，所以状态只放在桌面小条上。

## 已知限制

- Windows-only（`os: win32`），依赖原引擎存在才能注入；
- 人类暂停用 150ms 轮询 `GetAsyncKeyState` + 光标位移，不是内核级钩子，最长约 160ms 才反应过来；
- 目标分类靠**进程名 + 标题子串**（`kernel/targets.js`）：改了名的程序、少见标题可能漏判；普通应用里的**密码输入框**识别不出来（这条写在 `SECURITY.md`，不藏）；
- 频率上限是"每分钟动作数"，不是逐秒平滑；一次批量仍可能瞬间很密（受 `maxActionsPerMinute` 约束）；
- 前台断言的强度取决于目标窗口是否可读进程名；
- 截图走原引擎的图片预算；`verifyMode=hash` 需要 UIA 后端在位；
- 笔画玩具不再依赖 `dsh-stroke`（改为本地用 MIT 的 Win32 原语画），但**真画一笔**等于一次真实左键拖拽，测试里刻意不触发。
