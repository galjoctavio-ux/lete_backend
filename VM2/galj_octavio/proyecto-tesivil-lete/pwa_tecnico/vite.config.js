import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
// 1. Importar el plugin
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),

    // 2. Añadir el plugin con su configuración
    VitePWA({
      // registerType: 'autoUpdate', // Opcional: actualiza la PWA automáticamente
      manifest: {
        name: 'Tesivil Reportes',
        short_name: 'Reportes',
        description: 'App de reportes de diagnóstico eléctrico.',
        theme_color: '#ffffff',
        icons: [
          {
            src: 'pwa-192x192.png', // Necesitaremos crear este ícono
            sizes: '192x192',
            type: 'image/png'
          },
          {
            src: 'pwa-512x512.png', // Y este
            sizes: '512x512',
            type: 'image/png'
          }
        ]
      }
    })
  ],

  base: '/lete/app/', 

  server: {
    port: 5174,
    host: 'localhost',
    hmr: {
      host: 'www.tesivil.com',
      protocol: 'wss',
    },
    allowedHosts: ['www.tesivil.com']
  }
})
