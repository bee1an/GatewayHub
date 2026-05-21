import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import UnoCSS from 'unocss/vite'

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          cli: resolve('src/cli/index.ts')
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
