import Link from 'next/link'
import { FiAlertTriangle } from 'react-icons/fi'

export default function CompraCanceladaPage() {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-gris-perla text-center px-4">
      <FiAlertTriangle className="text-alerta-ambar text-7xl mb-6" />
      <h1 className="text-3xl md:text-4xl font-bold text-gris-grafito mb-4">
        Pago cancelado
      </h1>
      <p className="text-lg text-gris-grafito/90 max-w-lg mb-8">
        Tu orden no fue procesada. No se ha realizado ningún cargo a tu método de pago.
      </p>
      <Link
        href="/#precio" // Enlace de anclaje de vuelta a la sección de precios
        className="bg-azul-confianza text-blanco font-medium px-6 py-3 rounded-lg transition-all duration-300 hover:brightness-90"
      >
        Volver a intentarlo
      </Link>
    </div>
  )
}