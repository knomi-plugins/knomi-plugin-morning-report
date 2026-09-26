// ============================================================
// Knomi Agent - 晨报生成（M6b 主动期）
//
// 管什么：每日一次收集学习档案与记忆素材 → LLM 生成晨报 Markdown →
//         写入知识库仓库「小诺晨报/」并重索引 + 通知触达。
// 不管什么：LLM Provider 配置（宿主 R8 唯一入口）、仓库选择策略（首个仓库）、
//          提醒守护（study-reminder.js）、调度本身。
// 被谁调用：index.js _setupMorningReport（定时 + 配置驱动）/
//          generateMorningReport（plugin:invoke，E2E 确定性触发口）。
// 注入式设计：collectData/llmComplete/writeDoc/notify 全部可 mock（单测锁定逻辑）。
// ============================================================

/** 本地日期串（YYYY-MM-DD；晨报属于用户的本地日，禁用 toISOString 的 UTC 偏移） */
function localDateStr(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

class MorningReport {
  /**
   * @param {object} opts
   * @param {() => Promise<{dateStr: string, due: number, weak: string[], recentMemories: string[], graphRelated?: string, toolHealthSummary?: string, streakDays?: number, yesterdayCount?: number, packPending?: number, packBlank?: number, packBlankTitles?: string[]}>} opts.collectData 素材收集
   * @param {(messages: Array<{role: string, content: string}>) => Promise<string>} opts.llmComplete LLM 调用（R8 唯一入口）
   * @param {(dateStr: string, markdown: string) => Promise<string>} opts.writeDoc 落库（返回文档路径）
   * @param {(docPath: string) => void} [opts.notify] 通知触达
   * @param {(msg: string) => void} [opts.log]
   * @param {number} [opts.hour] 晨报时刻（0-23，默认 8）
   * @param {number} [opts.maxRetries] 单日生成失败重试上限（默认 3）
   */
  constructor({ collectData, llmComplete, writeDoc, notify, log, hour = 8, maxRetries = 3 }) {
    this._collectData = collectData
    this._llmComplete = llmComplete
    this._writeDoc = writeDoc
    this._notify = notify || (() => {})
    this._log = log || (() => {})
    this._hour = hour
    this._maxRetries = maxRetries
    /** 当日已生成标记：{ dateStr, docPath } */
    this.generatedToday = null
    /** 当日失败重试计数（超限则当日不再尝试） */
    this._failCount = 0
    this._failDate = ''
  }

  /** 定时判定：当前小时到达晨报时刻 且 今日未生成 且 未超失败上限 */
  shouldGenerateNow(now = new Date()) {
    if (now.getHours() < this._hour) return false
    const dateStr = localDateStr(now)
    if (this.generatedToday?.dateStr === dateStr) return false
    if (this._failDate === dateStr && this._failCount >= this._maxRetries) return false
    return true
  }

  /**
   * 立即生成一次（定时到期或 E2E/手动触发共用入口）。
   * @returns {Promise<{ok: boolean, docPath?: string, skipped?: string, error?: string}>}
   */
  async generateNow(now = new Date()) {
    const dateStr = localDateStr(now)
    if (this.generatedToday?.dateStr === dateStr) {
      return { ok: true, docPath: this.generatedToday.docPath, skipped: 'already generated today' }
    }
    try {
      const data = await this._collectData()
      const markdown = await this._llmComplete(this._buildMessages(data))
      if (!markdown || String(markdown).trim().length < 20) {
        throw new Error('模型输出过短，疑似生成失败')
      }
      const docPath = await this._writeDoc(dateStr, String(markdown))
      this.generatedToday = { dateStr, docPath }
      this._notify(docPath)
      this._log(`晨报已生成: ${docPath}`)
      return { ok: true, docPath }
    } catch (err) {
      // 当日失败计数（超限当日不再尝试，防 LLM 故障时每轮空烧）
      if (this._failDate !== dateStr) { this._failDate = dateStr; this._failCount = 0 }
      this._failCount++
      this._log(`晨报生成失败（${this._failCount}/${this._maxRetries}）: ${(err && err.message) || err}`)
      return { ok: false, error: (err && err.message) || String(err) }
    }
  }

  /** 定时到期判定 + 生成（守护 timer 调用） */
  async checkAndGenerate(now = new Date()) {
    if (!this.shouldGenerateNow(now)) return { skipped: 'not due' }
    return this.generateNow(now)
  }

  /** 组装晨报 LLM 消息（素材 → 结构化 Markdown 要求） */
  _buildMessages(data) {
    const weakList = (data.weak || []).slice(0, 5)
    const memList = (data.recentMemories || []).slice(0, 5)
    return [
      {
        role: 'system',
        content: '你是「小诺」，Knomi 的学习管家。根据素材生成今日学习晨报，输出 Markdown（不要代码围栏）。⚠️ 禁止输出一级标题（# 开头的行）——系统落库时自动添加；正文从二级标题开始，下设「今日待复习」「薄弱点关注」「学习包积压」「最近记忆要点」「今日规划建议」「小诺的一句话」六个小节；「学习包积压」节依据素材中的积压/体系空白数据列出数量与主题，无数据写「今天暂无」；其中「今日规划建议」必须给出今天具体可执行的行动（先复习哪些薄弱文档、做多少题、按什么顺序），禁止泛泛而谈；无数据的节写「今天暂无」。语气简洁友好，总长不超过 300 字。',
      },
      {
        role: 'user',
        content: [
          `日期: ${data.dateStr}`,
          `到期复习题数: ${data.due}`,
          `薄弱知识点: ${weakList.length ? weakList.join('、') : '无'}`,
          data.graphRelated ? `图谱关联薄弱文档: ${data.graphRelated}` : '',
          data.streakDays ? `连续学习: ${data.streakDays} 天（每日至少 1 题，可在「今日待复习/规划」节鼓励延续）` : '',
          data.yesterdayCount ? `昨日作答: ${data.yesterdayCount} 题` : '',
          data.packPending ? `学习包积压: ${data.packPending} 个待挂靠确认（可在学习包收件箱处理）` : '',
          data.packBlank ? `体系空白: ${data.packBlank} 个学习包挂不进现有知识体系（主题：${(data.packBlankTitles || []).join('、')}）——可建议用户聚合成文或补建体系` : '',
          `最近记忆: ${memList.length ? memList.map((m) => `[${m}]`).join(' ') : '无'}`,
          data.toolHealthSummary ? `小诺工具健康: ${data.toolHealthSummary}` : '',
        ].join('\n'),
      },
    ]
  }
}

module.exports = { MorningReport, localDateStr }
