import Image from 'next/image'

// Sub-componente genérico para los bloques de beneficios
const BenefitBlock = ({
  title,
  text,
  imageUrl,
  reverse = false, // Prop para alternar el layout
}: {
  title: string
  text: string
  imageUrl: string
  reverse?: boolean
}) => (
  <div
    className={`grid grid-cols-1 md:grid-cols-2 gap-12 items-center py-12`}
  >
    {/* Columna de Texto */}
    <div className={`flex flex-col space-y-4 ${reverse ? 'md:order-last' : ''}`}>
      <h3 className="text-2xl md:text-3xl font-bold text-gris-grafito">
        {title}
      </h3>
      <p className="text-lg text-gris-grafito/90">{text}</p>
    </div>

    {/* Columna de Asset (Imagen) */}
    <div className="flex items-center justify-center">
      {/* PLACEHOLDER: Aquí van tus mockups de WhatsApp */}
      <div className="bg-blanco w-full max-w-md h-80 rounded-lg shadow-xl flex items-center justify-center text-gris-grafito/50">
        [PLACEHOLDER: {imageUrl}]
      </div>
    </div>
  </div>
)

export const BenefitsSection = () => {
  return (
    <section id="beneficios" className="py-20 md:py-28 bg-gris-perla">
      <div className="container mx-auto max-w-6xl px-4 divide-y divide-gris-grafito/10">

        {/* Bloque 1: Alerta DAC */}
        <BenefitBlock
          title="ANTICÍPATE A LA TARIFA DAC"
          text="Nuestro sistema vigila tu consumo acumulado. Si detecta que tu ritmo te hará saltar a la Tarifa DAC, te enviamos una alerta 🟡 *antes* de que suceda, dándote tiempo para moderar tu consumo."
          imageUrl="mockup-alerta-dac.png"
        />

        {/* Bloque 2: Reporte Diario */}
        <BenefitBlock
          title="TU REPORTE DIARIO DE AHORRO"
          text="Recibe cada mañana un reporte simple por WhatsApp. 'Ayer gastaste $23.50 MXN. Vas 10% por debajo de tu promedio'. Información accionable, no solo datos."
          imageUrl="mockup-reporte-diario.png"
          reverse={true} // <-- Aquí alternamos el orden
        />

        {/* Bloque 3: Detección de Fugas */}
        <BenefitBlock
          title="DETECTA FUGAS Y FALLAS"
          text="¿Un refrigerador fallando? ¿Una fuga a tierra peligrosa? Nuestro sistema detecta patrones anómalos (como picos de voltaje o consumo fantasma) y te alerta 🔴 para proteger tus aparatos y tu seguridad."
          imageUrl="mockup-alerta-fuga.png"
        />

      </div>
    </section>
  )
}