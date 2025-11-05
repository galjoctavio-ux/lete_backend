'use client' // Es interactivo, necesita leer la URL

import { useEffect, useState, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { FiCheckCircle, FiLoader } from 'react-icons/fi'

// Componente interno para manejar la lógica (requerido por Suspense)
function SuccessContent() {
  const [customerEmail, setCustomerEmail] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const searchParams = useSearchParams()
  const sessionId = searchParams.get('session_id') // Lee el ?session_id=... de la URL

  useEffect(() => {
    if (sessionId) {
      const fetchSession = async () => {
        try {
          // Llama a nuestra API segura (que crearemos en el paso 3)
          // para obtener los datos de la sesión
          const response = await fetch(`/api/checkout_sessions/${sessionId}`)
          if (response.ok) {
            const data = await response.json()
            setCustomerEmail(data.customer_email)
          }
        } catch (error) {
          console.error('Error fetching session:', error)
        } finally {
          setLoading(false)
        }
      }
      fetchSession()
    } else {
      setLoading(false)
    }
  }, [sessionId])

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-gris-perla text-center px-4">
      <FiCheckCircle className="text-verde-ahorro text-7xl mb-6" />
      <h1 className="text-3xl md:text-4xl font-bold text-gris-grafito mb-4">
        ¡Gracias por tu compra!
      </h1>
      <p className="text-lg text-gris-grafito/90 max-w-lg mb-8">
        Tu pago ha sido procesado exitosamente.
        {loading && (
          <FiLoader className="animate-spin inline-block ml-2" />
        )}
        {customerEmail && (
          <>
            <br />
            Hemos enviado la confirmación de tu pedido a: 
            <strong> {customerEmail}</strong>.
          </>
        )}
      </p>
      <Link
        href="/"
        className="bg-azul-confianza text-blanco font-medium px-6 py-3 rounded-lg transition-all duration-300 hover:brightness-90"
      >
        Volver al inicio
      </Link>
    </div>
  )
}

// Componente principal que exportamos
export default function CompraExitosaPage() {
  // Usamos <Suspense> porque useSearchParams() lo requiere
  return (
    <Suspense fallback={<FiLoader className="animate-spin" />}>
      <SuccessContent />
    </Suspense>
  )
}