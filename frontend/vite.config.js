import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    strictPort: true,
    proxy: {
      '/api': {
        target: 'https://localhost:7117',
        changeOrigin: true,
        secure: false,
      },
      '/hubs': {
        target: 'https://localhost:7117',
        changeOrigin: true,
        secure: false,
        ws: true,
      },
    },
  },
})
