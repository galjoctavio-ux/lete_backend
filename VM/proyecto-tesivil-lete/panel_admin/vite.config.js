import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],

  base: '/lete/panel/', 

  // ¡AÑADE ESTE BLOQUE!
  server: {
    host: 'localhost', // Sigue escuchando solo en localhost
    port: 5173,
    hmr: {
      host: 'www.tesivil.com',
      protocol: 'wss',
    },
    // Permite que NGINX (desde www.tesivil.com) nos envíe peticiones
    allowedHosts: [
      'www.tesivil.com'
    ]
  }
})
