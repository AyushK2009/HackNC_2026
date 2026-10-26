import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Local backend (FastAPI, server/main.py).
    proxy: { '/api': 'http://localhost:8000' },
  },
})
