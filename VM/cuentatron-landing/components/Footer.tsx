import Image from 'next/image'
import { FiFacebook, FiInstagram } from 'react-icons/fi'

export const Footer = () => {
  return (
    <footer className="bg-gris-grafito text-gris-perla/80 py-16">
      <div className="container mx-auto max-w-6xl px-4">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-12">
          
          {/* Columna 1: Logo y Slogan */}
          <div className="md:col-span-2">
            <Image
              src="/1000291905.jpg" 
              alt="Logo Cuentatrón"
              width={180}
              height={45}
              className="brightness-0 invert" 
            />
            <p className="mt-4 text-sm max-w-xs">
              El control de tu energía.
            </p>
          </div>

          {/* Columna 2: Navegación */}
          <div>
            <h4 className="font-bold text-blanco mb-4">Navegación</h4>
            <ul className="space-y-2 text-sm">
              <li><a href="#beneficios" className="hover:text-blanco">Beneficios</a></li>
              <li><a href="#precio" className="hover:text-blanco">Precio</a></li>
              <li><a href="#faq" className="hover:text-blanco">FAQ</a></li>
            </ul>
          </div>

          {/* Columna 3: Legal y Social */}
          <div>
            <h4 className="font-bold text-blanco mb-4">Legal</h4>
            <ul className="space-y-2 text-sm">
              {/* Estos enlaces funcionarán en Fase 3 */}
              <li><a href="/terminos-venta" target="_blank" className="hover:text-blanco">Términos y Condiciones</a></li>
              <li><a href="/garantia" target="_blank" className="hover:text-blanco">Garantía</a></li>
              <li><a href="/privacidad-ecommerce" target="_blank" className="hover:text-blanco">Aviso de Privacidad</a></li>
            </ul>
            
            {/* --- CORRECCIÓN AQUÍ ---
              Añadimos URLs de ejemplo. Reemplaza "tu-pagina"
            */}
            <div className="flex space-x-4 mt-6">
              <a href="https://www.facebook.com/tu-pagina" target="_blank" rel="noopener noreferrer" className="text-xl hover:text-blanco"><FiFacebook /></a>
              <a href="https://www.instagram.com/tu-pagina" target="_blank" rel="noopener noreferrer" className="text-xl hover:text-blanco"><FiInstagram /></a>
            </div>
          </div>

        </div>

        {/* Copyright */}
        <div className="border-t border-gris-perla/20 mt-12 pt-8 text-center text-xs">
          <p>© 2025 Cuentatrón. Todos los derechos reservados.</p>
        </div>
      </div>
    </footer>
  )
}