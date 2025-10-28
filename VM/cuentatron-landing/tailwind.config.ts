import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      // Aquí definimos tu manual de identidad
      fontFamily: {
        // Define 'Inter' como la fuente principal
        sans: ['Inter', 'sans-serif'],
      },
      colors: {
        // Tu paleta de colores del brief
        'azul-confianza': '#007AFF',
        'verde-ahorro': '#9BEA00',
        'gris-grafito': '#333333',
        'gris-perla': '#F5F7FA',
        'blanco': '#FFFFFF',
        // Colores de alerta
        'alerta-ambar': '#FFC107',
        'alerta-rojo': '#DC3545',
      },
    },
  },
  plugins: [],
}
export default config