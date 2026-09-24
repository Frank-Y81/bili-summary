// 消息类型常量 —— content / background / SidePanel 共用
// 防止手写字符串拼错（历史教训：genrateSummary）

export const MSG_GET_SUBTITLE_INFO = 'getSubtitleInfo'
export const MSG_DELETE_RECORD = 'deleteRecord'

// 生成走长连接：sendResponse 只能回一次，推不了流
// 面板 → 后台：FRAME_GENERATE；后台 → 面板：FRAME_DELTA 若干条，最后恰好一条 FRAME_DONE / FRAME_ERROR
export const PORT_SUMMARY_STREAM = 'summaryStream'
export const FRAME_GENERATE = 'generate'
// 面板 → 后台：中断在途请求（后台据此 abort 掉 fetch，不再烧 token、不落盘）
export const FRAME_CANCEL = 'cancel'
// 后台 → 面板：进度（分片汇总时“正在总结第 2/5 段”这类；正文还没开始流时才用）
export const FRAME_PROGRESS = 'progress'
export const FRAME_DELTA = 'delta'
export const FRAME_DONE = 'done'
export const FRAME_ERROR = 'error'
