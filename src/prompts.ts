// === prompt 模式系统 ===
// 目标：通用约束（内置不可改）+ 用户自定义模式（命名 + 自写指令）
// 第 1 步：只定义数据结构和内置常量，不影响现有功能

// 用户模式
export interface PromptMode {
  id: string
  name: string
  prompt: string
  createdAt: number
}

// 模式上限（含默认模式）
export const MAX_MODES = 6

// 内置默认模式的固定 id
export const DEFAULT_MODE_ID = 'default-general'

// 创建内置默认模式（不可删除）
export function createDefaultMode(): PromptMode {
  return {
    id: DEFAULT_MODE_ID,
    name: '通用笔记',
    prompt: '请返回您反复阅读正文后精心写成的详尽笔记，字数上限约为6500',
    createdAt: 0
  }
}

// === 内置通用片段（用户不可见、不可改）===

// 系统角色设定
export const SYSTEM_ROLE =
  '你是一个专业的视频内容总结助手，擅长从视频字幕中提炼核心观点。'

// 通用约束：无论什么模式都必须遵守
export const COMMON_CONSTRAINTS =
  `先整体理解视频，再根据当前模式进行处理。
关注视频的主题、主线、内容之间的关系，以及作者/创作者的表达与意图，而不是机械复述字幕。
可以基于视频内容进行合理的归纳、解释和解读，但不要把自己的推测或补充说成视频中的内容。
对于输入中没有提供或无法确定的信息，不要自行补全或假装知道。`
