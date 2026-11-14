import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  // GitHub Pages serves the site from /<repo-name>/, so the deploy workflow sets VITE_BASE.
  base: process.env.VITE_BASE || '/',
  plugins: [react()],
  // Pre-bundle Transformers.js at dev-server start. Without this, Vite discovers it
  // lazily when the embedding worker first imports it and force-reloads the page,
  // which kills an in-progress upload.
  optimizeDeps: {
    include: ['@huggingface/transformers'],
  },
  worker: {
    format: 'es',
  },
})
