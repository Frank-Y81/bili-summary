// === 字幕获取 ===

import { MSG_GET_SUBTITLE_INFO } from './messages'

import { STORAGE_KEYS } from './storage-keys'

// 注入inject.js（进入页面主世界，拦截播放器请求）
const script = document.createElement('script')
script.src = chrome.runtime.getURL('inject.js')
script.onload = () => script.remove()
document.documentElement.appendChild(script)

// 监听 inject.js 传来的消息，转发给 background
window.addEventListener('message', (event) => {
  if(event.source !== window) return

  // 播放器响应 → 交给 background 处理（cid 判断 + 抓字幕）
  if(event.data?.type === 'BILI_SUB_INTERCEPT') {
    const { url, data } = event.data.playload
    chrome.runtime.sendMessage({ type: MSG_GET_SUBTITLE_INFO, url, data })
  }

  // 当前视频信息（cid/title/desc 同源同步更新）
  if(event.data?.type === 'BILI_VIDEO_INFO') {
    const { cid, title, desc, owner } = event.data.playload
    chrome.storage.local.set({
      [STORAGE_KEYS.videoTitle]: title,
      [STORAGE_KEYS.videoDesc]: desc,
      [STORAGE_KEYS.videoOwner]: owner,
      [STORAGE_KEYS.videoTitleId]: cid
    })
  }
})
