// 打包可归档的 zip：release/bilibili-summary-v<version>.zip
// 用法：npm run pack（会先跑一遍 build）
//
// 前置检查两条，都是故意的：
//   1. manifest 与 package.json 版本号必须一致 —— 否则打出来的包说不清是哪个版本
//   2. dist 里不许出现形如 sk-xxxxxxxx 的明文密钥 —— 构建产物是要往外发的东西
//
// 两个注意事项（踩过）：
//   · 不把 dist 先复制到临时目录再打包：Node 24 在 Windows 上对带中文的源路径做
//     cpSync(recursive) 会**原生崩溃**（无输出、退出码 127），不是能用 try/catch 兜住的错
//   · 给 PowerShell 传相对路径、并把 cwd 钉在项目根：绝对路径里带中文，过命令行编码容易出岔子
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'dist')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'))

if (!existsSync(join(root, 'dist', 'manifest.json'))) {
  console.error('dist/ 里没有 manifest.json —— 用 npm run pack（它会先 build），别直接跑这个脚本')
  process.exit(1)
}

if (pkg.version !== manifest.version) {
  console.error(`版本号不一致：manifest.json = ${manifest.version}，package.json = ${pkg.version}`)
  console.error('扩展的版本号以 manifest.json 为准，两个文件改成一样再打包')
  process.exit(1)
}

// 明文密钥扫描（尽力而为：只认 sk- 开头的长串；智谱那种 `id.secret` 形式的 key 扫不出来）
const keyLike = /sk-[A-Za-z0-9_-]{20,}/g
const hits = []
const walk = dir => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full)
    else if (/\.(js|json|html|css|svg|ts)$/.test(entry)) {
      const found = readFileSync(full, 'utf8').match(keyLike)
      if (found) hits.push(`${entry} → ${found[0].slice(0, 12)}…`)
    }
  }
}
walk(dist)
if (hits.length) {
  console.error('dist/ 里发现疑似明文密钥，已中止打包：')
  hits.forEach(h => console.error('  ' + h))
  process.exit(1)
}

const outDir = join(root, 'release')
const fileName = `bilibili-summary-v${manifest.version}.zip`
mkdirSync(outDir, { recursive: true })
rmSync(join(outDir, fileName), { force: true })

// zip 根目录必须是扩展本体（Chrome 从 zip 加载时直接读根），所以用 `dist\*` 这个通配
if (process.platform === 'win32') {
  execFileSync('powershell', [
    '-NoProfile', '-Command',
    `Compress-Archive -Path 'dist\\*' -DestinationPath 'release\\${fileName}' -Force`
  ], { cwd: root, stdio: 'inherit' })
} else {
  execFileSync('zip', ['-qr', join('..', 'release', fileName), '.'], { cwd: dist, stdio: 'inherit' })
}

const zipPath = join(outDir, fileName)
if (!existsSync(zipPath)) {
  console.error('打包命令跑完了，但没看到 zip —— 看上面的报错')
  process.exit(1)
}

console.log(`\n已打包：${zipPath}（${(statSync(zipPath).size / 1024).toFixed(0)} KB）`)
console.log('装法：解压 → chrome://extensions → 开发者模式 → 加载已解压的扩展程序 → 选解压出来的文件夹')