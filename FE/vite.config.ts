import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const apiTarget = env.VITE_API_URL || 'http://localhost:7070'

  return {
    plugins: [react()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    server: {
      port: 5173,
      proxy: {
        '/api': {
          target: apiTarget,
          changeOrigin: true,
        },
      },
    },
    build: {
      rollupOptions: {
        output: {
          manualChunks: {
            react:       ['react', 'react-dom', 'react-router-dom'],
            query:       ['@tanstack/react-query'],
            codemirror:  ['@uiw/react-codemirror', '@codemirror/lang-python', '@codemirror/theme-one-dark'],
            charts:      ['lightweight-charts', 'chart.js', 'react-chartjs-2'],
          },
        },
      },
    },
  }
})
