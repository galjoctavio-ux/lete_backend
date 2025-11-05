export const TrustSection = () => {
  return (
    <section id="confianza" className="py-20 md:py-28 bg-gris-perla">
      <div className="container mx-auto max-w-4xl px-4 text-center">

        {/* Título (Cita de Autoridad) */}
        <h2 className="text-2xl md:text-3xl font-bold text-gris-grafito italic">
          "Hecho por ingenieros. Recomendado por electricistas."
        </h2>

        {/* Texto de Apoyo */}
        <p className="text-lg text-gris-grafito/90 mt-6 mb-10">
          Cuentatrón es una herramienta de gestión y prevención, no de disputa
          legal. Nuestra precisión nos ha permitido crear alianzas con empresas
          de ingeniería eléctrica que usan y recomiendan Cuentatrón a sus
          clientes como soluciones energéticas.
        </p>

        {/* Prueba Social (Logos) */}
        <div className="flex items-center justify-center">
          {/* PLACEHOLDER: Aquí van los logos de tus aliados */}
          <div className="bg-blanco w-full max-w-2xl h-32 rounded-lg shadow-sm flex items-center justify-center text-gris-grafito/50">
            [PLACEHOLDER: logos-aliados.png]
          </div>
        </div>

      </div>
    </section>
  )
}