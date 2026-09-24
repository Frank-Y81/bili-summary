# B站视频 AI 总结（Chrome 侧边栏插件）

在 B站视频页按 `Ctrl+K` 呼出侧边栏，自动取当前播放视频的字幕 + 标题/简介/UP主，调用**你自己配置的**模型生成总结。支持流式输出、自定义总结模式、历史记录。


## 构建与安装

```bash
# 以下命令都在插件根目录执行（本工作区里是 core/；独立仓库里就是仓库根）
npm install
npm run build          # = vue-tsc -b && vite build（类型不过就不出包）
npm run pack           # 构建 + 打包成 release/bilibili-summary-v<版本>.zip
```

`npm run pack` 会先做两条检查，不过就不出包：

1. `manifest.json` 与 `package.json` 的版本号必须一致（**版本号以 `manifest.json` 为准**，改版本时两个都改）
2. `dist/` 里不允许出现形如 `sk-xxxxxxxx` 的明文密钥

打包出来的 zip 根层就是扩展本体，解压后直接「加载已解压的扩展程序」。

在 Chrome 里加载：

1. 打开 `chrome://extensions` → 右上角开「开发者模式」
2. 「加载已解压的扩展程序」→ 选 `dist` 文件夹
3. 按 `Ctrl+K` 呼出侧边栏（改键：`chrome://extensions/shortcuts`）

**改完代码后**：`npm run build` → 回 `chrome://extensions` 点刷新图标。**改过 `manifest.json` 必须刷新**（重开侧边栏不够）。

## 首次使用：配一家厂商

插件**不预置任何厂商和模型**，第一次用要去面板里加：

1. 侧边栏右上角 `⚙` → 「厂商管理」→ 「+ 新增厂商」
2. **接口地址填到 `/v1` 那一层**，编辑器里有「实际请求：…」实时预览，照着看就不会填错。常用值（仅供参考，具体看对应的官方文档）：

   | 平台 | 接口地址 |
   |---|---|
   | 阿里云百炼 | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
   | DeepSeek 官方 | `https://api.deepseek.com` |
   | 智谱官方 | `https://open.bigmodel.cn/api/paas/v4` |
   | 本地模型（Ollama 等） | `http://localhost:11434/v1` |

3. **模型名每行一个**，必须是接口认的 ID（不是界面上的叫法）。例：百炼上 `qwen3.7-plus`、`deepseek-v4-flash`、`ZHIPU/GLM-5.3-Flash`
4. 填 API Key（输入框可点「显示」核对）
5. 点 **「授权访问」**，Chrome 会弹窗问该域名的权限 → 允许。
   **不授权就发不出请求**（会报「请求发不出去」）。域名权限是运行时按你填的地址申请的，不是安装时一次性全给
6. 回设置面板选厂商 + 选模型 → 回侧边栏点生成

## 数据存在哪

全部在 `chrome.storage.local`，键名唯一出处是 [`src/storage-keys.ts`](src/storage-keys.ts)：

| 键 | 内容 |
|---|---|
| `providerConfigs` | 厂商配置（**含 key 明文**） |
| `summaryRecords` | 历史记录（上限 20 条） |
| `promptModes` / `activeModeId` | 自定义总结模式与当前模式 |
| `activeProviderId` / `providerSetting` | 当前厂商与每家选的模型 |
| `theme` / `fontSize` / `autoSummarize` | 外观与行为设置 |
| `videoId` / `videoTitle` / `videoSubtitle` / `subtitleStatus` | 当前视频的临时状态 |

key 明文躺在浏览器本地存储里：**不进 git、不进构建产物，也不加密**。所以不要改用 `storage.sync`（会跟着浏览器账号飘）。

## 功能与实现要点

- **字幕**：`inject.js` 注入页面主世界 hook `fetch`/XHR，**偷看播放器自己请求的字幕**（绕开 CORS 与登录态）；用「当前播放器的 cid」而不是页面第一个 cid，避免抓到别的视频
- **单一数据源**：每个字段只有一个权威写入口（标题/简介 → content；cid/字幕/总结 → background；设置 → 面板），storage 变化统一广播
- **流式输出**：请求带 `stream: true`，按行缓冲解析 SSE（`data:` 帧边界与网络块边界无关），生成走 **Port 长连接**（`sendResponse` 只能回一次，推不了流）；期间每 20 秒戳一次扩展 API，防 service worker 空闲被回收
- **厂商抽象**：`ProviderConfig`（数据，存 storage）与 `ProviderCard`（带 `generate` 的运行时编译产物）分开；换厂商不影响历史记录
- **中断与重新生成**：生成中点「停止」会沿长连接发一帧取消，后台真 `abort()` 掉 fetch（停在此处、不再计费、不落盘）；「重新生成」= 中断旧请求后立刻开新一轮（关面板不中断，后台照旧跑完并落盘）
- **连接测试**：厂商列表每行一个「测试」（正在用的那家跟着界面上选中的模型走，其余用第一个模型），编辑表单里再一个（测表单里还没保存的值）；真发一条 `max_tokens: 16` 的最小请求，把「地址 + key + 域名授权 + 模型名」一次拆开验
- **历史记录**：右上角「历史」弹层；点某条查看，顶部会出现 `← 当前视频` 回去。删除是两段确认

## 已知限制

- 只支持 B站；视频没有字幕会明确提示
- 只支持 **OpenAI 兼容**形状的接口（`POST {baseUrl}/chat/completions`）；非兼容的厂商要改代码
- **长字幕没有切段**：特别长的视频可能顶到模型上下文上限，直接失败
