import { FiBox, FiWifi, FiCheckCircle } from 'react-icons/fi'

// Sub-componente para las tarjetas de pasos
const StepCard = ({ icon, title, text }: { icon: React.ReactNode, title: string, text: string }) => (
  <div className="flex flex-col items-center text-center">
    {/* Círculo con el ícono */}
    <div className="flex items-center justify-center w-16 h-16 bg-azul-confianza/10 rounded-full mb-4">
      {icon}
    </div>
    <h3 className="text-xl font-bold text-gris-grafito mb-2">{title}</h3>
    <p className="text-gris-grafito/90">{text}</p>
  </div>
)

export const HowItWorksSection = () => {
  return (
    <section id="como-funciona" className="py-20 md:py-28 bg-blanco">
      <div className="container mx-auto max-w-6xl px-4">

        {/* Título Centrado */}
        <div className="text-center max-w-3xl mx-auto mb-16">
          <h2 className="text-3xl md:text-4xl font-bold text-gris-grafito">
            Empezar a ahorrar es así de simple.
          </h2>
        </div>

        {/* Grid de 3 Columnas (Los Pasos) */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-12">

          <StepCard
            icon={<FiBox className="text-azul-confianza text-3xl" />}
            title="1. Recibe e Instala"
            text="Te enviamos tu Cuentatrón. Instalación sencilla."
          />

          <StepCard
            icon={<FiWifi className="text-azul-confianza text-3xl" />}
            title="2. Conecta a tu WiFi"
            text="Siguiendo 3 simples pasos, conectas el dispositivo a tu red de internet. ¡No necesitas ser un experto!"
          />

          <StepCard
            icon={<FiCheckCircle className="text-azul-confianza text-3xl" />}
            title="3. ¡Listo! Recibe Alertas"
            text="Automáticamente, empezamos a monitorear y a enviarte tus reportes diarios y alertas preventivas por WhatsApp."
          />

        </div>
      </div>
    </section>
  )
}