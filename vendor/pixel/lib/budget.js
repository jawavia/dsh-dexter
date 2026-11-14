/**
 * dsh-click-matrix — per-agent image budget + consecutive-capture dedupe.
 *
 * Rolling 120 s window per agent: at most `maxImagesPerTurn` images and
 * `maxImageTokensPerTurn` estimated visual tokens. A repeat capture with the
 * same captureHash as the previous image RETURNED to that agent is deduped
 * ("画面未变化") so a model cannot burn the budget on identical screenshots.
 *
 * Clock is injectable for tests. All methods are synchronous and never throw.
 */

const WINDOW_MS = 120000

export class ImageBudget {
  /**
   * @param {object} options
   * @param {number} options.maxImages
   * @param {number} options.maxTokens
   * @param {() => number} [options.now]
   */
  constructor(options = {}) {
    this.maxImages = Math.max(0, Math.round(Number(options.maxImages) || 0))
    this.maxTokens = Math.max(0, Math.round(Number(options.maxTokens) || 0))
    this.now = typeof options.now === 'function' ? options.now : () => Date.now()
    this.states = new Map()
  }

  #state(agent) {
    const key = String(agent || 'unknown')
    const now = this.now()
    let st = this.states.get(key)
    if (!st || now - st.windowStart >= WINDOW_MS) {
      st = { windowStart: now, images: 0, tokens: 0, lastHash: '', lastAt: 0 }
      this.states.set(key, st)
    }
    return st
  }

  /** Reset accounting for one agent (tests / explicit reset). */
  reset(agent) {
    if (agent === undefined) this.states.clear()
    else this.states.delete(String(agent))
  }

  /**
   * Check whether an image of `tokens` estimated tokens may be returned now.
   * Does not reserve. Returns {allowed, reason, remainingImages, remainingTokens}.
   */
  check(agent, tokens) {
    const st = this.#state(agent)
    const t = Math.max(0, Math.round(Number(tokens) || 0))
    const remainingImages = this.maxImages - st.images
    const remainingTokens = this.maxTokens - st.tokens
    if (this.maxImages <= 0) {
      return { allowed: false, reason: '图片预算为 0（maxImagesPerTurn=0）', remainingImages: 0, remainingTokens, windowStart: st.windowStart }
    }
    if (remainingImages <= 0) {
      return {
        allowed: false,
        reason: `本轮图片预算已用完（120s 内已返回 ${st.images}/${this.maxImages} 张）。改用 screen_text / screen_zoom / 文字坐标，或等窗口滑过后再截图。`,
        remainingImages,
        remainingTokens,
        windowStart: st.windowStart,
      }
    }
    if (t > remainingTokens) {
      return {
        allowed: false,
        reason: `本轮图片 token 预算不足（剩 ${Math.max(0, remainingTokens)}，需要约 ${t}）。改用 screen_text / screen_locate / 更小的 region 或更粗的 binning。`,
        remainingImages,
        remainingTokens,
        windowStart: st.windowStart,
      }
    }
    return { allowed: true, remainingImages, remainingTokens, windowStart: st.windowStart }
  }

  /** True when `hash` equals the last hash RETURNED with an image to this agent. */
  isDuplicate(agent, hash) {
    if (typeof hash !== 'string' || hash === '') return false
    const st = this.#state(agent)
    return st.lastHash !== '' && st.lastHash === hash
  }

  /** Record a returned image. */
  record(agent, { tokens, hash }) {
    const st = this.#state(agent)
    st.images += 1
    st.tokens += Math.max(0, Math.round(Number(tokens) || 0))
    if (typeof hash === 'string' && hash !== '') st.lastHash = hash
    st.lastAt = this.now()
  }

  /** Snapshot for screen_info / doctor. */
  snapshot(agent) {
    const st = this.#state(agent)
    return {
      windowStart: st.windowStart,
      images: st.images,
      tokens: st.tokens,
      maxImages: this.maxImages,
      maxTokens: this.maxTokens,
      lastHash: st.lastHash,
      ageMs: this.now() - st.windowStart,
    }
  }
}
