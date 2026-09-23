// storage 键名的唯一出处
// 为什么要有这个文件：键名写错 = 读到 undefined = 静默降级（这项目已经踩过：
// 写 'videoSumary' 读 'videoSummary'，被 ?? 兜掉，不报错、也不生效）
export const STORAGE_KEYS = {
  // 当前视频（content 写标题/简介/UP主，background 写 cid 与字幕）
  videoId: 'videoId',
  videoTitle: 'videoTitle',
  videoDesc: 'videoDesc',
  videoOwner: 'videoOwner',
  videoTitleId: 'videoTitleId',
  videoSubtitle: 'videoSubtitle',
  subtitleStatus: 'subtitleStatus',
  // 总结缓存（background 写）
  videoSummary: 'videoSummary',
  videoSummaryId: 'videoSummaryId',
  videoSummaryModeId: 'videoSummaryModeId',
  summaryRecords: 'summaryRecords',
  // 设置（面板写）
  promptModes: 'promptModes',
  activeModeId: 'activeModeId',
  providerSetting: 'providerSetting',
  activeProviderId: 'activeProviderId',
  providerConfigs: 'providerConfigs',
  theme: 'theme',
  fontSize: 'fontSize',
  autoSummarize: 'autoSummarize'
} as const