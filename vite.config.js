import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: './', // 关键：使用相对路径，否则在 Flutter assets 中可能找不到资源
  build: {
    outDir: 'dist',
    assetsDir: 'assets', // 资源放在 assets 目录下
    rollupOptions: {
      output: {
        // 强制 JS 和 CSS 文件名固定
        entryFileNames: 'assets/desk-pet.js',
        chunkFileNames: 'assets/desk-pet-[name].js',
        assetFileNames: 'assets/[name].[ext]'
      }
    }
  }
})
