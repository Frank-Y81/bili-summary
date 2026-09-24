// 定义总结存储的接口类型
export interface SummaryRecord {
  videoId: number
  videoTitle: string
  summary: string
  provider: string
  model: string
  // promptModeId = “mode-${Date.now()}”，string类型，避免模式名称变化后无法找到对应的promptMode
  promptModeId: string
  createdAt: number
}

export interface Provider {
  id: string
  generate(input: GenerateInput): Promise<string>
}

export interface GenerateInput {
  title: string
  desc: string
  // 给模型看的材料：整段字幕 / 某一分片 / 各片要点（分片汇总时）—— 所以不叫 subtitle
  source: string
  // 它在提示里的称呼，例如「字幕内容」「本段字幕（第 2/5 段）」「各段要点」
  sourceLabel: string
  prompt: string
  // 可不传：不传就用该厂商的第一个模型（providers.ts 里本来就是这么兑底的）
  model?: string
  // 输出被 max_tokens 截断时是否在正文末尾附一行“并不完整”的提示
  // 分片第一轮的产物是中间要点，附上去只会污染第二轮的输入 —— 那边传 false
  appendTruncationNote?: boolean
  // 流式：厂商每收到一帧就调一次；不传 = 只要最终整段（历史记录、缓存拿到的都是整段）
  onDelta?: (text: string) => void
  // 中断：面板点“停止/重新生成”时后台 abort，请求真的断掉（拒收后不再产生费用与落盘）
  signal?: AbortSignal
}

export type ProviderSetting = Record<string, { model: string }>

export interface ProviderCard {
  id: string,
  name: string,
  baseUrl: string,
  models: string[],
  generate(input: GenerateInput): Promise<string>
}

// 厂商配置：用户可改的数据形状，存 storage；卡片（带 generate）由它运行时编译出来
export interface ProviderConfig {
  id: string
  name: string
  baseUrl: string
  models: string[]
  key: string
} 