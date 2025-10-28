import { FiAlertTriangle, FiZap, FiScissors } from 'react-icons/fi'

// Sub-componente para las tarjetas de problemas (para no repetir código)
const ProblemCard = ({ icon, title, text }: { icon: React.ReactNode, title: string, text: string }) => (
  <div className="bg-blanco p-6 rounded-lg shadow-sm text-center md:text-left">
    <div className="flex justify-center md:justify-start">
      {icon}
    </div>
    <h3 className="text-xl font-bold text-gris-grafito mt-4 mb-2">{title}</h3>
    <p className="text-gris-grafito/90">{text}</p>
  </div>
)

export const ProblemSection = () => {
  return (
    <section id="problema" className="py-20 md:py-28 bg-blanco">
      <div className="container mx-auto max-w-6xl px-4">

        {/* Título Centrado */}
        <div className="text-center max-w-3xl mx-auto mb-16">
          <h2 className="text-3xl md:text-4xl font-bold text-gris-grafito">
            ¿Vives con miedo al "susto" de CFE?
          </h2>
          <p className="text-lg text-gris-grafito/90 mt-4">
            El recibo de CFE es una caja negra. Cuando llega el cobro, ya es
            demasiado tarde.
          </p>
        </div>

        {/* Grid de 3 Columnas (Los "Dolores") */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">

          <ProblemCard
            icon={<FiAlertTriangle className="text-alerta-ambar text-4xl" />}
            title="Tarifa DAC Inesperada"
            text="Pagas 200% más por el mismo kWh solo por pasarte un poco de tu límite. Sin previo aviso."
          />

          <ProblemCard
            icon={<FiZap className="text-azul-confianza text-4xl" />}
            title="Fugas y 'Vampiros'"
            text="Instalaciones viejas o aparatos en standby que 'chupan' energía 24/7 y que no puedes ver."
          />

          <ProblemCard
            icon={<FiScissors className="text-gris-grafito text-4xl" />}
            title="Cortes por Sorpresa"
            text="Te quedas sin luz en el peor momento porque el recibo llegó alto y se te olvidó pagarlo."
          />

        </div>
      </div>
    </section>
  )
}