'use client' // Necesario para el hook useState

import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { FiChevronDown } from 'react-icons/fi'

// Lista de preguntas y respuestas
const faqs = [
  {
    q: '¿Cuentatrón reemplaza mi medidor de CFE?',
    r: 'No. Tu medidor de CFE sigue siendo el oficial. Cuentatrón es tu asesor personal que se instala en paralelo para darte los datos en tiempo real y prevenir "sustos".',
  },
  {
    q: '¿Es legal? ¿Tendré problemas con CFE?',
    r: 'Es 100% legal. El dispositivo se instala después del medidor de CFE (en tu centro de carga). No modificamos ni tocamos la instalación de CFE.',
  },
  {
    q: '¿La instalación es difícil?',
    r: 'Recomendamos que la instalación la realice un electricista certificado. Es un proceso rápido (menos de 30 min) y seguro. Podemos ponerte en contacto con nuestra red de aliados.',
  },
  {
    q: '¿Qué pasa si cancelo mi suscripción mensual?',
    r: 'El dispositivo de hardware es tuyo para siempre. Podrás seguir viendo tu consumo en tiempo real en su pantalla. Sin embargo, perderás el servicio de alertas por WhatsApp, la detección de fugas, los reportes y el monitoreo inteligente.',
  },
]

// --- Sub-componente para cada item del Acordeón ---
const AccordionItem = ({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) => {
  const [isOpen, setIsOpen] = useState(false)

  return (
    <div className="border-b border-gris-grafito/10">
      {/* El botón que es la pregunta */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex justify-between items-center py-5 text-left"
      >
        <span className="text-lg font-medium text-gris-grafito">{title}</span>
        <FiChevronDown
          className={`text-azul-confianza text-xl transition-transform duration-300 ${
            isOpen ? 'rotate-180' : '' // Gira la flecha
          }`}
        />
      </button>

      {/* La respuesta (animada) */}
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.3 }}
            className="overflow-hidden"
          >
            <p className="pb-5 text-gris-grafito/90">{children}</p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
// --- Fin del sub-componente ---


// --- Componente Principal de la Sección FAQ ---
export const FAQSection = () => {
  return (
    <section id="faq" className="py-20 md:py-28 bg-blanco">
      <div className="container mx-auto max-w-3xl px-4">

        {/* Título Centrado */}
        <div className="text-center max-w-3xl mx-auto mb-12">
          <h2 className="text-3xl md:text-4xl font-bold text-gris-grafito">
            ¿Aún tienes dudas?
          </h2>
          <p className="text-lg text-gris-grafito/90 mt-4">
            Respuestas claras a tus preguntas más frecuentes.
          </p>
        </div>

        {/* Lista de Acordeones */}
        <div className="w-full">
          {faqs.map((faq, i) => (
            <AccordionItem key={i} title={faq.q}>
              {faq.r}
            </AccordionItem>
          ))}
        </div>

      </div>
    </section>
  )
}