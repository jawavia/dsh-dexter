/**
 * The whole model-facing surface: four tools, or five with the stroke toy.
 *
 * Byte budget is a design constraint, not a side effect (baseline: 25 tools /
 * 35,201 B). So:
 *   - no house-style preamble in a description: what it does, when to use it, and
 *     the one constraint a caller can actually get wrong;
 *   - parameter rules live on the parameter, once;
 *   - `hands_run`'s step object repeats names but not explanations.
 *
 * The render function is shared: every tool returns `{text, imageRef?}` and the
 * block list is built in one place.
 */
import { TOY_SHAPES, buildShape } from '../backends/toy-draw.js'
import { shortText } from '../kernel/util.js'

const OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  required: ['text'],
  properties: {
    text: { type: 'string' },
    imageRef: { type: 'object' },
  },
})

function render(_args, value) {
  const text = value && typeof value.text === 'string' ? value.text : ''
  const blocks = [{ type: 'text', text }]
  if (value && value.imageRef && typeof value.imageRef === 'object') {
    blocks.push({ type: 'image', attachment: value.imageRef })
  }
  return blocks
}

function tool(name, description, parameters, execute) {
  return {
    name,
    description,
    parameters,
    output: { schema: OUTPUT_SCHEMA, render },
    async execute(args, exec) {
      try {
        const value = await execute(args && typeof args === 'object' ? args : {}, exec && typeof exec === 'object' ? exec : {})
        return toToolValue(value)
      } catch (error) {
        return { text: `hands 内部错误: ${shortText(error && error.stack ? error.stack : error, 400)}` }
      }
    },
  }
}

/**
 * The host validates a returned value against the output schema and rejects anything
 * that is not lossless JSON — an `undefined` property or an extra field fails the whole
 * call. So every tool result is reduced to exactly what the schema declares.
 */
function toToolValue(value) {
  const source = value && typeof value === 'object' ? value : {}
  const text = typeof source.text === 'string' ? source.text : String(value ?? '')
  const out = { text }
  if (source.imageRef && typeof source.imageRef === 'object' && !Array.isArray(source.imageRef)) {
    out.imageRef = source.imageRef
  }
  return out
}

const WINDOW_PARAM = {
  type: 'object',
  properties: {
    handle: { type: 'integer', description: '窗口句柄 HWND' },
    titleContains: { type: 'string', description: '标题子串（不区分大小写）' },
    pid: { type: 'integer', description: '进程 pid' },
  },
  description: '目标窗口；省略=前台窗口。',
}

/** Steps inside `hands_run`: same names as hands_act, no repeat of the prose. */
const STEP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['action'],
  properties: {
    action: {
      type: 'string',
      enum: ['move', 'click', 'drag', 'scroll', 'type', 'key', 'hotkey'],
    },
    x: { type: 'number', description: '物理像素 x' },
    y: { type: 'number' },
    fx: { type: 'number', description: '窗口内归一化 x（需 window）' },
    fy: { type: 'number' },
    window: WINDOW_PARAM,
    control: { type: 'string', description: 'UIA 控件路径（动作时重测位置）' },
    how: { type: 'string', enum: ['invoke', 'click'] },
    toX: { type: 'number', description: 'drag 终点 x' },
    toY: { type: 'number' },
    button: { type: 'string', enum: ['left', 'right', 'middle'] },
    count: { type: 'number' },
    deltaX: { type: 'number' },
    deltaY: { type: 'number' },
    text: { type: 'string', description: 'type 的文本' },
    key: { type: 'string', description: '单键，如 enter' },
    keys: { type: 'string', description: '组合，如 ctrl+s' },
  },
}

/**
 * @param {{kernel:object, config:object, statusText:Function}} deps
 * @returns {object[]} the tools to register
 */
export function buildDefinitions({ kernel, config, statusText }) {
  const view = tool(
    'hands_view',
    '看桌面（只读，不注入）：info 环境总览 | list 窗口 | focus 切前台 | capture 截图 | zoom 放大 | locate 坐标换算 | text UIA 文字 | read 自动读屏 | wait 等画面稳定 | wait_window 等窗口出现 | uia 控件树。'
      + '坐标类写动作之前必须先看一眼（默认要求 120 秒内）。截图以 imageRef 返回，受图片预算约束。',
    {
      type: 'object',
      required: ['action'],
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['info', 'list', 'focus', 'capture', 'zoom', 'locate', 'text', 'read', 'wait', 'wait_window', 'uia'],
          description: '必填：要看的动作。',
        },
        window: WINDOW_PARAM,
        x: { type: 'number', description: '屏幕物理像素 x（capture/zoom/locate）' },
        y: { type: 'number' },
        fx: { type: 'number', description: '归一化 0..1；给 window 时=窗口内相对位置' },
        fy: { type: 'number' },
        region: {
          type: 'object',
          properties: { x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } },
          required: ['x', 'y', 'w', 'h'],
          additionalProperties: false,
          description: '像素矩形：截图区域 / 等待比较区域 / 文字过滤区域。',
        },
        scale: { type: 'number', description: 'zoom 放大倍数 1..8' },
        query: { type: 'string', description: 'list 的过滤 / read 的元素过滤 / uia find 的名字' },
        path: { type: 'string', description: 'uia：控件路径（如 0/2/1），给了就只回位置' },
        limit: { type: 'integer', description: 'list 最多几行，默认 25' },
        timeoutMs: { type: 'integer', description: 'wait/wait_window 超时 ms' },
      },
    },
    async (args, exec) => kernel.view({ action: args.action, args, exec }),
  )

  const act = tool(
    'hands_act',
    '唯一的写入入口：点击/拖拽/滚动/移动光标/输入文字/按键/快捷键/剪贴板（读与写都逐条请示）。目标用坐标（x/y 或 window+fx/fy）、UIA 控件（control，优先且动作时重测位置）或前台窗口（type/key/hotkey）。'
      + '默认每次请求人类授权；dryRun 只预演不注入；执行后按配置验证。action=stop 立即撤销授权（只收不放）。',
    {
      type: 'object',
      required: ['action'],
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['move', 'click', 'drag', 'scroll', 'type', 'key', 'hotkey', 'clipboard_get', 'clipboard_set', 'stop'],
          description: '必填：要做的动作。',
        },
        x: { type: 'number', description: '物理像素 x' },
        y: { type: 'number' },
        fx: { type: 'number', description: '归一化 0..1；给 window 时=窗口内相对位置' },
        fy: { type: 'number' },
        window: WINDOW_PARAM,
        control: { type: 'string', description: 'UIA 控件路径，优先于坐标' },
        how: { type: 'string', enum: ['invoke', 'click'], description: 'control 的驱动方式，默认 invoke' },
        toX: { type: 'number', description: 'drag 终点 x' },
        toY: { type: 'number' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: '默认 left' },
        count: { type: 'number', description: '点击/按键次数，默认 1' },
        deltaX: { type: 'number', description: '横向滚动量（120=一格）' },
        deltaY: { type: 'number', description: '纵向滚动量，正=向下' },
        text: { type: 'string', description: 'type / clipboard_set 的文本（不回显，审计只记字数）' },
        key: { type: 'string', description: '单键，如 enter/tab/esc/f5' },
        keys: { type: 'string', description: '组合键，如 ctrl+s' },
        expect: {
          type: 'object',
          properties: { process: { type: 'string' }, titleContains: { type: 'string' } },
          description: '执行后的前台断言。',
        },
        dryRun: { type: 'boolean', description: 'true=只预演：解析目标与授权，不注入、不消耗授权。' },
      },
    },
    async (args, exec) => kernel.act({ action: args.action, args, exec }),
  )

  const run = tool(
    'hands_run',
    '一次调用跑完一串动作（切窗口 → 点输入框 → 打字 → 回车），整批只请求一次人类授权，每一步各写一行审计。'
      + '任何一步失败默认立即停下，并给出 resumeFrom 续跑点；dryRun 只预演整批。',
    {
      type: 'object',
      required: ['steps'],
      additionalProperties: false,
      properties: {
        steps: { type: 'array', minItems: 1, maxItems: 25, items: STEP_SCHEMA, description: '按顺序执行的动作，字段同 hands_act。' },
        resumeFrom: { type: 'integer', description: '1-based 续跑起点，默认 1。' },
        stopOnError: { type: 'boolean', description: '某步失败就停，默认 true。' },
        dryRun: { type: 'boolean', description: 'true=只预演整批，不注入、不消耗授权。' },
      },
    },
    async (args, exec) => kernel.run({ steps: args.steps, options: args, exec }),
  )

  const status = tool(
    'hands_status',
    '只读状态：授权/急停/人类暂停、后端可用性、热键健康、配置摘要、审计尾部与计数。状态里写清楚"下一次写动作会不会被拒"。doctor=true 追加引擎自检。',
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        tail: { type: 'integer', description: '附最近几条审计，默认 8，上限 40。' },
        doctor: { type: 'boolean', description: 'true=追加引擎自检（截图/热键/授权状态，只读）。' },
      },
    },
    async (args) => {
      let text = statusText({ tail: args.tail })
      if (args.doctor === true) {
        text += `\n\n—— 引擎自检（click_matrix_doctor）——\n${await kernel.doctor()}`
      }
      return { text }
    },
  )

  const tools = [view, act, run, status]

  if (config.toyStrokeEnabled) {
    tools.push(tool(
      'stroke_toy',
      '玩法/演示用的笔势玩具（不是生产力工具）：在屏幕上画一个预设图形（circle/square/triangle/heart/star/wave），点数有硬上限，不接受任意轨迹。'
        + '同样经过人类授权与审计（mode=toy）。',
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          shape: { type: 'string', enum: TOY_SHAPES, description: '预设图形，默认 circle。' },
          cx: { type: 'number', description: '中心 x，默认屏幕中心。' },
          cy: { type: 'number', description: '中心 y，默认屏幕中心。' },
          radius: { type: 'number', description: '半径 px，默认 160，上限 1200。' },
          points: { type: 'integer', description: `采样点数，默认 240，上限 ${config.toyStrokeMaxPoints}。` },
          durationMs: { type: 'integer', description: '整笔时长 ms，默认 600。' },
          button: { type: 'string', enum: ['L', 'R'], description: '默认 L。' },
          dryRun: { type: 'boolean', description: 'true=只回报点数和预计耗时。' },
        },
      },
      async (args, exec) => kernel.toy({ args, exec, buildShape }),
    ))
  }

  return tools
}
