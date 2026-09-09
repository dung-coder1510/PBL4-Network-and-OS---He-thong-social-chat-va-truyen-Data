import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
})
export default defineConfig({
    // ...plugins
    server: {
        proxy: {
            '/api': {
                target: 'https://localhost:7102', // Đổi thành port của ASP.NET API
                changeOrigin: true,
                secure: false,
            }
        }
    }
})