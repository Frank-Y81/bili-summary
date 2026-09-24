// === 字幕分片 ===
// 只在“整段塞不下”时才切：上下文够就不切 —— 模型要通读全文才判断得出哪句是重点，
// 切完再合并永远补不回那个全局视野，所以这是降级路径，不是常规路径。
//
// 切点怎么选（越靠前越优先）：
//   1. 时间空档：字幕两行之间的静默通常就是换话题/换段落，捏着时间轴切最不容易切在半句上
//   2. 标点收尾：没有空档时，退到以 。！？ 结尾的那一行之后
//   3. 硬切：都不行就按字数切（总比整段发不出去强）
// 片与片之间重叠 OVERLAP_LINES 行：防止一个关键结论正好落在切点两侧、各说一半。

// 字幕超过这个字数才分片（拍定：10000 字）
export const SEGMENT_THRESHOLD = 10000
// 片数上限：再往上延迟和失败率都会爆 —— 宁可让单片更大，也不切出几十片
const MAX_PARTS = 8
// 认定“这里有话题切换”的静默时长（秒）
const GAP_SECONDS = 1.5
// 片间重叠行数
const OVERLAP_LINES = 2
// 一句话的收尾标点（后面可能跟着引号/括号）
const PUNCT_END = /[。！？!?…]["”』）)]*$/

export interface SubtitlePart {
  text: string
  /** 时间范围，例如 "12:34–18:40"；没有时间轴时是空串 */
  range: string
}

// marks = 每一行的起始秒数（与 text 的行一一对应）。
// 对不上就当没有时间轴（旧缓存、或抓取时没带 from）：退化成只用标点找切点。
export function splitSubtitle(
  text: string,
  marks: number[] | undefined,
  threshold = SEGMENT_THRESHOLD
): SubtitlePart[] {
  const lines = text.split('\n')
  const times = marks && marks.length === lines.length ? marks : undefined

  if (text.length <= threshold) return [makePart(lines, times, 0, lines.length - 1)]

  // 片数上限靠“放大单片字数”来兜住，而不是切出更多片
  let limit = Math.max(threshold, Math.ceil(text.length / MAX_PARTS))
  let parts = splitOnce(lines, times, limit)
  // 片间重叠会让实际片数比估算的略多（每片都多带 OVERLAP_LINES 行）：超了就放大单片重切
  for (let i = 0; parts.length > MAX_PARTS && i < 3; i++) {
    limit = Math.ceil(limit * 1.2)
    parts = splitOnce(lines, times, limit)
  }
  return parts
}

function splitOnce(lines: string[], times: number[] | undefined, limit: number): SubtitlePart[] {
  const parts: SubtitlePart[] = []
  let start = 0
  while (start < lines.length) {
    // end 是开区间：这一片的最后一行是 end - 1
    let end = start
    let size = 0
    while (end < lines.length && size < limit) {
      size += lines[end].length + 1
      end++
    }

    const isLast = end >= lines.length
    const cut = isLast ? end : findCut(lines, times, start, end)
    parts.push(makePart(lines, times, start, cut - 1))
    if (isLast) break

    // 下一片带上重叠行，但必须前进（否则死循环）
    start = Math.max(cut - OVERLAP_LINES, start + 1)
  }
  return parts
}

// 在 (start, end) 这个开区间里往回找一个切点；找不到就硬切在 end
function findCut(lines: string[], times: number[] | undefined, start: number, end: number): number {
  // 只回看这一片最后 25%（至少 3 行）：切点离片尾太远，前一片会明显变短、片数变多
  const floor = Math.max(start + 1, end - Math.max(3, Math.floor((end - start) * 0.25)))
  let punct = -1
  for (let i = end - 1; i > floor; i--) {
    // 时间空档：最优先
    if (times && times[i] - times[i - 1] >= GAP_SECONDS) return i
    // 次选：上一行是完整句子，切在它后面
    if (punct < 0 && PUNCT_END.test(lines[i - 1].trim())) punct = i
  }
  return punct >= 0 ? punct : end
}

function makePart(lines: string[], times: number[] | undefined, from: number, to: number): SubtitlePart {
  return {
    text: lines.slice(from, to + 1).join('\n'),
    range: times ? `${formatClock(times[from])}–${formatClock(times[to])}` : ''
  }
}

// 秒 → 12:34 / 1:02:03
function formatClock(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}