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
    // 下面所有失败都 throw（而不是 return 文案）：后台的失败通道不落盘，
    // 而 return 出去的字符串会被当成“总结”写进历史和缓存（历史里到处是“生成总结失败”）
    if(!cfg.key) throw new Error(`「${cfg.name}」还没填 API Key（设置 → 厂商管理 → 编辑）`)
    const key = cfg.key

    // 拼接：system = 系统角色 + 通用约束
    const system = [SYSTEM_ROLE, COMMON_CONSTRAINTS].filter(Boolean).join('\n')

    let res: Response
    try {
      res = await postChat(chatCompletionsUrl(cfg.baseUrl), {
        method: 'POST',
        signal: input.signal,
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
            {role: 'user', content: `视频标题：${input.title}\n视频简介：${input.desc}\n${input.sourceLabel}：${input.source}`},
            {role: 'user', content: input.prompt}
          ]
        })
      })
    } catch (err) {
      // 用户主动中断：这不是“发不出去”，必须原样抛出去，后台据此静默收场（也别再落盘）
      if(isAbortError(err)) throw err
      // fetch 直接抛（不是 HTTP 错误）：多半是域名没授权或地址写错，笼统说“生成失败”等于没说
      console.error('请求发不出去：', err)
      throw new Error(`请求发不出去：「${cfg.name}」的域名可能还没授权（设置 → 厂商管理 → 授权访问），或接口地址填错了`)
    }

    // API 异常时抛出明确错误，而不是兜底文案
    if(!res.ok) {
      const errText = await res.text().catch(() => '')
      console.error('请求失败：', res.status, errText.slice(0, 200))
      // 把服务端的说法带一句回面板，省得每次都去翻后台控制台
      const detail = errText.replace(/\s+/g, ' ').trim().slice(0, 160)

      // 超长是最常见、也最看不懂的一类失败：直接说清“多少字、哪个模型、怎么办”，
      // 而不是把服务端那句 context_length_exceeded 原样甩出去
      if(isTooLongError(res.status, errText)) {
        throw new Error(`${input.sourceLabel}太长：${input.source.length} 字，超出了「${input.model ?? cfg.models[0]}」的上下文上限。`
          + `换个窗口更大的模型，或换一个短一点的视频。（服务端原文：${detail || res.status}）`)
      }

      throw new Error(`生成总结失败（HTTP ${res.status}${detail ? '：' + detail : ''}）`)
    }

    if(!res.body) throw new Error('生成总结失败（响应没有可读的流）')

    // 服务端可能无视 stream:true 直接回一坨 JSON——那下面会解析出 0 帧，日志里能看出来
    console.log('[summary] 响应', res.status, res.headers.get('content-type'))

    // 边收边吐，最后把拼完的整段返回（调用方拿到的仍是一个字符串，契约没变形状）
    const { text, finishReason } = await readSseStream(res.body, input.onDelta)
    if(!text) throw new Error('生成总结失败（流里没有内容帧，控制台有响应类型日志）')

    // 输出被 max_tokens 顶满：HTTP 200，但正文是被硬截断的（finish_reason=length）
    // 这种半截总结以前会被当成完整的存下来，用户根本看不出来 —— 留着它，但必须在正文里说明
    if(finishReason === 'length') {
      // 中间产物（分片第一轮的要点）不能附：它不是给用户看的总结，附上去会污染第二轮输入
      if(input.appendTruncationNote === false) {
        console.warn('[summary] 输出被 max_tokens 截断（中间产物，不附提示）')
        return text
      }
      return text + '\n\n> ⚠️ 这份总结被模型的输出上限（max_tokens 8192）截断了，并不完整：'
        + '可以让模式指令要求写得短一些，或换输出上限更大的模型。'
    }

    return text
    }
  }
}

// abort 抛出来的错：DOMException（浏览器）/ Error name 为 AbortError（部分环境）
function isAbortError(err: unknown): boolean {
  return (err as { name?: string } | null)?.name === 'AbortError'
}

// “输入太长”这一类：各家措辞差很多，但绕不过这几个关键词（小写后比）
// 刻意不写宽泛的 “exceeds”“too large”，那会误伤限流、配额之类的 400
const TOO_LONG_PATTERNS = [
  'context length', 'context_length', 'context window', 'maximum context', 'max context',
  'too long', 'too many tokens', 'token limit', 'length limit', 'reduce the length',
  'input is too large', 'request entity too large', '上下文'
]

function isTooLongError(status: number, body: string): boolean {
  if(status === 413) return true   // Payload Too Large：不用再猜
  if(status !== 400 && status !== 422) return false
  const text = body.toLowerCase()
  return TOO_LONG_PATTERNS.some(p => text.includes(p))
}

// 读 SSE 流：只认 data: 行。帧的边界与读取的块边界无关，所以按行缓冲，最后一段不完整的留到下一轮
// 返回值：整段文本 + 帧数（连接测试判“有没有真按流式回”）+ finish_reason（判输出是不是被截断）
async function readSseStream(
  stream: ReadableStream<Uint8Array>,
  onDelta?: (text: string) => void,
  tag = '[summary]'
): Promise<{ text: string; frames: number; finishReason: string }> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let full = ''
  let frames = 0
  let finishReason = ''
  let startedAt = 0

  console.log(`${tag} 开始收流`)

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

      let frame: any
      try {
        frame = JSON.parse(data)
      } catch {
        // 单个坏帧不该让整段作废：跳过它，继续收
        continue
      }

      // 帧数记在“合法的 data 帧”上，不看 content：思考型模型可能只回 reasoning、content 为空，
      // 那也说明服务端真的在按流式回（连接测试判的就是这个）
      if (!frames) {
        startedAt = Date.now()
        console.log(`${tag} 首帧到达`)
      }
      frames++

      // 收尾帧会带 finish_reason：'length' = 被 max_tokens 顶满截断（HTTP 仍是 200）
      const choice = frame?.choices?.[0]
      if (choice?.finish_reason) finishReason = choice.finish_reason

      const delta = choice?.delta?.content ?? ''
      if (!delta) continue
      full += delta
      onDelta?.(delta)
    }
  }

  console.log(`${tag} 收流结束：${frames} 帧，${full.length} 字，finish_reason=${finishReason || '（没收到）'}，耗时 ${startedAt ? Date.now() - startedAt : 0}ms`)
  return { text: full, frames, finishReason }
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
      // dry-run 也认中断：替身走的是与真调用同一条解析链，不认的话测不出中断路径
      if(init.signal?.aborted) {
        controller.error(new DOMException('Aborted', 'AbortError'))
        return
      }
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

// 连接测试：真发一条最小请求，验的是「地址 + key + 域名授权 + 模型名」这一整条链路
// 生成失败时最贵的排查成本就是分不清是哪一环坏的 —— 这里一次性把它拆开
// 只判 HTTP 是否通：思考型模型在小 max_tokens 下可能只回空 content，那也是正常响应
export async function testProviderConnection(input: {
  baseUrl: string
  key: string
  model: string
}): Promise<{ ok: boolean; ms: number; message: string }> {
  const url = chatCompletionsUrl(input.baseUrl)
  const startedAt = Date.now()
  const done = (ok: boolean, message: string) => ({ ok, ms: Date.now() - startedAt, message })

  if(DRY_RUN) return done(true, '【dry-run】跳过真实请求')
  if(!input.key) return done(false, '还没填 API Key')
  if(!input.model) return done(false, '还没填模型名')

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + input.key
      },
      body: JSON.stringify({
        model: input.model,
        max_tokens: 16,
        // 真生成走的就是流式：这里也必须走流式，否则“测试通过、生成却失败”这条缝还在
        stream: true,
        messages: [{ role: 'user', content: 'ping' }]
      }),
      // 测试不能把面板挂在那儿等：20 秒没动静就当不通
      signal: AbortSignal.timeout(20000)
    })
  } catch (err) {
    // 与 generate 同一个坑：域名没授权时 fetch 直接抛，不是 HTTP 错误
    console.error('连接测试发不出去：', err)
    return done(false, `请求发不出去：域名可能没授权（点上面的「授权访问」），或地址/网络不通（${url}）`)
  }

  if(!res.ok) {
    const detail = (await res.text().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 160)
    return done(false, `HTTP ${res.status}${detail ? '：' + detail : ''}`)
  }

  if(!res.body) return done(false, 'HTTP 通了，但响应没有可读的流')

  // 有帧才算真的能生成：服务端无视 stream:true 直接回一坨 JSON 的情况，就是在这里抓出来的
  let frames = 0
  try {
    frames = (await readSseStream(res.body, undefined, '[连接测试]')).frames
  } catch (err) {
    // AbortSignal.timeout 到点：流读了一半被中止
    if(isAbortError(err)) return done(false, '20 秒内没把流式响应读完（超时）')
    console.error('连接测试读流失败：', err)
    return done(false, `流式响应读不了：${err instanceof Error ? err.message : String(err)}`)
  }

  if(!frames) return done(false, '一个流式数据帧都没收到（服务端可能无视了 stream:true、直接回一坨 JSON）—— 生成时同样会失败')
  return done(true, `连接正常（${input.model} 已流式响应，${frames} 帧）`)
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
