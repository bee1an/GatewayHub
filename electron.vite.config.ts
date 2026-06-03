import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import UnoCSS from 'unocss/vite'

export default defineConfig({
  main: {
    build: {
      // CLI 入口会被作为 extraResource 单独复制到 resources/cli。
      // 这些运行时依赖必须内联进 cli/chunks，否则 release 包里的 system node 找不到
      // app.asar 内部的 node_modules。
      externalizeDeps: { exclude: ['cac', 'picocolors', 'proper-lockfile', 'undici'] },
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          cli: resolve('src/cli/index.ts'),
          gptWebWorker: resolve('src/cli/gptWebWorkerEntry.ts')
        },
        output: {
          format: 'cjs',
          entryFileNames: '[name].js',
          banner: (chunk) => (chunk.name === 'cli' ? '#!/usr/bin/env node' : '')
        }
      }
    }
  },
  preload: {},
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [UnoCSS(), react()]
  }
})
