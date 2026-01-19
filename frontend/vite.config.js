import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Your source files use JSX but are named .js (index.js, App.js, ThreeMap.js).
  // Tell Vite/Esbuild to parse src/**/*.js as JSX.
  esbuild: {
    loader: 'jsx',
    include: /src\/.*\.js$/,
  },
  // fsevents is macOS-only; Netlify builds on Linux.
  build: {
    rollupOptions: {
      external: ['fsevents'],
    },
  },
})
