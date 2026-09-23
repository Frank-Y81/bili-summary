<template>
  <div class="app" @click="cancelConfirm">
    <!-- 右上角悬浮按钮 -->
    <button class="settings-btn" title="设置" @click="showSettings = true">⚙</button>
    <button class="history-btn" title="历史记录" @click="showHistory = true">历史</button>

    <!-- 视频信息折叠区 -->
    <section class="video-section">
      <button class="video-toggle" @click="expanded = !expanded">
        <span class="arrow">{{ expanded ? '▾' : '▸' }}</span>
        视频信息
      </button>
      <table v-if="expanded" class="video-table">
        <tbody>
          <tr>
            <th>标题</th>
            <td>{{ title }}</td>
          </tr>
          <tr>
            <th>UP主</th>
            <td>{{ up || '未知' }}</td>
          </tr>
          <tr>
            <th>简介</th>
            <td>{{ desc || '无简介' }}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- AI 总结 -->
    <div class="ai-title-row">
      <span class="ai-badge"></span>
      <h2 class="ai-title">
        AI 总结 
        <span v-if="currentModeName" class="ai-mode-name">({{ currentModeName }}) · 总用时：{{ elapsed }}s</span>
      </h2>
    </div>

    <!-- 正在看历史记录：ready 状态没有生成入口，这里给一条回当前视频的路 -->
    <div v-if="viewingRecord" class="history-bar">
      <button class="history-back" title="回到当前视频" @click="backToCurrent">← 当前视频</button>
    </div>

    <!-- 状态区 -->
    <div v-if="uiStatus === 'loading'" class="state">
      <div class="spinner"></div>
      <p>正在获取字幕...</p>
    </div>
    <div v-else-if="uiStatus === 'generating'">
      <div v-if="!summaryText" class="state">
        <div class="spinner"></div>
        <p>正在生成总结...</p>
      </div>
      <div v-if="summaryText" class="summary" v-html="renderedSummary"></div>
    </div>
    <div v-else-if="uiStatus === 'no-subtitle'" class="state">
      <p class="state-icon">📭</p>
      <p>该视频没有可用字幕，无法生成总结</p>
    </div>
    <div v-else-if="uiStatus === 'waiting'" class="state">
      <p>正在等待视频信息...</p>
    </div>
    <div v-else-if="uiStatus === 'select-mode'" class="stale-wrap">
      <div class="stale-bar">
        <span class="stale-text">尚未生成总结</span>
        <button class="regenerate-btn" @click="openModeSelector">选择模式</button>
      </div>
    </div>
    <div v-else-if="uiStatus === 'stale'" class="stale-wrap">
      <div class="stale-bar">
        <span class="stale-text">缓存来自其他模式</span>
        <div class="stale-actions">
          <button class="regenerate-btn" @click="regenerate">重新生成</button>
          <button class="regenerate-btn secondary" @click="openModeSelector">切换模式</button>
        </div>
      </div>
      <div class="summary" v-html="renderedSummary"></div>
    </div>
    <div v-else class="summary" v-html="renderedSummary"></div>

    <!-- 历史记录弹层（列表自己滚，入口永远够得着） -->
    <div v-if="showHistory" class="mode-selector-overlay" @click.self="showHistory = false">
      <div class="mode-selector-panel history-panel">
        <div class="settings-header">
          <h4>历史记录 <span class="history-count">{{ historyList.length }}</span></h4>
          <button class="settings-close" @click="showHistory = false">✕</button>
        </div>
        <div class="history-list">
          <template v-for="group in historyGroups" :key="group.label">
            <div class="history-date">{{ group.label }}</div>
            <div
              v-for="rec in group.items"
              :key="rec.createdAt"
              class="history-item"
              :class="{ active: viewedKey === rec.createdAt }"
              @click="viewRecord(rec)"
            >
              <div class="history-main">
                <div class="history-title">{{ rec.videoTitle }}</div>
                <div class="history-meta">{{ modeNameOf(rec.promptModeId) }} · {{ formatTime(rec.createdAt) }} · {{ providerNameOf(rec.provider) }}/{{ modelLabel(rec.model) }}</div>
              </div>
              <button
                class="history-del"
                :class="{ confirming: confirmingKey === rec.createdAt }"
                :title="confirmingKey === rec.createdAt ? '再点一次确认删除' : '删除这条历史记录'"
                @click.stop="onDeleteClick(rec)"
              >{{ confirmingKey === rec.createdAt ? '确认' : '删除' }}</button>
            </div>
          </template>
          <p v-if="!historyList.length" class="api-hint">还没有历史记录</p>
        </div>
      </div>
    </div>

    <!-- 模式选择弹窗（竖排） -->
    <div v-if="showModeSelector" class="mode-selector-overlay" @click.self="showModeSelector = false">
      <div class="mode-selector-panel">
        <div class="settings-header">
          <h4>选择模式</h4>
          <button class="settings-close" @click="showModeSelector = false">✕</button>
        </div>
        <div class="mode-selector-list">
          <div
            v-for="mode in modes"
            :key="mode.id"
            class="mode-selector-item"
            :class="{ active: tempSelectedModeId === mode.id }"
            @click="tempSelectedModeId = mode.id"
          >
            <span v-if="tempSelectedModeId === mode.id" class="mode-check">✓</span>
            <span>{{ mode.name }}</span>
          </div>
        </div>
        <button class="mode-btn primary mode-confirm" @click="confirmModeSelection" :disabled="!tempSelectedModeId">生成总结</button>
      </div>
    </div>

    <!-- 设置弹层 -->
    <div v-if="showSettings" class="settings-overlay" @click.self="showSettings = false">
      <div class="settings-card">
      <div class="settings-panel">
        <div class="settings-inner">
        <div class="settings-header">
          <h3>设置</h3>
          <button class="settings-close" @click="showSettings = false">✕</button>
        </div>
        <div class="settings-body">
          <div class="setting-group">
            <h4>颜色</h4>
            <div class="color-item">
              <span>背景色</span>
              <div class="color-controls">
                <input type="color" :value="colors.bg" @input="setColor('bg', $event)" />
                <input type="text" :value="colors.bg" @input="setColorText('bg', $event)" class="color-text" />
              </div>
            </div>
            <div class="color-item">
              <span>强调色</span>
              <div class="color-controls">
                <input type="color" :value="colors.primary" @input="setColor('primary', $event)" />
                <input type="text" :value="colors.primary" @input="setColorText('primary', $event)" class="color-text" />
              </div>
            </div>
            <div class="color-item">
              <span>主文字</span>
              <div class="color-controls">
                <input type="color" :value="colors.textMain" @input="setColor('textMain', $event)" />
                <input type="text" :value="colors.textMain" @input="setColorText('textMain', $event)" class="color-text" />
              </div>
            </div>
            <div class="color-item">
              <span>次要文字</span>
              <div class="color-controls">
                <input type="color" :value="colors.textSub" @input="setColor('textSub', $event)" />
                <input type="text" :value="colors.textSub" @input="setColorText('textSub', $event)" class="color-text" />
              </div>
            </div>
            <div class="color-item">
              <span>分割线</span>
              <div class="color-controls">
                <input type="color" :value="colors.divider" @input="setColor('divider', $event)" />
                <input type="text" :value="colors.divider" @input="setColorText('divider', $event)" class="color-text" />
              </div>
            </div>
            <div class="card-color-wrap">
              <div class="color-item" @click="cardAlphaExpanded = !cardAlphaExpanded">
                <span>卡片背景 <span class="expand-hint">{{ cardAlphaExpanded ? '▾' : '▸' }}</span></span>
                <div class="color-controls" @click.stop>
                  <input type="color" :value="colors.card" @input="setColor('card', $event)" />
                  <input type="text" :value="colors.card" @input="setColorText('card', $event)" class="color-text" />
                </div>
              </div>
              <div class="alpha-row" :class="{ open: cardAlphaExpanded }">
                <div class="alpha-row-inner">
                  <div class="alpha-content">
                    <span class="alpha-label">透明度</span>
                    <input type="range" min="0" max="100" :value="alphas.card" @input="setAlpha('card', $event)" class="alpha-slider" />
                    <input type="number" min="0" max="100" :value="alphas.card" @input="setAlphaText('card', $event)" class="alpha-value-input" />
                    <span>%</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div class="setting-group">
            <h4>模型服务</h4>
            <div class="api-row">
              <span>厂商</span>
              <div class="provider-btns">
                <button
                  v-for="p in providers"
                  :key="p.id"
                  class="provider-btn"
                  :class="{ active: activeProviderId === p.id }"
                  @click="selectProvider(p.id)"
                >{{ p.name }}</button>
              </div>
            </div>
            <p v-if="!providers.length" class="api-hint">还没配置厂商，去下方「厂商管理」加一家</p>
            <div class="api-row stack">
              <span>模型</span>
              <div class="model-btns">
                <button
                  v-for="m in currentProviderModels"
                  :key="m"
                  class="provider-btn"
                  :class="{ active: currentProviderModel === m }"
                  :title="m"
                  @click="setModel(m)"
                >{{ modelLabel(m) }}</button>
              </div>
            </div>
          </div>
          <div class="setting-group">
            <h4>厂商管理（{{ providerConfigs.length }}）</h4>
            <div class="mode-list">
              <div v-for="p in providerConfigs" :key="p.id" class="mode-item" @click="startEditProvider(p)">
                <span class="mode-name">{{ p.name }}</span>
                <span v-if="grantedMap[p.id] === false" class="mode-badge warn">未授权</span>
                <div class="mode-actions" @click.stop>
                  <button class="mode-btn" @click="startEditProvider(p)">编辑</button>
                  <button class="mode-btn danger" @click="deleteProvider(p.id)">删除</button>
                </div>
              </div>
            </div>
            <p v-if="!providerConfigs.length" class="api-hint">还没有任何厂商，点下方「+ 新增厂商」自己配一家</p>

            <button v-if="!providerEditor" class="mode-add" @click="openCreateProvider">+ 新增厂商</button>

            <div v-if="providerEditor" class="mode-form">
              <h5 class="mode-form-title">{{ providerEditor === 'create' ? '新增厂商' : '编辑厂商' }}</h5>
              <input v-model="editProviderName" placeholder="名称，例如 百炼" class="mode-input" />
              <input v-model="editProviderBaseUrl" placeholder="接口地址，例如 https://dashscope.aliyuncs.com/compatible-mode/v1" class="mode-input" @change="refreshEditorGrant" />
              <p v-if="editorRequestUrl" class="api-hint">实际请求：{{ editorRequestUrl }}</p>
              <textarea v-model="editProviderModels" placeholder="模型名，每行一个" rows="4" class="mode-textarea"></textarea>
              <div class="key-row">
                <input
                  v-model="editProviderKey"
                  :type="showProviderKey ? 'text' : 'password'"
                  placeholder="API Key"
                  autocomplete="off"
                  class="mode-input"
                />
                <button class="mode-btn" @click="showProviderKey = !showProviderKey">{{ showProviderKey ? '隐藏' : '显示' }}</button>
              </div>
              <div class="grant-row">
                <button class="mode-btn" @click="authorizeProviderDomain">授权访问</button>
                <span class="grant-text">{{ editorGrantText }}</span>
              </div>
              <div class="mode-form-actions">
                <button class="mode-btn primary" @click="saveProvider">{{ providerEditor === 'create' ? '创建' : '保存' }}</button>
                <button class="mode-btn" @click="providerEditor = null">取消</button>
              </div>
            </div>
            <p class="api-hint">模型名要填接口认的那个（不是界面上的叫法），每行一个；接口地址写到 /v1 那一层即可，后面会自动接 /chat/completions</p>
          </div>
          <div class="setting-group">
            <h4>行为</h4>
            <div class="toggle-row">
              <span>打开 panel 直接总结</span>
              <input
                type="checkbox"
                :checked="autoSummarize"
                @change="setAutoSummarize(($event.target as HTMLInputElement).checked)"
                class="toggle-checkbox"
              />
            </div>
            <p class="api-hint">勾选后打开侧边栏将自动用当前模式生成总结</p>
          </div>
          <div class="setting-group">
            <h4>总结模式（{{ modes.length }}/{{ MAX_MODES }}）</h4>
            <div class="mode-list">
              <div v-for="mode in modes" :key="mode.id" class="mode-item" :class="{ active: mode.id === activeModeId }" @click="selectMode(mode.id)">
                <span v-if="mode.id === activeModeId" class="mode-check">✓</span>
                <span class="mode-name">{{ mode.name }}</span>
                <span v-if="mode.id === DEFAULT_MODE_ID" class="mode-badge">默认</span>
                <div class="mode-actions" @click.stop>
                  <button class="mode-btn" @click="startEditMode(mode)">编辑</button>
                  <button v-if="mode.id !== DEFAULT_MODE_ID" class="mode-btn danger" @click="deleteMode(mode.id)">删除</button>
                </div>
              </div>
            </div>
            <button v-if="modes.length < MAX_MODES && !modeEditor" class="mode-add" @click="openCreateMode">+ 新建模式</button>
            <div v-if="modeEditor" class="mode-form">
              <h5 class="mode-form-title">{{ modeEditor === 'create' ? '新建模式' : '编辑模式' }}</h5>
              <input v-model="editName" placeholder="模式名称" class="mode-input" />
              <textarea v-model="editPrompt" placeholder="模式指令，例如：请用三个要点总结，并给出行动建议" rows="3" class="mode-textarea"></textarea>
              <div class="mode-form-actions">
                <button class="mode-btn primary" @click="saveMode">{{ modeEditor === 'create' ? '创建' : '保存' }}</button>
                <button class="mode-btn" @click="modeEditor = null">取消</button>
              </div>
            </div>
            <p class="api-hint">生成总结时使用当前选中的模式，通用约束（不杜撰等）始终生效</p>
          </div>
          <div class="setting-group">
            <h4>字号</h4>
            <div class="font-size-options">
              <button :class="{ active: fontSize === 'small' }" @click="setFontSize('small')">小</button>
              <button :class="{ active: fontSize === 'medium' }" @click="setFontSize('medium')">中</button>
              <button :class="{ active: fontSize === 'large' }" @click="setFontSize('large')">大</button>
            </div>
          </div>
        </div>
        </div>
        </div>
      </div>
      </div>
    </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted, onUnmounted, watch, nextTick } from "vue";
import { marked } from "marked";
import { createDefaultMode, DEFAULT_MODE_ID, MAX_MODES, type PromptMode } from "./prompts";
import { MSG_DELETE_RECORD, PORT_SUMMARY_STREAM, FRAME_GENERATE, FRAME_DELTA, FRAME_DONE, FRAME_ERROR } from "./messages";
import { buildProviders, chatCompletionsUrl, loadProviderConfigs, normalizeBaseUrl, originPatternOf, saveProviderConfigs } from "./providers";
import { STORAGE_KEYS } from "./storage-keys";
import { type ProviderCard, type ProviderConfig, type ProviderSetting, type SummaryRecord } from "./types";

const title = ref('loading...')
const desc = ref('')
const up = ref('')
const expanded = ref(false)
const showSettings = ref(false)
const cardAlphaExpanded = ref(false)
const activeProviderId= ref('deepseek')
const providerSetting = ref<ProviderSetting>({})
// 厂商清单来自 storage（背景上下文与面板共用同一个 loadProviders）
const providers = ref<ProviderCard[]>([])
// 厂商管理：原始配置（带 key，编辑界面要用）与编辑器状态
const providerConfigs = ref<ProviderConfig[]>([])
const providerEditor = ref<'create' | string | null>(null)
const editProviderName = ref('')
const editProviderBaseUrl = ref('')
const editProviderModels = ref('')
const editProviderKey = ref('')
const showProviderKey = ref(false)
const editorGranted = ref<boolean | null>(null)
const grantedMap = ref<Record<string, boolean>>({})
const modes = ref<PromptMode[]>([])
const activeModeId = ref('')
const modeEditor = ref<'create' | string | null>(null)
const editName = ref('')
const editPrompt = ref('')
const uiStatus = ref<'loading' | 'generating' | 'no-subtitle' | 'waiting' | 'ready' | 'stale' | 'select-mode'>('loading')
const summaryText = ref('')
const autoSummarize = ref(false)
const showModeSelector = ref(false)
const tempSelectedModeId = ref('')
const elapsed = ref(0)
const historyList = ref<SummaryRecord[]>([])
let summaryRequestSeq = 0
let summaryInFlight = false

// === 主题系统 ===
const colors = reactive({
  bg: '#00452E',
  primary: '#7ED957',
  textMain: '#FFFFFF',
  textSub: '#C8D5CE',
  divider: '#2E6B4F',
  card: '#0A5638'
})
const alphas = reactive({
  bg: 100, primary: 100, textMain: 100, textSub: 100, divider: 100, card: 100
})
const fontSize = ref('medium')
const sizeMap = { small: '13px', medium: '15px', large: '17px' }
const summaryFontSize = computed(() => sizeMap[fontSize.value as keyof typeof sizeMap])

function hexToRgb(hex: string) {
  const m = hex.replace('#', '')
  return {
    r: parseInt(m.slice(0, 2), 16),
    g: parseInt(m.slice(2, 4), 16),
    b: parseInt(m.slice(4, 6), 16)
  }
}

function toCssValue(key: string): string {
  const hex = (colors as Record<string, string>)[key]
  const alpha = (alphas as Record<string, number>)[key] / 100
  if (alpha >= 1) return hex
  const { r, g, b } = hexToRgb(hex)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

function applyTheme() {
  const root = document.documentElement
  root.style.setProperty('--bg', toCssValue('bg'))
  root.style.setProperty('--primary', toCssValue('primary'))
  root.style.setProperty('--text-main', toCssValue('textMain'))
  root.style.setProperty('--text-sub', toCssValue('textSub'))
  root.style.setProperty('--divider', toCssValue('divider'))
  root.style.setProperty('--card', toCssValue('card'))
}

function setColor(key: string, event: Event) {
  const value = (event.target as HTMLInputElement).value
  ;(colors as Record<string, string>)[key] = value
  applyTheme()
  saveTheme()
}

function setColorText(key: string, event: Event) {
  let value = (event.target as HTMLInputElement).value.trim()
  // 自动补 # 前缀
  if (value && !value.startsWith('#')) value = '#' + value
  // 只有合法的 hex 格式才应用
  if (/^#[0-9a-fA-F]{6}$/.test(value)) {
    ;(colors as Record<string, string>)[key] = value
    applyTheme()
    saveTheme()
  }
}

function setAlpha(key: string, event: Event) {
  ;(alphas as Record<string, number>)[key] = Number((event.target as HTMLInputElement).value)
  applyTheme()
  saveTheme()
}

function setAlphaText(key: string, event: Event) {
  const value = Number((event.target as HTMLInputElement).value)
  if (!isNaN(value) && value >= 0 && value <= 100) {
    ;(alphas as Record<string, number>)[key] = Math.round(value)
    applyTheme()
    saveTheme()
  }
}

function setFontSize(size: string) {
  fontSize.value = size
  saveTheme()
}

async function saveTheme() {
  await chrome.storage.local.set({
    [STORAGE_KEYS.theme]: {
      colors: { ...colors },
      alphas: { ...alphas }
    },
    [STORAGE_KEYS.fontSize]: fontSize.value
  })
}

async function loadTheme() {
  const saved = await chrome.storage.local.get([STORAGE_KEYS.theme, STORAGE_KEYS.fontSize, STORAGE_KEYS.autoSummarize]) as {
    theme?: { colors?: Record<string, string>; alphas?: Record<string, number> } | Record<string, string>
    fontSize?: string
    autoSummarize?: boolean
  }
  if (saved.theme) {
    if (saved.theme.colors) Object.assign(colors, saved.theme.colors)
    else Object.assign(colors, saved.theme)  // 兼容旧格式
    if (saved.theme.alphas) Object.assign(alphas, saved.theme.alphas)
  }
  if (saved.fontSize) fontSize.value = saved.fontSize as string
  if (typeof saved.autoSummarize === 'boolean') autoSummarize.value = saved.autoSummarize
  applyTheme()
}

// === 状态与数据 ===
function handleStorageChange(
  changes: { [key: string]: chrome.storage.StorageChange },
  areaName: string
) {
  if(areaName !== 'local') return
  const K = STORAGE_KEYS
  if(changes[K.videoTitle]) {
    title.value = changes[K.videoTitle].newValue as string
  }
  if(changes[K.videoDesc]) {
    desc.value = changes[K.videoDesc].newValue as string
  }
  if(changes[K.videoOwner]) {
    up.value = changes[K.videoOwner].newValue as string
  }
  if(changes[K.summaryRecords]) {
    historyList.value = (changes[K.summaryRecords].newValue ?? []) as SummaryRecord[]
  }
  // 这些变化都会影响总结的决策，统一触发一次刷新
  // 生成中忽略（防止旧缓存覆盖），视频切换除外
  if(summaryInFlight && !changes[K.videoId]) return
  if(changes[K.videoId] || changes[K.subtitleStatus] || changes[K.videoTitle] ||
     changes[K.videoSummary] || changes[K.videoSummaryId] || changes[K.activeModeId]) {
    refreshSummary()
  }
}

async function refreshSummary(options: { auto?: boolean } = {}) {
  
  const { videoId, subtitleStatus, videoTitleId, summaryRecords} = await chrome.storage.local.get([
     STORAGE_KEYS.videoId, STORAGE_KEYS.subtitleStatus, STORAGE_KEYS.videoTitleId, STORAGE_KEYS.summaryRecords
  ])
  
  const records = (summaryRecords ?? []) as SummaryRecord[]

  const exact = records.find(r => r.videoId === videoId && r.promptModeId === activeModeId.value)
  const anyMode = records.find(r => r.videoId === videoId)

  // 有生成请求在飞行中：不要用旧缓存状态覆盖它（防止 stale 覆盖 generating 的竞态）
  if (summaryInFlight) return

  if(subtitleStatus === 'loading') {
    uiStatus.value = 'loading'
    return
  }
  if(subtitleStatus === 'no-subtitle') {
    uiStatus.value = 'no-subtitle'
    return
  }
  if(exact) {
    summaryText.value = exact.summary as string
    uiStatus.value = 'ready'
  } else if(anyMode) {
    // 无缓存：勾选自动总结则直接生成，否则等用户选模式确认
      summaryText.value = anyMode.summary
      uiStatus.value = 'stale'
  } else if(videoTitleId === videoId) {
      if(autoSummarize.value && options.auto !== false) {
        regenerate()
      } else {
        uiStatus.value = 'select-mode'
      }
  } else {
    uiStatus.value = 'waiting'
  }
  
}

let timer: number
let streamPort: chrome.runtime.Port | null = null

function regenerate() {
  // 生成中不允许重复触发（防连点导致多次 API 调用）
  if (summaryInFlight) return
  // 启动计时，查看总结生成的耗时
  elapsed.value = 0
  timer = setInterval(()=> {
    elapsed.value++
  }, 1000)

  summaryInFlight = true
  const seq = ++summaryRequestSeq
  uiStatus.value = 'generating'
  summaryText.value = ''

  // 上一轮的长连接先断（它的回调靠 seq 自行作废）
  streamPort?.disconnect()

  const port = chrome.runtime.connect({ name: PORT_SUMMARY_STREAM })
  streamPort = port

  port.onMessage.addListener((frame: { type: string; text?: string; summary?: string; message?: string }) => {
    // 过期请求丢弃（用户已切换模式/视频或发起了新请求）
    if (seq !== summaryRequestSeq) return

    if (frame.type === FRAME_DELTA) {
      summaryText.value += frame.text ?? ''
      return
    }

    // 收尾恰好一帧：done 带整段（以它为准，防止漏帧），error 带错误文本
    if (frame.type === FRAME_DONE || frame.type === FRAME_ERROR) {
      stopStream(seq)
      summaryText.value = frame.type === FRAME_DONE
        ? (frame.summary ?? '')
        : (frame.message ?? '生成失败')
      uiStatus.value = 'ready'
      port.disconnect()
    }
  })

  port.onDisconnect.addListener(() => {
    // seq 对得上 + 还在生成中 = 非正常断开（后台被回收 / 连接断了）
    if (seq !== summaryRequestSeq) return
    if (!summaryInFlight) return
    stopStream(seq)
    summaryText.value += summaryText.value
      ? '\n\n（连接中断，以上可能不完整：后台 service worker 被回收或请求被挂断，控制台有日志）'
      : '（一个字都没收到：后台连接已断，九成是 service worker 被回收——看后台控制台日志）'
    uiStatus.value = 'ready'
  })

  port.postMessage({ type: FRAME_GENERATE })
}

// 中断在途的流式生成：seq 前进让在途帧全部作废，端口断开（后台会照样把这次生成写完）
function cancelStream() {
  if (!summaryInFlight) return
  summaryRequestSeq++
  summaryInFlight = false
  clearInterval(timer)
  streamPort?.disconnect()
  streamPort = null
}

// 正常收尾（done / error）：停表、解除生成中标记
function stopStream(seq: number) {
  if (seq !== summaryRequestSeq) return
  summaryInFlight = false
  clearInterval(timer)
}

async function setAutoSummarize(value: boolean) {
  autoSummarize.value = value
  await chrome.storage.local.set({ [STORAGE_KEYS.autoSummarize]: value })
}

function openModeSelector() {
  tempSelectedModeId.value = activeModeId.value
  showModeSelector.value = true
}

async function confirmModeSelection() {
  if (!tempSelectedModeId.value) return
  // 先关弹窗（视觉即时反馈），避免卡顿期间被重复点击
  showModeSelector.value = false
  activeModeId.value = tempSelectedModeId.value
  await saveModes()
  regenerate()
}

const currentModeName = computed(() =>
  modes.value.find(m => m.id === activeModeId.value)?.name ?? ''
)

function modeNameOf(id: string) {
  return modes.value.find( m => m.id === id)?.name ?? '已删除的模式'
}

function providerNameOf(id:string) {
  const pid = PROVIDER_ID_ALIAS[id] ?? id
  return providers.value.find( p => p.id === pid)?.name ?? '不可用的provider'
}

function formatTime(ts: number) {
  return new Date(ts).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  })
}

const showHistory = ref(false)
const viewedKey = ref<number | null>(null)

// 厂商卡改过 id（qwen → bailian）：历史记录与已存设置里还写着旧 id，读的时候折一下
const PROVIDER_ID_ALIAS: Record<string, string> = { qwen: 'bailian' }

// 两段确认：存的是待确认那条的 createdAt；超时或点别处就作废
const CONFIRM_WINDOW_MS = 3000
const confirmingKey = ref<number | null>(null)
let confirmTimer: number | undefined

function dateLabel(ts: number) {
  const d = new Date(ts)
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const day = 86400000
  if (ts >= startOfToday) return '今天'
  if (ts >= startOfToday - day) return '昨天'
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

const historyGroups = computed(() => {
  const groups: { label: string; items: SummaryRecord[] }[] = []
  for (const rec of historyList.value) {
    const label = dateLabel(rec.createdAt)
    const g = groups.find(g => g.label === label)
    if (g) g.items.push(rec)
    else groups.push({ label, items: [rec] })
  }
  return groups
})

function viewRecord(rec: SummaryRecord) {
  // 生成中点历史 = 我要看这一条，不再看直播（后台会照样把这次生成写完并落盘）
  cancelStream()
  summaryText.value = rec.summary
  uiStatus.value = 'ready'
  viewedKey.value = rec.createdAt
  showHistory.value = false
  // 弹层关了、正文在顶部：把视图带回开头
  nextTick(() => window.scrollTo(0, 0))
}

// 当前正在看的那条历史（被删/被挤掉时为 null，细条自动消失）
const viewingRecord = computed(() =>
  viewedKey.value === null
    ? null
    : historyList.value.find(r => r.createdAt === viewedKey.value) ?? null
)

// 回当前视频：交给 refreshSummary 落到该有的状态（select-mode / stale / ready）
async function backToCurrent() {
  viewedKey.value = null
  summaryText.value = ''
  await refreshSummary()
}

// 删除一条历史记录：数据由 background 写（单一数据源），列表靠 storage 监听自动更新
// 两段确认：第一次点击只是把按钮切到确认态，第二次才真删（防误触）
async function onDeleteClick(rec: SummaryRecord) {
  if (confirmingKey.value !== rec.createdAt) {
    confirmingKey.value = rec.createdAt
    clearTimeout(confirmTimer)
    confirmTimer = window.setTimeout(() => { confirmingKey.value = null }, CONFIRM_WINDOW_MS)
    return
  }
  cancelConfirm()
  await deleteRecord(rec)
}

function cancelConfirm() {
  confirmingKey.value = null
  clearTimeout(confirmTimer)
}

async function deleteRecord(rec: SummaryRecord) {
  try {
    const res = await chrome.runtime.sendMessage({
      type: MSG_DELETE_RECORD,
      createdAt: rec.createdAt
    })
    if (!res?.ok) return
  } catch (err) {
    console.error('删除历史记录失败：', err)
    return
  }

  // 删掉的正是屏幕上正在看的那条：回到当前视频的常规状态
  // auto: false —— 删除是明确动作，不许被"自动总结"顺手重新生成出来
  if (viewedKey.value === rec.createdAt) {
    viewedKey.value = null
    summaryText.value = ''
    await refreshSummary({ auto: false })
  }
}

const currentProviderModels = computed(() =>
  providers.value.find(p => p.id === activeProviderId.value)?.models ?? []
)
const currentProviderModel = computed(() =>
  providerSetting.value[activeProviderId.value]?.model
    ?? currentProviderModels.value[0]
    ?? ''
)

function selectProvider(id: string) {
  activeProviderId.value = id
  chrome.storage.local.set({[STORAGE_KEYS.activeProviderId]: id})
}

function setModel(m: string) {
  providerSetting.value[activeProviderId.value] = { model: m }
  saveProviderConfig()
}

// 按钮上的展示名：ZHIPU/GLM-5.3-FlashX 这种前缀是接口细节，按钮上只留模型名（完整 ID 看 title）
function modelLabel(m: string) {
  return m.split('/').pop() ?? m
}

async function saveProviderConfig() {
  await chrome.storage.local.set({
    [STORAGE_KEYS.providerSetting]: providerSetting.value
  })
}

async function selectMode(id: string) {
  console.log('[sidepanel] 切换模式：', id)
  activeModeId.value = id
  await saveModes()
}

function openCreateMode() {
  modeEditor.value = 'create'
  editName.value = ''
  editPrompt.value = ''
}

function startEditMode(mode: PromptMode) {
  modeEditor.value = mode.id
  editName.value = mode.name
  editPrompt.value = mode.prompt
}

async function saveMode() {
  const name = editName.value.trim()
  const prompt = editPrompt.value.trim()
  if (!name || !prompt) return
  if (modeEditor.value === 'create') {
    if (modes.value.length >= MAX_MODES) return
    modes.value.push({
      id: `mode-${Date.now()}`,
      name,
      prompt,
      createdAt: Date.now()
    })
    activeModeId.value = modes.value[modes.value.length - 1].id
  } else {
    const m = modes.value.find(x => x.id === modeEditor.value)
    if (m) {
      m.name = name
      m.prompt = prompt
    }
  }
  modeEditor.value = null
  await saveModes()
}

async function deleteMode(id: string) {
  modes.value = modes.value.filter(m => m.id !== id)
  if (activeModeId.value === id) {
    activeModeId.value = modes.value[0]?.id ?? DEFAULT_MODE_ID
  }
  if (modeEditor.value === id) modeEditor.value = null
  await saveModes()
}

// === 厂商管理 ===

// 读原始配置（带 key）+ 重装卡片（卡片带 generate 闭包，不能存 storage，只能现编）
async function refreshProviders() {
  providerConfigs.value = await loadProviderConfigs()
  providers.value = buildProviders(providerConfigs.value)
}

function openCreateProvider() {
  providerEditor.value = 'create'
  editProviderName.value = ''
  editProviderBaseUrl.value = ''
  editProviderModels.value = ''
  editProviderKey.value = ''
  void refreshEditorGrant()
}

function startEditProvider(p: ProviderConfig) {
  providerEditor.value = p.id
  editProviderName.value = p.name
  editProviderBaseUrl.value = p.baseUrl
  editProviderModels.value = p.models.join('\n')
  editProviderKey.value = p.key
  void refreshEditorGrant()
}

async function saveProvider() {
  const name = editProviderName.value.trim()
  // 接口地址归一化：去掉尾部斜杠、剥掉误填的 /chat/completions（工厂会自己再接一次）
  const baseUrl = normalizeBaseUrl(editProviderBaseUrl.value)
  const models = editProviderModels.value.split('\n').map(m => m.trim()).filter(Boolean)
  const key = editProviderKey.value.trim()

  // 必填项不全就不提交（名称 / 接口地址 / 至少一个模型）
  if (!name || !baseUrl || !models.length) return

  if (providerEditor.value === 'create') {
    // id 不让用户填：只当内部主键用，手填容易撞车
    providerConfigs.value.push({ id: `p-${Date.now()}`, name, baseUrl, models, key })
  } else {
    const i = providerConfigs.value.findIndex(p => p.id === providerEditor.value)
    if (i >= 0) providerConfigs.value[i] = { ...providerConfigs.value[i], name, baseUrl, models, key }
  }

  providerEditor.value = null
  await persistProviders()
}

async function deleteProvider(id: string) {
  providerConfigs.value = providerConfigs.value.filter(p => p.id !== id)
  if (providerEditor.value === id) providerEditor.value = null
  await persistProviders()
}

// === 域名授权 ===
const editorGrantPattern = computed(() => originPatternOf(editProviderBaseUrl.value))

// 实际会打出去的地址：填什么就是什么，不用脑补
const editorRequestUrl = computed(() =>
  editProviderBaseUrl.value.trim() ? chatCompletionsUrl(editProviderBaseUrl.value) : ''
)

const editorGrantText = computed(() => {
  if (providerEditor.value === null) return ''
  if (!editorGrantPattern.value) return '接口地址填好才能算出版本域名'
  if (editorGranted.value === null) return ''
  return editorGranted.value
    ? `已授权 ${editorGrantPattern.value}`
    : `未授权 ${editorGrantPattern.value}（不授权请求发不出去）`
})

// contains() 同时覆盖「manifest 里写死的」和「运行时授权的」，不用自己去分辨来源
async function refreshGrantedMap() {
  const entries = await Promise.all(providerConfigs.value.map(async p => {
    const pattern = originPatternOf(p.baseUrl)
    if (!pattern) return [p.id, false] as const
    return [p.id, await chrome.permissions.contains({ origins: [pattern] })] as const
  }))
  grantedMap.value = Object.fromEntries(entries)
}

async function refreshEditorGrant() {
  const pattern = originPatternOf(editProviderBaseUrl.value)
  editorGranted.value = pattern
    ? await chrome.permissions.contains({ origins: [pattern] })
    : null
}

// 必须在用户手势里同步调用：这个函数体里前面不能出现任何 await，
// 否则手势被吃掉，弹窗会报 "This function must be called during a user gesture"
function authorizeProviderDomain() {
  const pattern = editorGrantPattern.value
  if (!pattern) return

  chrome.permissions.request({ origins: [pattern] }, granted => {
    if (!granted) console.warn('用户拒绝了域名授权：', pattern)
    // 进了回调就可以 await 了
    void refreshEditorGrant()
    void refreshGrantedMap()
  })
}

// 写 storage → 重装卡片 → 兼底选中项与被删模名称
async function persistProviders() {
  await saveProviderConfigs(providerConfigs.value)
  await refreshProviders()
  void refreshGrantedMap()

  // 当前选中的厂商被删了：切到第一家，并写回 storage（background 读的是 storage，不写回就成两份真值）
  if (!providers.value.some(p => p.id === activeProviderId.value)) {
    activeProviderId.value = providers.value[0]?.id ?? ''
    await chrome.storage.local.set({ [STORAGE_KEYS.activeProviderId]: activeProviderId.value })
    if (activeProviderId.value) await loadProviderConfig()
    return
  }

  // 选中的模型名被删掉了：清回第一家模型，否则界面上是个已经不存在的模型，真调用直接 404
  const current = providers.value.find(p => p.id === activeProviderId.value)
  const chosen = providerSetting.value[activeProviderId.value]?.model
  if (current && chosen && !current.models.includes(chosen)) {
    providerSetting.value[activeProviderId.value] = { model: current.models[0] ?? '' }
    await saveProviderConfig()
  }
}

async function loadProviderConfig() {
  const { providerSetting: savedSetting, activeProviderId: savedProviderId} 
    = await chrome.storage.local.get([STORAGE_KEYS.providerSetting, STORAGE_KEYS.activeProviderId])

  const savedId = PROVIDER_ID_ALIAS[savedProviderId as string] ?? savedProviderId
  activeProviderId.value = providers.value.find(p => p.id === savedId)?.id ?? providers.value[0]?.id ?? ''

  // 旧卡 id 下的模型选择折到新 id，并写回 storage
  // 不写回的话：面板读的是折过的本地值，background 读的是 storage 里的旧键，
  // 会出现「面板显示 A、真发 B」（且 background 找不到旧 id 的厂商 → 直接报所选厂商不可用）
  const setting = { ...(savedSetting ?? {}) } as ProviderSetting
  const idChanged = savedProviderId !== activeProviderId.value
  if (setting.qwen && !setting.bailian) {
    setting.bailian = setting.qwen
    delete setting.qwen
  }
  providerSetting.value = setting
  if (idChanged) {
    await chrome.storage.local.set({
      [STORAGE_KEYS.providerSetting]: setting,
      [STORAGE_KEYS.activeProviderId]: activeProviderId.value
    })
  }
}

async function loadModes() {
  const saved = await chrome.storage.local.get([STORAGE_KEYS.promptModes, STORAGE_KEYS.activeModeId])
  if (Array.isArray(saved.promptModes) && saved.promptModes.length > 0) {
    modes.value = saved.promptModes as PromptMode[]
  } else {
    modes.value = [createDefaultMode()]
    await saveModes()
  }
  activeModeId.value = (saved.activeModeId as string) || DEFAULT_MODE_ID
  if (!modes.value.find(m => m.id === activeModeId.value)) {
    activeModeId.value = modes.value[0].id
  }
}

async function saveModes() {
  await chrome.storage.local.set({
    // 写入干净的普通对象数组，避免响应式代理序列化问题
    [STORAGE_KEYS.promptModes]: modes.value.map(m => ({ ...m })),
    [STORAGE_KEYS.activeModeId]: activeModeId.value
  })
}

onMounted(async () => {
  await loadTheme()
  await refreshProviders()
  await loadProviderConfig()
  await loadModes()
  const data = await chrome.storage.local.get([STORAGE_KEYS.videoTitle, STORAGE_KEYS.videoDesc, STORAGE_KEYS.videoOwner])
  title.value = (data.videoTitle as string) ?? 'loading...'
  desc.value = (data.videoDesc as string) ?? ''
  up.value = (data.videoOwner as string) ?? ''
  const { summaryRecords } = await chrome.storage.local.get(STORAGE_KEYS.summaryRecords)
  historyList.value = (summaryRecords ?? []) as SummaryRecord[]
  chrome.storage.onChanged.addListener(handleStorageChange)
  await refreshSummary()
})

const renderedSummary = computed(() => marked(summaryText.value, { breaks: true }))

onUnmounted(() => {
  chrome.storage.onChanged.removeListener(handleStorageChange)
  clearInterval(timer)
  clearTimeout(confirmTimer)
  streamPort?.disconnect()
})

// 流式输出时让视图跟着最新文字走（面板是文档级滚动，没有内层滚动容器）
watch(summaryText, async () => {
  if (uiStatus.value !== 'generating') return
  await nextTick()
  followStream()
})

function followStream() {
  const doc = document.documentElement
  // 用户自己往上翻时不跟他抢：离底部超过 120px 就认为他在读上面那段
  const distanceToBottom = doc.scrollHeight - window.scrollY - window.innerHeight
  if (distanceToBottom > 120) return
  window.scrollTo(0, doc.scrollHeight)
}

// 设置弹层打开时锁定背景滚动：滚轮不会穿透到主界面
watch(showSettings, (open) => {
  document.documentElement.style.overflow = open ? 'hidden' : ''
  document.body.style.overflow = open ? 'hidden' : ''
  if (open) void refreshGrantedMap()
})
</script>

<style scoped>
:root {
  --bg: #00452E;
  --primary: #7ED957;
  --text-main: #FFFFFF;
  --text-sub: #C8D5CE;
  --divider: #2E6B4F;
  --card: #0A5638;
}

.app {
  background: var(--bg);
  color: var(--text-main);
  min-height: 100vh;
  padding: 24px 28px 60px;
  box-sizing: border-box;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
}

/* 设置按钮 */
.settings-btn {
  position: fixed;
  top: 14px;
  right: 16px;
  z-index: 100;
  width: 38px;
  height: 38px;
  border: none;
  border-radius: 10px;
  background: var(--card);
  color: var(--text-sub);
  font-size: 18px;
  cursor: pointer;
  transition: color 0.2s;
}
.settings-btn:hover { color: var(--primary); }

/* 历史入口：与设置按钮并排；列表入口从正文底部搬上来，正文再长也够得着 */
.history-btn {
  position: fixed;
  top: 14px;
  right: 62px;
  z-index: 100;
  height: 38px;
  padding: 0 12px;
  display: flex;
  align-items: center;
  gap: 6px;
  border: none;
  border-radius: 10px;
  background: var(--card);
  color: var(--text-sub);
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
  transition: color 0.2s;
}
.history-btn:hover { color: var(--primary); }
.history-bar { margin-bottom: 12px; }
/* 厂商管理：key 输入 + 显示/隐藏 */
.key-row {
  display: flex;
  gap: 8px;
  align-items: center;
}
.key-row .mode-btn {
  flex-shrink: 0;
}
.grant-row {
  display: flex;
  gap: 8px;
  align-items: center;
}
.grant-text {
  font-size: 11.5px;
  color: var(--text-sub);
}
.mode-badge.warn {
  background: #ff6b6b;
  color: #fff;
}
.history-back {
  padding: 5px 10px;
  border: 1px solid var(--divider);
  border-radius: 6px;
  background: none;
  color: var(--text-sub);
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
  transition: border-color 0.15s ease, color 0.15s ease;
}
.history-back:hover { border-color: var(--primary); color: var(--primary); }

/* 视频信息折叠区 */
.video-section { margin-bottom: 8px; }
.video-toggle {
  background: none;
  border: none;
  color: var(--text-sub);
  font-size: 14px;
  cursor: pointer;
  padding: 8px 0;
  display: flex;
  align-items: center;
  gap: 8px;
}
.video-toggle:hover { color: var(--primary); }
.arrow { font-size: 12px; }

.video-table {
  width: 100%;
  border-collapse: collapse;
  margin-top: 8px;
  font-size: 14px;
}
.video-table th {
  text-align: left;
  color: var(--text-sub);
  font-weight: normal;
  width: 72px;
  vertical-align: top;
  padding: 10px 14px 10px 0;
  white-space: nowrap;
}
.video-table td {
  color: var(--text-main);
  padding: 10px 0;
  border-bottom: 1px solid var(--divider);
  line-height: 1.6;
}

/* AI 总结标题 */
.ai-title-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 20px 0 14px;
}
.ai-badge {
  width: 4px;
  height: 18px;
  background: var(--primary);
  border-radius: 2px;
}
.ai-title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}

/* 状态区 */
.state {
  text-align: center;
  padding: 64px 0;
  color: var(--text-sub);
}
.state p { margin: 0; font-size: 14px; }
.state-icon { font-size: 36px; margin-bottom: 10px; }

.spinner {
  width: 26px;
  height: 26px;
  border: 2px solid var(--divider);
  border-top-color: var(--primary);
  border-radius: 50%;
  margin: 0 auto 14px;
  animation: spin 0.8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

/* 总结正文 */
.summary {
  font-size: v-bind(summaryFontSize);
  line-height: 1.75;
  color: var(--text-main);
  word-break: break-word;
}
.summary :deep(h1),
.summary :deep(h2),
.summary :deep(h3) {
  margin: 1.2em 0 0.5em;
  line-height: 1.4;
}
.summary :deep(h1) { font-size: 1.4em; }
.summary :deep(h2) { font-size: 1.25em; }
.summary :deep(h3) { font-size: 1.1em; }
.summary :deep(p) { margin: 0.6em 0; }
.summary :deep(ul),
.summary :deep(ol) { padding-left: 1.5em; margin: 0.6em 0; }
.summary :deep(li) { margin: 0.3em 0; }
.summary :deep(blockquote) {
  margin: 0.8em 0;
  padding: 0.4em 1em;
  border-left: 3px solid var(--primary);
  background: var(--card);
  border-radius: 0 6px 6px 0;
  color: var(--text-sub);
}
.summary :deep(code) {
  background: var(--card);
  padding: 0.15em 0.4em;
  border-radius: 4px;
  font-size: 0.9em;
}
.summary :deep(pre) {
  background: var(--card);
  padding: 12px 16px;
  border-radius: 8px;
  overflow-x: auto;
  line-height: 1.5;
}
.summary :deep(pre code) { background: none; padding: 0; }
.summary :deep(a) { color: var(--primary); }
.summary :deep(strong) { font-weight: 600; }

/* 设置弹层 */
.settings-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  z-index: 200;
  display: flex;
  justify-content: center;
  align-items: center;
}
/* 卡片外层：背景 + 固定留白（不滚动，留白始终可见） */
.settings-card {
  width: 92%;
  max-width: 560px;
  background: var(--card);
  border-radius: 14px;
  padding: 28px;
  box-sizing: border-box;
}

/* 滚动容器：在卡片内侧滚动，内容永远碰不到卡片边缘 */
.settings-panel {
  max-height: calc(90vh - 56px);
  overflow-y: auto;
}

/* 内层内容 padding */
.settings-inner {
  padding: 0 2px;
}
.settings-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}

/* 滚动到底部时内容不贴边（滚动容器 padding-bottom 会失效，用内容区补） */
.settings-body {
  padding-bottom: 28px;
}
.settings-header h3 { margin: 0; font-size: 16px; }
.settings-close {
  background: none;
  border: none;
  color: var(--text-sub);
  font-size: 16px;
  cursor: pointer;
}
.settings-close:hover { color: var(--primary); }

.setting-group {
  margin-bottom: 30px;
}

.setting-group h4 {
  margin: 0 0 10px;
  font-size: 13px;
  color: var(--text-sub);
  font-weight: 600;
  letter-spacing: 0.5px;
}

.color-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 9px 0;
  font-size: 14px;
  border-bottom: 1px solid var(--divider);
}
.color-item:last-child { border-bottom: none; }
.color-item input[type="color"] {
  width: 44px;
  height: 30px;
  border: none;
  border-radius: 6px;
  background: none;
  cursor: pointer;
  padding: 0;
}

.color-controls {
  display: flex;
  align-items: center;
  gap: 10px;
}

.color-text {
  width: 100px;
  padding: 6px 10px;
  border: 1px solid var(--divider);
  border-radius: 6px;
  background: var(--bg);
  color: var(--text-main);
  font-size: 13px;
  font-family: ui-monospace, "SF Mono", Consolas, monospace;
  box-sizing: border-box;
}
.color-text:focus {
  outline: none;
  border-color: var(--primary);
}

.expand-hint {
  font-size: 12px;
  color: var(--text-sub);
}

.alpha-row {
  display: grid;
  grid-template-rows: 0fr;
  opacity: 0;
  transition: grid-template-rows 0.25s ease, opacity 0.25s ease;
}
.alpha-row.open {
  grid-template-rows: 1fr;
  opacity: 1;
}
.alpha-row-inner {
  overflow: hidden;
}
.alpha-content {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 0 4px;
  font-size: 13px;
  color: var(--text-sub);
}
.alpha-label {
  white-space: nowrap;
  color: var(--text-main);
}

.alpha-slider {
  flex: 1;
  accent-color: var(--primary);
  cursor: pointer;
}

.alpha-value-input {
  width: 52px;
  padding: 5px 8px;
  border: 1px solid var(--divider);
  border-radius: 6px;
  background: var(--bg);
  color: var(--text-main);
  font-size: 13px;
  font-family: ui-monospace, "SF Mono", Consolas, monospace;
  box-sizing: border-box;
  text-align: center;
  -moz-appearance: textfield;
}
.alpha-value-input::-webkit-outer-spin-button,
.alpha-value-input::-webkit-inner-spin-button {
  -webkit-appearance: none;
  margin: 0;
}

.api-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 9px 0;
  font-size: 14px;
  border-bottom: 1px solid var(--divider);
}
.api-controls {
  display: flex;
  align-items: center;
  gap: 8px;
}
.api-input {
  width: 240px;
  padding: 6px 10px;
  border: 1px solid var(--divider);
  border-radius: 6px;
  background: var(--bg);
  color: var(--text-main);
  font-size: 13px;
  box-sizing: border-box;
}
.api-input:focus {
  outline: none;
  border-color: var(--primary);
}
.api-toggle {
  padding: 6px 12px;
  border: 1px solid var(--divider);
  border-radius: 6px;
  background: none;
  color: var(--text-sub);
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}
.api-toggle:hover {
  border-color: var(--primary);
  color: var(--primary);
}

.provider-btns, .model-btns {
  display: flex; flex-wrap: wrap; gap: 6px;
}
/* 模型行：标签占一行，按钮区占满宽度（按钮多了以后两列布局会挤成一堆） */
.api-row.stack {
  flex-direction: column;
  align-items: stretch;
  justify-content: flex-start;
  gap: 6px;
}
.api-row.stack > span {
  font-size: 13px;
  color: var(--text-sub);
}
/* 模型按钮：等宽两列，名字不截断（完整 ID 看 title） */
.model-btns {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
}
.model-btns .provider-btn {
  padding: 6px 8px;
  font-size: 11.5px;
  text-align: center;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.provider-btn {
  padding: 4px 10px; border-radius: 6px; font-size: 12px;
  border: 1px solid var(--divider); background: none;
  color: var(--text-main); cursor: pointer; transition: all 0.15s ease;
}
.provider-btn:hover { border-color: var(--primary); }
.provider-btn.active {
  border-color: var(--primary); color: var(--primary);
  background: color-mix(in srgb, var(--primary) 8%, transparent);
}
.api-hint {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--text-sub);
}

.mode-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.mode-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid var(--divider);
  border-radius: 8px;
  cursor: pointer;
  transition: border-color 0.2s;
}
.mode-item:hover {
  border-color: var(--text-sub);
}
.mode-item.active {
  border-color: var(--primary);
  background: var(--bg);
}
.mode-check {
  color: var(--primary);
  font-size: 13px;
  font-weight: 600;
}
.mode-name {
  font-weight: 500;
  flex: 1;
  text-align: left;
}
.mode-badge {
  font-size: 11px;
  color: var(--bg);
  background: var(--primary);
  padding: 2px 6px;
  border-radius: 4px;
}
.mode-actions {
  display: flex;
  gap: 6px;
}
.mode-btn {
  padding: 4px 10px;
  border: 1px solid var(--divider);
  border-radius: 6px;
  background: none;
  color: var(--text-sub);
  font-size: 12px;
  cursor: pointer;
}
.mode-btn:hover {
  border-color: var(--primary);
  color: var(--primary);
}
.mode-btn.danger:hover {
  border-color: #ff6b6b;
  color: #ff6b6b;
}
.mode-btn.primary {
  border-color: var(--primary);
  color: var(--primary);
}
.mode-add {
  margin-top: 8px;
  width: 100%;
  padding: 8px 0;
  border: 1px dashed var(--divider);
  border-radius: 8px;
  background: none;
  color: var(--text-sub);
  font-size: 13px;
  cursor: pointer;
}
.mode-add:hover {
  border-color: var(--primary);
  color: var(--primary);
}
.mode-form {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.mode-input {
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--divider);
  border-radius: 6px;
  background: var(--bg);
  color: var(--text-main);
  font-size: 13px;
  box-sizing: border-box;
}
.mode-input:focus {
  outline: none;
  border-color: var(--primary);
}
.mode-textarea {
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--divider);
  border-radius: 6px;
  background: var(--bg);
  color: var(--text-main);
  font-size: 13px;
  line-height: 1.6;
  box-sizing: border-box;
  resize: vertical;
  font-family: inherit;
}
.mode-textarea:focus {
  outline: none;
  border-color: var(--primary);
}
.mode-form-actions {
  display: flex;
  gap: 8px;
}
.mode-form-title {
  margin: 0;
  font-size: 13px;
  color: var(--text-sub);
}

.stale-wrap {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.stale-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 14px;
  border: 1px solid var(--divider);
  border-radius: 8px;
  background: var(--card);
}
.stale-text {
  font-size: 13px;
  color: var(--text-sub);
}
.stale-actions {
  display: flex;
  gap: 8px;
}
.regenerate-btn.secondary {
  border-color: var(--divider);
  color: var(--text-sub);
}
.regenerate-btn.secondary:hover {
  border-color: var(--primary);
  color: var(--primary);
  background: none;
}

.ai-mode-name {
  font-size: 13px;
  font-weight: normal;
  color: var(--text-sub);
}

.toggle-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 9px 0;
  font-size: 14px;
  border-bottom: 1px solid var(--divider);
}
.toggle-checkbox {
  width: 18px;
  height: 18px;
  accent-color: var(--primary);
  cursor: pointer;
}

.mode-selector-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  z-index: 300;
  display: flex;
  justify-content: center;
  align-items: center;
}
.mode-selector-panel {
  width: 80%;
  max-width: 420px;
  background: var(--card);
  border-radius: 14px;
  padding: 22px;
  box-sizing: border-box;
}
.mode-selector-panel .settings-header {
  margin-bottom: 12px;
}
.mode-selector-panel h4 {
  margin: 0;
  font-size: 15px;
}
.mode-selector-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 16px;
  max-height: 50vh;
  overflow-y: auto;
}
.mode-selector-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--divider);
  border-radius: 8px;
  color: var(--text-main);
  font-size: 14px;
  cursor: pointer;
  transition: border-color 0.2s;
}
.mode-selector-item:hover {
  border-color: var(--primary);
}
.mode-selector-item.active {
  border-color: var(--primary);
  background: var(--bg);
}
.mode-confirm {
  width: 100%;
  padding: 10px 0;
  font-size: 14px;
}
.mode-confirm:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.regenerate-btn {
  padding: 6px 14px;
  border: 1px solid var(--primary);
  border-radius: 6px;
  background: none;
  color: var(--primary);
  font-size: 13px;
  cursor: pointer;
  transition: all 0.2s;
}
.regenerate-btn:hover {
  background: var(--primary);
  color: var(--bg);
}

.font-size-options {
  display: flex;
  gap: 10px;
}
.font-size-options button {
  flex: 1;
  padding: 9px 0;
  border: 1px solid var(--divider);
  background: none;
  color: var(--text-main);
  border-radius: 8px;
  cursor: pointer;
  font-size: 14px;
  transition: all 0.2s;
}
.font-size-options button:hover { border-color: var(--primary); }
.font-size-options button.active {
  border-color: var(--primary);
  color: var(--primary);
}

/* ── 历史记录 ── */
.history-panel {
  max-height: 70vh;
  display: flex;
  flex-direction: column;
}
.history-panel .history-list {
  overflow-y: auto;
}
.history-count {
  font-size: 11px; color: var(--text-sub);
  background: var(--card); border-radius: 8px; padding: 1px 7px;
}
.history-list {
  display: flex; flex-direction: column; gap: 2px;
  overflow: hidden;
  animation: history-in 0.18s ease;
}
@keyframes history-in {
  from { opacity: 0; transform: translateY(-4px); }
  to { opacity: 1; transform: translateY(0); }
}
.history-date {
  font-size: 10.5px; color: var(--text-sub);
  padding: 8px 10px 3px; opacity: 0.75;
}
.history-item {
  display: flex; align-items: center; gap: 8px;
  padding: 7px 10px; border-radius: 8px; cursor: pointer;
  border-left: 2px solid transparent;
  transition: background 0.15s ease, border-color 0.15s ease;
}
.history-main { flex: 1; min-width: 0; }
.history-del {
  flex-shrink: 0;
  padding: 3px 8px; border-radius: 6px;
  border: 1px solid var(--divider);
  background: none; color: var(--text-sub);
  font-size: 11px; cursor: pointer;
  opacity: 0.65;
  transition: opacity 0.15s ease, border-color 0.15s ease, color 0.15s ease;
}
.history-del:hover {
  opacity: 1; border-color: #ff6b6b; color: #ff6b6b;
}
.history-del.confirming {
  opacity: 1; border-color: #ff6b6b; color: #ff6b6b;
  background: color-mix(in srgb, #ff6b6b 15%, transparent);
}
.history-item:hover { background: var(--card); }
.history-item.active {
  border-left-color: var(--primary);
  background: color-mix(in srgb, var(--primary) 10%, transparent);
}
.history-item.active .history-title { color: var(--primary); }
.history-title {
  font-size: 12.5px; color: var(--text-main);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.history-meta { font-size: 11px; color: var(--text-sub); margin-top: 2px; }
</style>

<!-- 非 scoped：作用于 html 的全局样式，隐藏主界面滚动条（保留滚动能力） -->
<style>
html::-webkit-scrollbar {
  display: none;
}
html {
  scrollbar-width: none;
}

/* 设置面板（卡片）滚动条也隐藏 */
.settings-panel::-webkit-scrollbar {
  display: none;
}
.settings-panel {
  scrollbar-width: none;
}

/* 历史弹层列表滚动条也隐藏 */
.history-panel .history-list::-webkit-scrollbar {
  display: none;
}
.history-panel .history-list {
  scrollbar-width: none;
}
</style>
