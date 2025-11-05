'use client' 

import { useState, useEffect } from 'react'
import Image from 'next/image'
import { FiMenu } from 'react-icons/fi' 

export const Header = () => {
  const [scrolled, setScrolled] = useState(false)

  useEffect(() => {
    const handleScroll = () => {
      setScrolled(window.scrollY > 50) 
    }
    window.addEventListener('scroll', handleScroll)
    return () => window.removeEventListener('scroll', handleScroll)
  }, [])

  // --- CORRECCIÓN AQUÍ ---
  // Quité la tilde de "Como Funciona" para que coincida con el id="como-funciona"
  const navItems = ['Beneficios', 'Como Funciona', 'Precio', 'FAQ']

  return (
    <header
      className={`fixed top-0 left-0 w-full z-50 transition-all duration-300 ${
        scrolled ? 'bg-blanco shadow-md' : 'bg-transparent'
      }`}
    >
      <nav className="container mx-auto max-w-6xl px-4 py-4 flex justify-between items-center">
        {/* Izquierda: Logo */}
        <div className="flex-shrink-0">
          <Image
            src="/1000291905.jpg" 
            alt="Logo Cuentatrón"
            width={160} 
            height={40}
            priority 
          />
        </div>

        {/* Derecha (Desktop) */}
        <div className="hidden md:flex items-center space-x-6">
          {navItems.map((item) => (
            <a
              key={item}
              href={`#${item.toLowerCase().replace(' ', '-')}`} // Ahora genera #como-funciona
              className="text-gris-grafito font-medium hover:text-azul-confianza transition-colors"
            >
              {item}
            </a>
          ))}
          
          {/* --- CORRECCIÓN AQUÍ ---
            Cambiamos <button> por <a> para que sea un enlace de anclaje
          */}
          <a
            href="#precio"
            className="bg-azul-confianza text-blanco font-medium px-5 py-2.5 rounded-lg transition-all duration-300 hover:brightness-90"
          >
            Comprar Ahora
          </a>
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