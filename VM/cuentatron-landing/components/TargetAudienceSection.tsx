'use client' // ¡Muy importante! Indica que es un Componente de Cliente

import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { FiHome, FiShoppingBag } from 'react-icons/fi'

type Audience = 'hogar' | 'negocio'

export const TargetAudienceSection = () => {
  // Hook de Estado para saber qué botón está activo
  const [audience, setAudience] = useState<Audience>('hogar')

  const content = {
    hogar: {
      icon: <FiHome className="text-3xl text-azul-confianza" />,
      text: 'Duerme tranquilo sabiendo que tu familia está protegida de fugas. Evita los "sustos" del recibo y mantén tus finanzas familiares bajo control. Ideal para prevenir la Tarifa DAC.',
    },
    negocio: {
      icon: <FiShoppingBag className="text-3xl text-azul-confianza" />,
      text: 'Optimiza tu Tarifa PDBT. Monitorea el consumo de tus refrigeradores y aires acondicionados. Asegura que tu inversión en Paneles Solares esté generando el ahorro prometido.',
    },
  }

  return (
    <section id="audiencia" className="py-20 md:py-28 bg-blanco">
      <div className="container mx-auto max-w-3xl px-4 flex flex-col items-center">

        {/* Título Centrado */}
        <div className="text-center mb-12">
          <h2 className="text-3xl md:text-4xl font-bold text-gris-grafito">
            Diseñado para tu tranquilidad.
          </h2>
        </div>

        {/* Toggle Switch (El interruptor) */}
        <div className="flex bg-gris-perla p-1 rounded-lg mb-12">
          <button
            onClick={() => setAudience('hogar')}
            className={`px-6 py-2.5 rounded-md font-medium transition-all ${
              audience === 'hogar'
                ? 'bg-blanco shadow text-azul-confianza'
                : 'text-gris-grafito/70'
            }`}
          >
            Para mi Hogar
          </button>
          <button
            onClick={() => setAudience('negocio')}
            className={`px-6 py-2.5 rounded-md font-medium transition-all ${
              audience === 'negocio'
                ? 'bg-blanco shadow text-azul-confianza'
                : 'text-gris-grafito/70'
            }`}
          >
            Para mi Negocio
          </button>
        </div>

        {/* Contenido Dinámico (Con Animación) */}
        <AnimatePresence mode="wait">
          <motion.div
            key={audience} // Esto le dice a AnimatePresence que el contenido cambió
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.3 }}
            className="flex flex-col md:flex-row items-center text-center md:text-left space-y-4 md:space-y-0 md:space-x-6"
          >
            {/* Mostramos el ícono y texto del estado seleccionado */}
            {content[audience].icon}
            <p className="text-lg text-gris-grafito/90">
              {content[audience].text}
            </p>
          </motion.div>
        </AnimatePresence>

      </div>
    </section>
  )
}