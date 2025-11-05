import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],

  // 1. Ruta base para el despliegue
  base: '/lete/app/', 

  // 2. Configuración del servidor de desarrollo
  server: {
    port: 5174, // ¡Puerto diferente!
    host: 'localhost',
    hmr: {
      host: 'www.tesivil.com',
      protocol: 'wss',
    },
    // Permitir que NGINX nos envíe peticiones
    allowedHosts: [
      'www.tesivil.com'
    ]
  }
})
