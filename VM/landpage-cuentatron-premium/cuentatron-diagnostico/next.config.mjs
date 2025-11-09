/** @type {import('next').NextConfig} */
const nextConfig = {
  // Esta es la configuración clave para tu entorno
  basePath: '/cuentatron/diagnostico-personalizado',

  // Optimizamos la salida para PM2/Nginx
  output: 'standalone', 
};

export default nextConfig;