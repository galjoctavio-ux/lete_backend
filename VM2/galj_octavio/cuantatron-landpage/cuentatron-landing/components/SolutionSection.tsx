export const SolutionSection = () => {
  return (
    <section id="solucion" className="py-20 md:py-28 bg-gris-perla">
      <div className="container mx-auto max-w-6xl px-4 grid grid-cols-1 md:grid-cols-2 gap-12 items-center">

        {/* Izquierda: Video/Asset */}
        <div className="flex items-center justify-center">
          {/* PLACEHOLDER: Aquí va tu "video-explicativo.mp4"
            Por ahora, usamos un div oscuro como marcador de posición.
            Cuando tengas tu video, lo puedes añadir aquí con la etiqueta <video>
          */}
          <div className="bg-gris-grafito w-full aspect-video rounded-lg shadow-xl flex items-center justify-center text-blanco/50">
            [PLACEHOLDER: video-explicativo.mp4]
          </div>
        </div>

        {/* Derecha: Contenido (La Revelación) */}
        <div className="flex flex-col space-y-5">
          <h2 className="text-3xl md:text-4xl font-bold text-gris-grafito">
            Tu Asesor Energético Personal.
          </h2>
          <p className="text-lg text-gris-grafito/90">
            Cuentatrón no es solo un medidor. Es un servicio de vigilancia.
            Traducimos la ingeniería eléctrica (Voltaje, Amperaje, kWh) en lo
            que realmente te importa: <strong>finanzas personales</strong>.
          </p>
          <p className="text-lg text-gris-grafito/90">
            Te damos los mismos datos que ve CFE, pero en tiempo real y
            traducidos a pesos. No esperamos al recibo; te alertamos hoy de lo
            que CFE te cobrará en un mes.
          </p>
        </div>

      </div>
    </section>
  )
}