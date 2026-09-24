import { createDefaultMode, MAP_INSTRUCTION, REDUCE_INSTRUCTION, type PromptMode } from './prompts'
import { MSG_GET_SUBTITLE_INFO, MSG_DELETE_RECORD, PORT_SUMMARY_STREAM, FRAME_GENERATE, FRAME_CANCEL, FRAME_DELTA, FRAME_DONE, FRAME_ERROR, FRAME_PROGRESS } from './messages'
import { loadProviders } from "./providers";
import { splitSubtitle } from './subtitle-split';
import { STORAGE_KEYS } from './storage-keys';
import type { ProviderCard, ProviderSetting, SummaryRecord } from './types';

// 快捷键呼出
// tab呢，为什么要有个tab.id给open？让它在当前页打开side panel？
chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'toggle-side-panel') {
    if(tab?.id) chrome.sidePanel.open({tabId: tab.id})
  }
})

// 日志
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // 字幕获取&存储 以及cid的获取和存储
  if(message.type === MSG_GET_SUBTITLE_INFO) {
    handleSubtitleInfo(message)
  }

  // 删除一条历史记录
  if(message.type === MSG_DELETE_RECORD) {
    deleteRecord(message.createdAt).then(sendResponse).catch(err => {
      console.error('删除历史记录失败：', err)
      sendResponse({ ok: false })
    })
    return true
  }
})

// 生成走长连接：sendResponse 只能回一次，推不了流
chrome.runtime.onConnect.addListener(port => {
  if(port.name !== PORT_SUMMARY_STREAM) return

  // 这条连接上在途的请求：面板点“停止/重新生成”时用它把 fetch 真断掉
  let controller: AbortController | null = null

  port.onMessage.addListener(message => {
    // 中断：abort 后整个生成会以 AbortError 收场，既不落盘也不进历史
    if(message.type === FRAME_CANCEL) {
      controller?.abort()
      return
    }
    if(message.type !== FRAME_GENERATE) return
    // 同一条连接重复要生成：忽略（面板的“重新生成”是断旧连、开新连）
    if(controller) return

    const ac = new AbortController()
    controller = ac

    // MV3 的 service worker 空闲约 30 秒会被回收（长请求是已知雷区）：生成期间定期戳一次扩展 API 续命
    const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000)

    generateSummary(text => {
      // 面板中途关了的话端口已断，postMessage 会抛——不能让它影响后台继续生成、落盘
      try { port.postMessage({ type: FRAME_DELTA, text }) } catch { /* 面板已关闭 */ }
    }, ac.signal, text => {
      // 进度（分片汇总时的“第 2/5 段”）：面板只在正文还没开始流的时候显示它
      try { port.postMessage({ type: FRAME_PROGRESS, text }) } catch { /* 面板已关闭 */ }
    })
      .then(summary => {
        // 刚好在收尾前被中断：不算完成，也别再往已废弃的连接上推
        if(ac.signal.aborted) return
        // 面板中途关了同样会抛（与上面的 delta 帧同理）：结果已经落盘，静默即可
        try { port.postMessage({ type: FRAME_DONE, summary }) } catch { /* 面板已关闭 */ }
      })
      .catch(err => {
        // 用户主动中断不是错误：面板那边早就不听了，静默收场
        if(isAbortError(err)) {
          console.log('[summary] 已按用户要求中断')
          return
        }
        console.error('generateSummary的promise失败：', err)
        try {
          // 不落盘的那条通道：文案本身已是完整的句子（提前 return 会被当成总结存进历史）
          port.postMessage({
            type: FRAME_ERROR,
            message: err instanceof Error ? err.message : String(err)
          })
        } catch { /* 面板已关闭 */ }
      })
      .finally(() => {
        clearInterval(keepAlive)
        if(controller === ac) controller = null
      })
  })
})

function isAbortError(err: unknown): boolean {
  return (err as { name?: string } | null)?.name === 'AbortError'
}

// 删除历史记录：只认 createdAt（与历史列表渲染、选中态用的是同一个键）
async function deleteRecord(createdAt: number) {
  const { summaryRecords } = await chrome.storage.local.get(STORAGE_KEYS.summaryRecords)
  const list = (summaryRecords ?? []) as SummaryRecord[]
  await chrome.storage.local.set({
    [STORAGE_KEYS.summaryRecords]: list.filter(r => r.createdAt !== createdAt)
  })
  return { ok: true }
}

// 字幕处理单独使用 async 函数，避免阻塞消息监听器
async function handleSubtitleInfo(message: any) {
  const cid = message.data?.data?.cid

  // 只处理视频信息响应（字幕文件响应没有 subtitle 字段）
  if(!message.data?.data?.subtitle) return
  if(!cid) return

  // 检测视频切换：新 cid 到来时清理旧数据
  const oldData = await chrome.storage.local.get(STORAGE_KEYS.videoId)
  const videoChanged = oldData.videoId !== cid
  await chrome.storage.local.set({
    [STORAGE_KEYS.videoId]: cid,
    ...(videoChanged ? {
      [STORAGE_KEYS.videoSubtitle]: '',
      [STORAGE_KEYS.videoSubtitleMarks]: [],
      [STORAGE_KEYS.subtitleStatus]: 'loading',
      [STORAGE_KEYS.videoSummary]: '',
      [STORAGE_KEYS.videoSummaryId]: ''
    } : {})
  })

  const list = message.data?.data?.subtitle?.subtitles ?? []
  if(list.length > 0) {
    const fullUrl = 'https:' + list[0].subtitle_url
    try {
      const response = await fetch(fullUrl)
      const sub = await response.json()
      // 字幕文件是异步返回的，保存前校验仍属于当前视频
      const { videoId } = await chrome.storage.local.get(STORAGE_KEYS.videoId)
      if(videoId !== cid) return

      const body = (sub.body ?? []) as { from?: number; content?: string }[]
      const text = body.map((l: any) => l.content ?? '').join('\n')
      // 时间轴单独存一份：拼进正文会白烧 token（B 站字幕一行就几个字，加 [12:34] 前缀能把输入翻倍），
      // 而它的唯一用途是分片时判断哪里是话题切换
      const marks = body.map((l: any) => Math.round(Number(l.from ?? 0)))
      await chrome.storage.local.set({
        [STORAGE_KEYS.videoSubtitle]: text,
        [STORAGE_KEYS.videoSubtitleMarks]: marks,
        [STORAGE_KEYS.subtitleStatus]: 'ready'
      })
    } catch (err) {
      console.error('字幕抓取失败：', err)
    }
  } else {
    const { videoId } = await chrome.storage.local.get(STORAGE_KEYS.videoId)
    if(videoId !== cid) return
    await chrome.storage.local.set({
      [STORAGE_KEYS.subtitleStatus]: 'no-subtitle',
      [STORAGE_KEYS.videoSubtitle]: '',
      [STORAGE_KEYS.videoSubtitleMarks]: []
    })
  }
}

async function generateSummary(
  onDelta?: (text: string) => void,
  signal?: AbortSignal,
  onProgress?: (text: string) => void
) {
  const { videoTitle, videoSubtitle, videoDesc, videoId, videoTitleId, videoSubtitleMarks } = 
    await chrome.storage.local.get([
      STORAGE_KEYS.videoTitle, STORAGE_KEYS.videoSubtitle, STORAGE_KEYS.videoDesc,
      STORAGE_KEYS.videoId, STORAGE_KEYS.videoTitleId, STORAGE_KEYS.videoSubtitleMarks
    ])
  if (!videoSubtitle) throw new Error('未抓获字幕，无法总结')
  if (videoTitleId !== videoId) throw new Error('视频信息尚未就绪，请稍候重试')
  
  // 找到当前模式：数据异常或不存在时兜底到默认模式
  const { promptModes, activeModeId } = await chrome.storage.local.get([STORAGE_KEYS.promptModes, STORAGE_KEYS.activeModeId])
  const modes = Array.isArray(promptModes) ? (promptModes as PromptMode[]) : [createDefaultMode()]
  const mode = modes.find(m => m.id === activeModeId) ?? modes[0] ?? createDefaultMode()

  const {activeProviderId} = await chrome.storage.local.get(STORAGE_KEYS.activeProviderId)

  const allProviders = await loadProviders()
  const provider = allProviders.find(p => p.id === activeProviderId)

  if(!provider) throw new Error(allProviders.length
    ? '所选厂商不可用'
    : '还没配置任何厂商（设置 → 厂商管理 → 新增厂商）')
  const { providerSetting } = await chrome.storage.local.get<{ providerSetting: ProviderSetting}>(STORAGE_KEYS.providerSetting)

  const summary = await generateWithSegments({
    title: videoTitle as string,
    desc: videoDesc as string,
    subtitle: videoSubtitle as string,
    marks: videoSubtitleMarks as number[] | undefined,
    mode,
    model: providerSetting?.[activeProviderId as string]?.model,
    provider,
    onDelta,
    onProgress,
    signal
  })

  // 中断：请求断了就到此为止，不许把半截结果写进缓存和历史
  throwIfAborted(signal)

  const {videoId: latestId} = await chrome.storage.local.get(STORAGE_KEYS.videoId)
  if(videoId !== latestId) {
    throw new Error('视频变化了，拒绝存入旧视频数据')
  }

  const newRecord: SummaryRecord = {
    videoId: videoId as number,
    videoTitle: videoTitle as string,
    summary: summary,
    provider: activeProviderId as string,
    model: providerSetting?.[activeProviderId as string]?.model ?? provider.models[0],
    promptModeId: mode.id,
    createdAt: Date.now()
  }

  const { summaryRecords } = await chrome.storage.local.get(STORAGE_KEYS.summaryRecords)
  const list = (summaryRecords ?? []) as SummaryRecord[]

  list.unshift(newRecord)

  if(list.length > 20) list.pop()

  await chrome.storage.local.set({ [STORAGE_KEYS.summaryRecords]: list })

  // 缓存机制：保存总结文本 & 总结对应的视频id & 生成时用的模式id
  await chrome.storage.local.set({
    [STORAGE_KEYS.videoSummary]: summary,
    [STORAGE_KEYS.videoSummaryId]: videoId,
    [STORAGE_KEYS.videoSummaryModeId]: mode.id
  })
  return summary
}

// 中断检查：分片流程每一个阶段之间都要看一眼，别让用户点了“停止”之后还把后面的段接着烧
function throwIfAborted(signal?: AbortSignal) {
  if(signal?.aborted) throw new DOMException('Aborted', 'AbortError')
}

interface SegmentInput {
  title: string
  desc: string
  subtitle: string
  marks?: number[]
  mode: PromptMode
  model?: string
  provider: ProviderCard
  onDelta?: (text: string) => void
  onProgress?: (text: string) => void
  signal?: AbortSignal
}

// 一条请求还是分片两轮，就在这里分叉
// 没超阈值（只有一片）= 跟以前完全一样：一条请求、一次流式，质量最好
// 超了才降级成两轮：先分片抽要点（不流式），再把要点合并成最终总结（这一步才流给面板）
async function generateWithSegments(input: SegmentInput): Promise<string> {
  const parts = splitSubtitle(input.subtitle, input.marks)
  const common = { title: input.title, desc: input.desc, model: input.model, signal: input.signal }

  if (parts.length <= 1) {
    return input.provider.generate({
      ...common,
      source: input.subtitle,
      sourceLabel: '字幕内容',
      prompt: input.mode.prompt,
      onDelta: input.onDelta
    })
  }

  console.log(`[summary] 字幕 ${input.subtitle.length} 字，分 ${parts.length} 片汇总`)

  // 第一轮（map）：每片压成要点。不传 onDelta —— 中间产物流给用户，只会让人以为总结就长这样
  const notes: string[] = []
  for (const [i, part] of parts.entries()) {
    throwIfAborted(input.signal)
    const label = `第 ${i + 1}/${parts.length} 段${part.range ? `（${part.range}）` : ''}`
    input.onProgress?.(`正在分段处理：${label}`)
    const note = await input.provider.generate({
      ...common,
      source: part.text,
      sourceLabel: `本段字幕（${label}）`,
      prompt: `${MAP_INSTRUCTION}\n${input.mode.prompt}`,
      appendTruncationNote: false
    })
    notes.push(`## ${label}\n${note}`)
  }

  // 第二轮（reduce）：合并要点 → 最终总结
  throwIfAborted(input.signal)
  input.onProgress?.(`正在合并 ${parts.length} 段要点…`)
  return input.provider.generate({
    ...common,
    source: notes.join('\n\n'),
    sourceLabel: '各段要点',
    prompt: `${REDUCE_INSTRUCTION}\n${input.mode.prompt}`,
    onDelta: input.onDelta
  })
}
