// ============================================================
// 晨报管家（morning-report 能力包）
//
// 管什么：晨报的手动生成与查看入口——
//         ① 托盘右键「今日晨报」（tray.menu 扩展点挂载，常驻可达；无则生成、有则打开；
//            结果通知点击深链晨报页正文——click route 声明式，docPath 为旧主进程兜底）
//         ② 编辑器右上角「晨报」面板：生成 / 打开指定日期晨报（表单 submit
//            返回 route，平台约定式深链晨报页页内展示正文，不跳编辑器知识库）
//         ③ Agent 工具 generate_morning_report / list_morning_reports（小诺可代劳）
//         ④ 侧边栏「能力包 → 晨报」页（nav.entry 扩展点，v2 复合页）：指标卡 +
//            近 14 天产出折线 + 类型分布环图 + 明细表，行点击页内下钻查看正文
//            （detail 契约，不依赖文件树活动仓库、不跳编辑器）
// 不管什么：每日定时生成与学习提醒（knomi-agent 中枢守护，设置页配置）；
//          记忆要点采集（中枢记忆库不对能力包开放，手动晨报该节为「今天暂无」）；
//          晨报内容排版（morning-report.js 引擎锁定五节结构）。
// 落点：仓库 sys-hub「小诺晨报/」（新用户默认自带）；插件配置 report_repo_name 可覆盖。
// 幂等：当日晨报已存在则直接打开，不重复调用 LLM。
// ============================================================

const path = require('path')
const { MorningReport } = require('./morning-report')

const PLUGIN_ID = 'morning-report'

let context = null
let engine = null
let engineDate = ''

/** 本地日期串（YYYY-MM-DD；禁用 toISOString 的 UTC 偏移） */
function localDateStr(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 归一化用户输入日期（留空=今天；非法格式抛错） */
function normalizeDate(input) {
  const s = String(input || '').trim()
  if (!s) return localDateStr()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error('日期格式应为 YYYY-MM-DD')
  return s
}

/** 解析晨报写入仓库：插件配置 report_repo_name > 系统仓库 sys-hub > 第一个仓库 */
async function resolveRepo() {
  const repos = (await context.listRepositories()) || []
  if (repos.length === 0) return null
  let wanted = ''
  try {
    wanted = String(((await context.getConfig()) || {}).report_repo_name || '').trim()
  } catch { /* 配置读取失败按未配置处理 */ }
  if (wanted) {
    const hit = repos.find((r) => String(r.name || '').toLowerCase() === wanted.toLowerCase())
    if (hit) return hit
  }
  return repos.find((r) => r.name === 'sys-hub') || repos[0]
}

async function reportPathFor(dateStr) {
  const repo = await resolveRepo()
  if (!repo) return null
  return path.join(repo.localPath, '小诺晨报', `${dateStr}.md`)
}

/** 晨报存在性判断（权威源 = 已索引文档表）：
 *  ⚠️ 不能用 ctx.readFile 是否为空判断——宿主对未入库路径返回空串（知识库中心契约），会误判为已存在。 */
async function reportExists(dateStr) {
  const p = await reportPathFor(dateStr)
  if (!p) return false
  const rows = await context.query('SELECT id FROM documents WHERE file_path = ?', [p])
  return Array.isArray(rows) && rows.length > 0
}

/** 引擎按日重建：当日幂等标记（generatedToday）与自然日对齐，跨日自动可再生成 */
function getEngine() {
  const today = localDateStr()
  if (!engine || engineDate !== today) {
    engine = new MorningReport({
      hour: 0, // 手动触发不做时刻判定（时刻判定只属于中枢定时路径）
      collectData: async () => {
        const nowIso = new Date().toISOString()
        // 文档锚点制 P1（ADR-103 v3）：到期/薄弱单元 = 文档（作答流水 practice_attempts）
        const dueRows = await context.query(
          `SELECT COUNT(*) AS n FROM documents WHERE (next_review_at IS NULL OR next_review_at <= ?)`,
          [nowIso],
        )
        const weak = await context.query(
          `SELECT d.title FROM documents d
           JOIN practice_attempts a ON a.document_id = d.id
           GROUP BY d.id, d.title
           HAVING (SUM(CASE WHEN a.correct = 1 THEN 100.0 ELSE 0 END) * 1.0 / COUNT(*)) < 60
           ORDER BY COUNT(*) DESC LIMIT 5`,
        )
        // 学习战报素材（v0.2.0）：连续学习天数（每日至少 1 题口径，自昨日往回数）与昨日作答数
        let streakDays = 0
        let yesterdayCount = 0
        try {
          const rows = await context.query(
            `SELECT DATE(answered_at, 'localtime') AS day, COUNT(*) AS n FROM question_attempts GROUP BY day`,
          )
          const counts = new Map((rows || []).map((r) => [String(r.day), Number(r.n) || 0]))
          const yesterday = new Date()
          yesterday.setDate(yesterday.getDate() - 1)
          yesterdayCount = counts.get(localDateStr(yesterday)) || 0
          let cursor = yesterday
          while ((counts.get(localDateStr(cursor)) || 0) >= 1 && streakDays < 3650) {
            streakDays++
            cursor.setDate(cursor.getDate() - 1)
          }
        } catch { /* 战报素材缺失不阻塞 */ }
        // 学习包积压素材（learning-pack v0.6.0 联动）：ready/parked=待挂靠，rejected=体系空白待聚合成文
        let packPending = 0
        let packBlank = 0
        const packBlankTitles = []
        try {
          const packRows = (await context.query(
            `SELECT title, frontmatter AS fm FROM documents WHERE file_path LIKE '%learning-packs%' ORDER BY created_at DESC LIMIT 100`,
          )) || []
          for (const r of packRows) {
            let st = ''
            try { st = String(JSON.parse(String(r.fm || '{}')).status || '') } catch {
              const m = String(r.fm || '').match(/"status"\s*:\s*"(\w+)"/)
              st = m ? m[1] : ''
            }
            if (st === 'ready' || st === 'parked') packPending++
            else if (st === 'rejected') {
              packBlank++
              if (packBlankTitles.length < 3) packBlankTitles.push(String(r.title || '').replace(/^\d{8}-\d{6}-学习包-/i, ''))
            }
          }
        } catch { /* 积压素材缺失不阻塞 */ }
        return {
          dateStr: today,
          due: Number(dueRows?.[0]?.n) || 0,
          weak: (weak || []).map((w) => w.title).filter(Boolean),
          recentMemories: [], // 中枢记忆库不对能力包开放；该节晨报显示「今天暂无」
          graphRelated: '',
          toolHealthSummary: '',
          streakDays,
          yesterdayCount,
          packPending,
          packBlank,
          packBlankTitles,
        }
      },
      llmComplete: async (messages) => {
        const out = await context.llm.complete({ messages, temperature: 0.4, maxTokens: 1200, timeoutMs: 90000 })
        return String(out || '').trim()
      },
      writeDoc: async (dateStr, markdown) => {
        const repo = await resolveRepo()
        if (!repo) throw new Error('无知识库仓库可写晨报')
        const docPath = path.join(repo.localPath, '小诺晨报', `${dateStr}.md`)
        await context.writeFile(docPath, `# 小诺晨报 · ${dateStr}\n\n${markdown}\n`)
        await context.reindexRepository(repo.id)
        return docPath
      },
      notify: () => { /* 托盘/面板路径各自有结果反馈，引擎内不再重复弹通知 */ },
      log: (msg) => context.log(`[晨报管家] ${msg}`),
    })
    engineDate = today
  }
  return engine
}

/** 确保指定日期的晨报存在并返回路径（已存在直接返回，不重复调 LLM） */
async function ensureReport(dateStr) {
  const p = await reportPathFor(dateStr)
  if (!p) throw new Error('无可用知识库仓库（请先在仓库管理添加仓库）')
  if (await reportExists(dateStr)) {
    return { filePath: p, created: false }
  }
  const r = await getEngine().generateNow(new Date())
  if (!r.ok) throw new Error(r.error || '晨报生成失败')
  return { filePath: r.docPath || p, created: true }
}

/** 晨报页深链（nav.entry 页 + 页内正文）：通知点击/面板提交的统一查看面——
 *  晨报在自己的插件页看（历史一览 + detail 下钻），不跳编辑器知识库 */
function packRouteWithDetail(filePath) {
  return `/pack/${PLUGIN_ID}/reports?detail=${encodeURIComponent(filePath)}`
}

/** 托盘挂载入口（tray.menu method）：生成今天/当日晨报，主进程以系统通知反馈结果。
 *  click 声明式深链（词汇与 ctx.notify.show 一致）：点通知直达晨报页正文；
 *  docPath 保留为旧主进程契约兜底（老版本 app 未识别 click 时仍可编辑器打开） */
async function generateFromTray() {
  try {
    const { filePath, created } = await ensureReport(localDateStr())
    context.log(`托盘晨报${created ? '生成' : '打开'}: ${filePath}`)
    return {
      ok: true,
      docPath: filePath,
      message: (created ? '已生成晨报：' : '今天已有晨报：') + filePath,
      click: { type: 'route', path: packRouteWithDetail(filePath) },
    }
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) }
  }
}

/** 面板提交入口（report.form submit）：生成/打开指定日期晨报，返回 route → 晨报页页内展示正文 */
async function openReport(args) {
  const dateStr = normalizeDate(args && args.date)
  const { filePath, created } = await ensureReport(dateStr)
  return { route: packRouteWithDetail(filePath), title: (created ? '已生成晨报 ' : '打开晨报 ') + dateStr }
}

/** 历史晨报行（已索引文档权威查询，跨仓库汇总，新→旧；含同目录学习规划文件）。
 *  ⚠️ 宿主 queryReadOnly 返回 camelCase 行键（toCamelCaseRow），file_path 需别名显式化。 */
async function queryReportRows() {
  return (await context.query(
    `SELECT d.title, d.file_path AS filePath FROM documents d
     WHERE d.file_path LIKE '%小诺晨报%' AND d.file_path LIKE '%.md'
     ORDER BY d.created_at DESC LIMIT 20`,
  )) || []
}

/** 累计产出真实总数：明细列表取最近 20 条（LIMIT），指标卡口径必须另计总数 */
async function countReports() {
  try {
    const rows = await context.query(
      `SELECT COUNT(*) AS n FROM documents d
       WHERE d.file_path LIKE '%小诺晨报%' AND d.file_path LIKE '%.md'`,
    )
    return Number(rows?.[0]?.n) || 0
  } catch { return 0 }
}

/** Agent 工具：列出已有晨报（从已索引文档查询，跨仓库汇总） */
async function listMorningReports() {
  const rows = await queryReportRows()
  if (!rows || rows.length === 0) return '暂无历史晨报。可让小诺「生成今天的晨报」，或点托盘/晨报面板生成。'
  return rows.map((r) => `- ${r.title || r.filePath}（${r.filePath}）`).join('\n')
}

/** nav.entry 页数据入口（ADR-202 Phase 2 第四消费者，v2 复合页）：历史晨报一览（确定性查询，无 LLM）。
 *  cards = 指标卡 + 近 14 天产出折线 + 类型分布环图 + 明细表；
 *  明细表行经 detail 下钻（pageReportDetail）在页内查看正文，不跳编辑器。 */
function weekdayOf(dateStr) {
  const m = String(dateStr || '').match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return ''
  return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getDay()]
}

/** 行元信息：文件名权威派生（documents.title 即文件名日期串，避免与日期列重复） */
function rowMeta(filePath) {
  const p = String(filePath || '')
  const name = p.split(/[\\/]/).pop() || ''
  const m = name.match(/(\d{4}-\d{2}-\d{2})\.md$/)
  const date = m ? m[1] : ''
  const kind = name.startsWith('规划-') ? '学习规划' : '晨报'
  return { path: p, name, date, kind, weekday: weekdayOf(date) }
}

async function pageReports() {
  let rows = []
  try { rows = await queryReportRows() } catch { /* 查询失败按空表呈现（页面空态可用，不抛错） */ }
  const metas = (rows || []).map((r) => rowMeta(r.filePath))
  const total = await countReports()
  const reports = metas.filter((x) => x.kind === '晨报').length
  const plans = metas.filter((x) => x.kind === '学习规划').length

  // 近 14 天产出（无产出的日期补零，与学习看板趋势口径一致）
  const days = []
  for (let i = 13; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    days.push({ label: key.slice(5), value: metas.filter((x) => x.date === key).length })
  }

  // 本周产出（周一为一周起点）
  const now = new Date()
  const monday = new Date(now); monday.setDate(now.getDate() - ((now.getDay() + 6) % 7))
  const mondayKey = `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, '0')}-${String(monday.getDate()).padStart(2, '0')}`
  const weekCount = metas.filter((x) => x.date >= mondayKey).length

  return {
    title: '小诺晨报',
    cards: [
      {
        type: 'stats',
        items: [
          { label: '累计产出', value: `${total} 篇` },
          { label: '本周产出', value: `${weekCount} 篇` },
          { label: '晨报 / 学习规划', value: `${reports} / ${plans}` },
          { label: '最近产出', value: metas[0] ? `${metas[0].date} ${metas[0].weekday}` : '—' },
        ],
      },
      { type: 'chart', title: '近 14 天产出', chartType: 'line', data: days },
      { type: 'chart', title: '类型分布', chartType: 'pie', data: [ { label: '晨报', value: reports }, { label: '学习规划', value: plans } ] },
      {
        type: 'table',
        title: '全部产出（点击行查看正文）',
        columns: [
          { key: 'date', label: '日期', width: 150 },
          { key: 'kind', label: '类型', width: 100 },
        ],
        rows: metas.map((x) => ({ date: x.date ? `${x.date} ${x.weekday}` : (x.name || '—'), kind: x.kind, path: x.path })),
        detail: { method: 'pageReportDetail', paramKey: 'path' },
      },
    ],
  }
}

/** 详情下钻入口（表格卡 detail.method）：按路径读晨报正文，返回 markdown 详情卡载荷 */
async function pageReportDetail(path) {
  const p = String(path || '')
  // 防御：仅本插件落盘目录内的 markdown 可作详情源
  if (!p.includes('小诺晨报') || !p.endsWith('.md')) throw new Error('路径不在晨报目录内')
  const content = await context.readFile(p)
  const meta = rowMeta(p)
  const title = meta.kind === '学习规划' ? `学习规划 · ${meta.date}` : `小诺晨报 · ${meta.date}`
  if (!content) return { title, markdown: '> 文件为空或未被知识库索引（知识库中心契约：未入库路径返回空串）。' }
  return { title, markdown: String(content) }
}

module.exports = {
  id: PLUGIN_ID,
  name: '晨报管家',
  version: '0.4.0',
  description: '晨报的手动生成与查看入口：托盘一键生成、编辑器面板生成/打开、侧边栏晨报页（历史一览）、Agent 工具；通知/面板打开统一走晨报页正文；晨报落盘系统仓库 sys-hub「小诺晨报/」',
  usage: '把小诺的晨报变成随手可得的能力：\n1. 托盘右键「今日晨报」——没有则即时生成，已有则直接打开（系统通知附落盘路径，点通知直达文档）。\n2. 「知识库」页右上角「晨报」按钮 → 面板里点「生成 / 打开晨报」——生成后自动在编辑器打开，可直接阅读。\n3. 侧边栏「能力包 → 晨报」页——产出统计、近 14 天趋势与历史一览（无需切到知识库文件树），点击行在本页查看正文，返回按钮回到列表。\n4. 对小诺说：「生成今天的晨报」「看看最近的晨报」。\n晨报存储在系统仓库 sys-hub 的「小诺晨报/」目录（新用户默认自带该仓库）。\n每日定时自动生成本插件的配置里开启（定时版含记忆要点等更全数据）；手动生成基于题库/薄弱点数据即时出稿。',

  async activate(ctx) {
    context = ctx

    // 每日定时生成并入本包（ADR-202 Phase 1，自中枢迁出）：ctx.timers 宿主托管，
    // 每小时对时检查 shouldGenerateNow（内部做时刻/当日/重试判定）；开关默认关闭
    let values = {}
    try { values = (await ctx.getConfig()) || {} } catch { /* 配置读取失败走声明缺省 */ }
    if (values.morning_report_enabled === true) {
      ctx.timers.setInterval('daily-check', () => {
        getEngine().checkAndGenerate().catch((e) => context.log(`定时晨报失败: ${(e && e.message) || e}`))
      }, 60 * 60 * 1000)
      context.log(`晨报定时生成已启用（每日 ${Number(values.morning_report_hour) || 8}:00 后生成，写入${values.report_repo_name ? `仓库「${values.report_repo_name}」` : 'sys-hub'}「小诺晨报/」）`)
    } else {
      context.log('晨报定时生成未启用（插件配置可开启；托盘/面板手动触发不受此限）')
    }

    // 晨报面板：日期留空=今天；submit 返回 filePath → 平台约定式自动打开
    ctx.registerPanel({
      id: 'report.form',
      label: '晨报',
      surface: 'dock',
      view: 'form',
      hint: '生成并打开小诺晨报（留存于系统仓库 sys-hub「小诺晨报/」）。当日已生成过则直接打开，不重复消耗 LLM。手动版不含「记忆要点」（需在插件配置开启「每日定时生成」）。',
      fields: [
        { key: 'date', label: '日期（留空=今天，格式 YYYY-MM-DD）', type: 'text', placeholder: '2026-09-15' },
      ],
      submitLabel: '生成 / 打开晨报',
      submit: 'openReport',
    })

    ctx.registerAgentTool(
      {
        name: 'generate_morning_report',
        description: '生成（或打开当日已有的）小诺晨报，返回晨报文件路径。用户说「生成晨报/出今日晨报/给我一份晨报」时使用。',
        parameters: {
          type: 'object',
          properties: {
            date: { type: 'string', description: '可选：日期 YYYY-MM-DD，缺省今天' },
          },
        },
      },
      async (args) => {
        const dateStr = normalizeDate(args && args.date)
        const { filePath, created } = await ensureReport(dateStr)
        return `晨报${created ? '已生成' : '已存在'}：${filePath}`
      },
    )

    ctx.registerAgentTool(
      {
        name: 'list_morning_reports',
        description: '列出已有的全部小诺晨报（标题与路径）。用户说「看看最近的晨报/历史晨报」时使用。',
        parameters: { type: 'object', properties: {} },
      },
      async () => listMorningReports(),
    )

    context.log('晨报管家已激活（托盘/晨报面板/Agent 工具三个入口就绪）')
  },

  async deactivate() {
    if (context) context.timers.clearInterval('daily-check')
    context = null
    engine = null
    engineDate = ''
  },

  /** 插件配置变更：定时器随开关/时刻即时重建 */
  async onConfigChange(namespace) {
    if (namespace !== 'config' || !context) return
    context.timers.clearInterval('daily-check')
    let values = {}
    try { values = (await context.getConfig()) || {} } catch { /* 配置读取失败走声明缺省 */ }
    if (values.morning_report_enabled === true) {
      context.timers.setInterval('daily-check', () => {
        getEngine().checkAndGenerate().catch((e) => context.log(`定时晨报失败: ${(e && e.message) || e}`))
      }, 60 * 60 * 1000)
      context.log('晨报定时生成已启用（配置变更即时生效）')
    }
  },

  // 托盘挂载点击入口（tray.menu method 声明）
  generateFromTray,
  // 面板提交入口（panel submit 声明）
  openReport,
  // nav.entry 页数据入口 + 详情下钻（plugin:invoke 直调）
  pageReports,
  pageReportDetail,
  // Agent 工具同名的直调入口（plugin:invoke 兼容）
  listMorningReports,
}
