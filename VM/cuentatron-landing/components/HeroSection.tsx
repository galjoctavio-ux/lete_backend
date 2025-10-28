import Image from 'next/image' 

export const HeroSection = () => {
  return (
    <section
      id="hero"
      className="bg-gris-perla pt-32 pb-20 md:pt-40 md:pb-28"
    >
      <div className="container mx-auto max-w-6xl px-4 grid grid-cols-1 md:grid-cols-2 gap-12 items-center">
        
        {/* Izquierda: Contenido (El Gancho) */}
        <div className="flex flex-col space-y-6 text-center md:text-left">
          <span className="font-medium text-azul-confianza">
            ⚡ Cuentatrón: El control de tu energía.
          </span>
          <h1 className="text-4xl md:text-5xl font-bold text-gris-grafito leading-tight">
            Deja de adivinar tu recibo de CFE.
          </h1>
          <p className="text-lg text-gris-grafito">
            Tu asesor energético personal. Te alertamos por WhatsApp antes de que
            caigas en Tarifa DAC y te ayudamos a detectar fugas.
          </p>

          {/* Botón CTA Principal (El más importante) */}
          <div className="flex flex-col items-center md:items-start pt-4">
            
            {/* --- CORRECCIÓN AQUÍ ---
              Cambiamos <button> por <a> para que sea un enlace de anclaje
            */}
            <a
              href="#precio"
              className="bg-verde-ahorro text-gris-grafito font-bold text-lg px-10 py-4 rounded-lg transition-all duration-300 hover:brightness-95 shadow-lg"
            >
              SÍ, QUIERO MI MES GRATIS
            </a>
            <span className="text-sm text-gris-grafito mt-3">
              Compra tu dispositivo y obtén 1 mes de alertas gratis.
            </span>
          </div>
        </div>

        {/* Derecha: Visual (Mockup) */}
        <div className="flex items-center justify-center">
          <div className="bg-blanco w-full h-80 md:h-96 rounded-lg shadow-xl flex items-center justify-center text-gris-grafito/50">
            [PLACEHOLDER: hero-visual.png]
          </div>
        </div>

      </div>
    </section>
  )
}