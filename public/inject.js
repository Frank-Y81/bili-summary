const originalFetch = window.fetch

// === 持续监听当前视频信息（cid/title/desc/owner 同源同步）===
;(function watchVideoInfo() {
  let lastCid = null

  const send = () => {
    const videoData = window.__INITIAL_STATE__?.videoData
    const cid = videoData?.cid
    if (cid == null || cid === lastCid) return

    lastCid = cid
    window.postMessage({
      type: 'BILI_VIDEO_INFO',
      playload: {
        cid,
        title: videoData.title ?? '',
        desc: videoData.desc ?? '',
        owner: videoData.owner?.name ?? ''
      }
    }, '*')
  }

  send()                 // 页面加载时立即发一次
  setInterval(send, 500) // 持续监听：切换视频时 cid 变化 → 再发
})()

// 统一转发字幕拦截消息
function forwardSubtitleIntercept(url, data) {
  window.postMessage({
    type: 'BILI_SUB_INTERCEPT',
    playload: {url, data}
  }, '*')
}

// 延迟确认：区分"悬停预加载"和"切换后新视频响应"
const pendingChecks = new Map()

function confirmThenForward(url, data) {
  const responseCid = data?.data?.cid
  const pageCid = window.__INITIAL_STATE__?.videoData?.cid

  // 无 cid（字幕文件响应）或 cid 一致：立即转发
  if (responseCid == null || String(responseCid) === String(pageCid)) {
    forwardSubtitleIntercept(url, data)
    return
  }

  // cid 不一致：可能是悬停预加载，也可能是切换后页面状态还没更新。
  // 等 800ms 再看页面状态是否跟上。
  const prev = pendingChecks.get(responseCid)
  if (prev) clearTimeout(prev.timer)

  const timer = setTimeout(() => {
    pendingChecks.delete(responseCid)
    const nowCid = window.__INITIAL_STATE__?.videoData?.cid
    if (String(nowCid) === String(responseCid)) {
      forwardSubtitleIntercept(url, data)
    }
  }, 800)

  pendingChecks.set(responseCid, { timer })
}

// fetch hook
window.fetch = async function(...args) {
  const response = await originalFetch.apply(this, args)
  const url = response.url
  if(url.includes('player/wbi/v2') || url.includes('aisubtitle.hdslb.com')) {
    const clone = response.clone()
    clone.json().then(data => {
      confirmThenForward(url, data)
    }).catch(()=>{})
  }
  return response
}

// XHR hook（播放器可能用 XHR 加载字幕）
const XHR = XMLHttpRequest.prototype
const xhrOpen = XHR.open
const xhrSend = XHR.send
XHR.open = function(method, url) {
  this._url = url
  return xhrOpen.apply(this, arguments)
}
XHR.send = function(...args) {
  this.addEventListener('load', () => {
    const url = this._url
    if (url && (url.includes('player/wbi/v2') || url.includes('aisubtitle.hdslb.com'))) {
      try {
        const data = JSON.parse(this.responseText)
        confirmThenForward(url, data)
      } catch (e) {}
    }
  })
  return xhrSend.apply(this, args)
}
