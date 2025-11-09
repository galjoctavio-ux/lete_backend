import { Inter } from 'next/font/google';
import './globals.css';

// Cargamos las variantes de peso que pide el brief
const inter = Inter({ 
  subsets: ['latin'], 
  display: 'swap', 
  weight: ['400', '500', '700'] // Regular, Medium, Bold
});

export const metadata = {
  title: 'Cuentatrón - Diagnóstico Energético Especial',
  description: 'Identifica y elimina el "consumo fantasma". Diagnóstico de 7 días analizado por un Ingeniero.',
};

export default function RootLayout({ children }) {
  return (
    <html lang="es">
      {/* Aplicamos la fuente a todo el sitio */}
      <body className={inter.className}>{children}</body>
    </html>
  );
}