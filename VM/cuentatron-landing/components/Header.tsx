'use client' // Necesario para hooks como useState y useEffect

import { useState, useEffect } from 'react'
import Image from 'next/image'
import { FiMenu } from 'react-icons/fi' // Importamos el ícono de hamburguesa

export const Header = () => {
  const [scrolled, setScrolled] = useState(false)

  useEffect(() => {
    // Esta función detecta si el usuario ha hecho scroll
    const handleScroll = () => {
      setScrolled(window.scrollY > 50) // Se vuelve opaco después de 50px de scroll
    }

    // Agregamos el "listener" cuando el componente se monta
    window.addEventListener('scroll', handleScroll)

    // Limpiamos el "listener" cuando el componente se desmonta
    return () => window.removeEventListener('scroll', handleScroll)
  }, [])

  const navItems = ['Beneficios', 'Cómo Funciona', 'Precio', 'FAQ']

  return (
    <header
      className={`fixed top-0 left-0 w-full z-50 transition-all duration-300 ${
        // Cambia el fondo basado en el estado 'scrolled'
        scrolled ? 'bg-blanco shadow-md' : 'bg-transparent'
      }`}
    >
      <nav className="container mx-auto max-w-6xl px-4 py-4 flex justify-between items-center">
        {/* Izquierda: Logo */}
        <div className="flex-shrink-0">
          {/* ¡IMPORTANTE! 
            Debes poner tu logo "1000291905.jpg" dentro de la carpeta "public" 
            que está en la raíz de tu proyecto.
          */}
          <Image
            src="/1000291905.png" // Busca la imagen en la carpeta /public
            alt="Logo Cuentatrón"
            width={160} // Ajusta el tamaño según tu logo
            height={40}
            priority // Carga el logo más rápido
          />
        </div>

        {/* Derecha (Desktop) */}
        <div className="hidden md:flex items-center space-x-6">
          {navItems.map((item) => (
            <a
              key={item}
              href={`#${item.toLowerCase().replace(' ', '-')}`} // Enlace de anclaje, ej: #como-funciona
              className="text-gris-grafito font-medium hover:text-azul-confianza transition-colors"
            >
              {item}
            </a>
          ))}
          <button className="bg-azul-confianza text-blanco font-medium px-5 py-2.5 rounded-lg transition-all duration-300 hover:brightness-90">
            Comprar Ahora
          </button>
        </div>

        {/* Derecha (Móvil) - Ícono de Hamburguesa */}
        <div className="md:hidden">
          <button className="text-gris-grafito text-3xl">
            <FiMenu />
          </button>
        </div>
      </nav>
    </header>
  )
}