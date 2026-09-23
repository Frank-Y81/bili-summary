import { createDefaultMode, type PromptMode } from './prompts'
import { MSG_GET_SUBTITLE_INFO, MSG_DELETE_RECORD, PORT_SUMMARY_STREAM, FRAME_GENERATE, FRAME_DELTA, FRAME_DONE, FRAME_ERROR } from './messages'
import { loadProviders } from "./providers";
import { STORAGE_KEYS } from './storage-keys';
import type { ProviderSetting, SummaryRecord } from './types';

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

  port.onMessage.addListener(message => {
    if(message.type !== FRAME_GENERATE) return

    // MV3 的 service worker 空闲约 30 秒会被回收（长请求是已知雷区）：生成期间定期戳一次扩展 API 续命
    const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000)

    generateSummary(text => {
      // 面板中途关了的话端口已断，postMessage 会抛——不能让它影响后台继续生成、落盘
      try { port.postMessage({ type: FRAME_DELTA, text }) } catch { /* 面板已关闭 */ }
    })
      .then(summary => port.postMessage({ type: FRAME_DONE, summary }))
      .catch(err => {
        console.error('generateSummary的promise失败：', err)
        try {
          port.postMessage({
            type: FRAME_ERROR,
            message: `生成失败：${err instanceof Error ? err.message : String(err)}`
          })
        } catch { /* 面板已关闭 */ }
      })
      .finally(() => clearInterval(keepAlive))
  })
})

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

      const text = (sub.body ?? []).map((l: any) => l.content).join('\n')
      await chrome.storage.local.set({
        [STORAGE_KEYS.videoSubtitle]: text,
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
      [STORAGE_KEYS.videoSubtitle]: ''
    })
  }
}

async function generateSummary(onDelta?: (text: string) => void) {
  const { videoTitle, videoSubtitle, videoDesc, videoId, videoTitleId } = 
    await chrome.storage.local.get([
      STORAGE_KEYS.videoTitle, STORAGE_KEYS.videoSubtitle, STORAGE_KEYS.videoDesc,
      STORAGE_KEYS.videoId, STORAGE_KEYS.videoTitleId
    ])
  if (!videoSubtitle) return '未抓获字幕，无法总结'
  if (videoTitleId !== videoId) return '视频信息尚未就绪，请稍候重试'
  
  // 找到当前模式：数据异常或不存在时兜底到默认模式
  const { promptModes, activeModeId } = await chrome.storage.local.get([STORAGE_KEYS.promptModes, STORAGE_KEYS.activeModeId])
  const modes = Array.isArray(promptModes) ? (promptModes as PromptMode[]) : [createDefaultMode()]
  const mode = modes.find(m => m.id === activeModeId) ?? modes[0] ?? createDefaultMode()

  const {activeProviderId} = await chrome.storage.local.get(STORAGE_KEYS.activeProviderId)

  const allProviders = await loadProviders()
  const provider = allProviders.find(p => p.id === activeProviderId)

  if(!provider) return allProviders.length
    ? '所选厂商不可用'
    : '还没配置任何厂商（设置 → 厂商管理 → 新增厂商）'
  const { providerSetting } = await chrome.storage.local.get<{ providerSetting: ProviderSetting}>(STORAGE_KEYS.providerSetting)

  const summary = await provider.generate({
    title: videoTitle as string,
    desc: videoDesc as string,
    subtitle: videoSubtitle as string,
    prompt: mode.prompt,
    model:providerSetting?.[activeProviderId as string]?.model,
    onDelta
  })

  const {videoId: latestId} = await chrome.storage.local.get(STORAGE_KEYS.videoId)
  if(videoId !== latestId) {
    return '视频变化了，拒绝存入旧视频数据'
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
