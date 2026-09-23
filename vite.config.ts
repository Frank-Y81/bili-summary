import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import webExtension from 'vite-plugin-web-extension'

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue(), webExtension()],
  build: {
    // 默认不清输出目录：上一次构建删掉的文件会留在 dist/ 里，最后被打进 zip
    emptyOutDir: true
  }
})
