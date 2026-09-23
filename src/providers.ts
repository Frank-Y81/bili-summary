import { COMMON_CONSTRAINTS, SYSTEM_ROLE } from "./prompts";
import type { GenerateInput, ProviderCard, ProviderConfig } from "./types";

const DRY_RUN = false

function createProvider(cfg: ProviderConfig): ProviderCard {
  return {
    id: cfg.id,
    name: cfg.name,
    baseUrl: cfg.baseUrl,
    models: cfg.models,
    async generate(input: GenerateInput): Promise<string> {
    if(!cfg.key) return `「${cfg.name}」还没填 API Key（设置 → 厂商管理 → 编辑）`
    const key = cfg.key

    // 拼接：system = 系统角色 + 通用约束
    const system = [SYSTEM_ROLE, COMMON_CONSTRAINTS].filter(Boolean).join('\n')

    let res: Response
    try {
      res = await postChat(chatCompletionsUrl(cfg.baseUrl), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + key
        },
        body: JSON.stringify({
          model: input.model ?? cfg.models[0],
          max_tokens: 8192,
          stream: true,
          messages: [
            {role: 'system', content: system},
            {role: 'user', content: `视频标题：${input.title}\n视频简介：${input.desc}\n字幕内容：${input.subtitle}`},
            {role: 'user', content: input.prompt}
          ]
        })
      })
    } catch (err) {
      // fetch 直接抛（不是 HTTP 错误）：多半是域名没授权或地址写错，笼统说“生成失败”等于没说
      console.error('请求发不出去：', err)
      return `请求发不出去：「${cfg.name}」的域名可能还没授权（设置 → 厂商管理 → 授权访问），或接口地址填错了`
    }

    // API 异常时返回明确错误，而不是兜底文案
    if(!res.ok) {
      const errText = await res.text().catch(() => '')
      console.error('请求失败：', res.status, errText.slice(0, 200))
      // 把服务端的说法带一句回面板，省得每次都去翻后台控制台
      const detail = errText.replace(/\s+/g, ' ').trim().slice(0, 160)
      return `生成总结失败（HTTP ${res.status}${detail ? '：' + detail : ''}）`
    }

    if(!res.body) return '生成总结失败（响应没有可读的流）'

    // 服务端可能无视 stream:true 直接回一坨 JSON——那下面会解析出 0 帧，日志里能看出来
    console.log('[summary] 响应', res.status, res.headers.get('content-type'))

    // 边收边吐，最后把拼完的整段返回（调用方拿到的仍是一个字符串，契约没变形状）
    const text = await readSseStream(res.body, input.onDelta)
    if(!text) return '生成总结失败（流里没有内容帧，控制台有响应类型日志）'
    return text
    }
  }
}

// 读 SSE 流：只认 data: 行。帧的边界与读取的块边界无关，所以按行缓冲，最后一段不完整的留到下一轮
async function readSseStream(
  stream: ReadableStream<Uint8Array>,
  onDelta?: (text: string) => void
): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let full = ''
  let frames = 0
  let startedAt = 0

  console.log('[summary] 开始收流')

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      const payload = line.trim()
      if (!payload.startsWith('data:')) continue

      const data = payload.slice(5).trim()
      if (!data || data === '[DONE]') continue

      let delta = ''
      try {
        delta = JSON.parse(data).choices?.[0]?.delta?.content ?? ''
      } catch {
        // 单个坏帧不该让整段作废：跳过它，继续收
        continue
      }

      if (!delta) continue
      if (!frames) {
        startedAt = Date.now()
        console.log('[summary] 首帧到达')
      }
      frames++
      full += delta
      onDelta?.(delta)
    }
  }

  console.log(`[summary] 收流结束：${frames} 帧，${full.length} 字，耗时 ${startedAt ? Date.now() - startedAt : 0}ms`)
  return full
}

async function postChat(url: string, init: RequestInit): Promise<Response> {
  if(!DRY_RUN) return fetch(url, init)
  
  const body = JSON.parse(init.body as string)
  const sizes = body.messages.map((m: any) => `${m.role}:${String(m.content).length}字`).join(' ')
  const log = `【dry-run】\n\n发到：${url}\n\n模型：${body.model}\n\n消息：${sizes}`

  // 假响应也造出 SSE 形状：替身走的是与真调用同一条解析链
  // 逐块吐（模拟真实到达节奏），面板上的逐字渲染不花一分钱就能验
  const encoder = new TextEncoder()
  let cursor = 0
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (cursor >= log.length) {
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
        return
      }
      await new Promise(resolve => setTimeout(resolve, 40))
      const piece = log.slice(cursor, cursor + 12)
      cursor += 12
      controller.enqueue(encoder.encode(
        `data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`
      ))
    }
  })

  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' }
  })
}

// ── 厂商：数据（ProviderConfig，可被用户改，存 storage）与卡片（ProviderCard，带 generate）分开 ──
// 手填参考（2026-09 官方页取证，不预置到界面里）：
//   百炼  https://dashscope.aliyuncs.com/compatible-mode/v1
//         千问 qwen3.7-plus / qwen3.8-flash / qwen3.8-max；三方 deepseek-v4-flash、
//         deepseek-v4.1-flash、ZHIPU/GLM-5.3-Flash、ZHIPU/GLM-5.3-FlashX
//         已实测可调通：deepseek-v4-flash、ZHIPU/GLM-5.3-Flash
//   DeepSeek 官方 https://api.deepseek.com        deepseek-v4-flash
//   智谱官方   https://open.bigmodel.cn/api/paas/v4

import { STORAGE_KEYS } from "./storage-keys";

// 配置 → 卡片（纯函数，不碰 storage）
export function buildProviders(configs: ProviderConfig[]): ProviderCard[] {
  return configs.map(c => createProvider(c))
}

// 从接口地址推导要申请的权限模式：https://a.com/v1 → https://a.com/*（带端口也带上）
export function originPatternOf(baseUrl: string): string | null {
  try {
    const u = new URL(baseUrl)
    return `${u.protocol}//${u.host}/*`
  } catch {
    return null
  }
}

// 用户很容易把 /chat/completions 一起填进 baseUrl（工厂还会再接一次）:
// 写成 .../v4/chat/completions 就会真的打到 .../v4/chat/completions/chat/completions —— 404
export function normalizeBaseUrl(raw: string): string {
  return raw.trim()
    .replace(/\/+$/, '')
    .replace(/\/chat\/completions$/i, '')
    .replace(/\/+$/, '')
}

// 真正发出去的地址（请求时机也归一化一次，存过的旧配置不用重新保存就能生效）
export function chatCompletionsUrl(baseUrl: string): string {
  return normalizeBaseUrl(baseUrl) + '/chat/completions'
}

// 读原始配置（带 key）：编辑界面要用，卡片里没有 key
// 不预置任何厂商：没配过就是空数组，让人自己去界面里加
export async function loadProviderConfigs(): Promise<ProviderConfig[]> {
  const { providerConfigs } = await chrome.storage.local.get(STORAGE_KEYS.providerConfigs)
  return (providerConfigs ?? []) as ProviderConfig[]
}

// 写回：存普通对象数组，避开响应式代理的序列化问题（同 saveModes 的教训）
export async function saveProviderConfigs(configs: ProviderConfig[]): Promise<void> {
  await chrome.storage.local.set({
    [STORAGE_KEYS.providerConfigs]: configs.map(c => ({ ...c, models: [...c.models] }))
  })
}

// 读厂商清单：两个上下文（background / 面板）共用这一个函数，避免各自兜底变成两份真值
export async function loadProviders(): Promise<ProviderCard[]> {
  return buildProviders(await loadProviderConfigs())
}
