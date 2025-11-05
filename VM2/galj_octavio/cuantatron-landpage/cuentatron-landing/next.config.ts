import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // 1. El prefijo de tu aplicación
  basePath: '/cuentatron',
  assetPrefix: '/cuentatron',

  // 2. La corrección para la diagonal al final
  trailingSlash: true,

  reactStrictMode: true,
  images: {
    unoptimized: true,
  },

  // 3. Tu corrección para el warning de lockfile
  outputFileTracingRoot: '/home/galj_octavio/cuantatron-landpage/cuentatron-landing',
};

// 4. La sintaxis de exportación CORRECTA para un archivo .ts
export default nextConfig;
