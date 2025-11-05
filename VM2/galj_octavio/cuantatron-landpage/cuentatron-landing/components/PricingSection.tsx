'use client' 

import { useState } from 'react'
import { FiLock, FiCheckCircle, FiLoader } from 'react-icons/fi'

// 1. Definimos los productos que ofreces
//    (Debes asegurarte que los Price IDs de tu .env.local correspondan)
const products = [
  {
    name: 'Monofásico',
    price: '999.00',
    priceIdEnvVar: 'STRIPE_PRICE_ID_MONOFASICO', // Nombre de la variable en .env.local
  },
  {
    name: 'Bifásico',
    price: '1,199.00',
    priceIdEnvVar: 'STRIPE_PRICE_ID_BIFASICO',
  },
  {
    name: 'Bifásico (Páneles)',
    price: '1,499.00',
    priceIdEnvVar: 'STRIPE_PRICE_ID_PANELES',
  },
]

export const PricingSection = () => {
  const TERMS_VERSION = 'T&C Venta v2025-10-26'

  // 2. Nuevo estado para saber qué producto está seleccionado
  const [selectedProduct, setSelectedProduct] = useState(products[0]) // Monofásico por defecto

  // Estados para la interactividad
  const [agreedToTerms, setAgreedToTerms] = useState(false)
  const [agreedToWarranty, setAgreedToWarranty] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const canCheckout = agreedToTerms && agreedToWarranty && !isLoading

  const handleCheckout = async () => {
    if (!canCheckout) return
    setIsLoading(true)
    setError(null)

    try {
  // 3. Modificamos la llamada a la API
  const apiUrl = `${window.location.origin}/cuentatron/api/checkout_sessions`
  console.log('🔍 Llamando API en:', apiUrl)
  
  const response = await fetch(apiUrl, {
    method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          terms_version: TERMS_VERSION,
          priceIdEnvVarName: selectedProduct.priceIdEnvVar, // Le decimos al backend qué ID buscar
        }),
      })

      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'No se pudo iniciar el pago.')
      if (data.url) window.location.href = data.url

    } catch (err: any) {
      setError(err.message)
      setIsLoading(false)
    }
  }

  return (
    <section id="precio" className="py-20 md:py-28 bg-blanco">
      <div className="container mx-auto max-w-3xl px-4 flex flex-col items-center">
        
        <div className="text-center mb-12">
          <h2 className="text-3xl md:text-4xl font-bold text-gris-grafito">
            Toma el control hoy mismo.
          </h2>
        </div>

        {/* Tarjeta de Oferta */}
        <div className="bg-gris-perla rounded-xl shadow-lg w-full max-w-lg overflow-hidden">
          
          {/* 4. NUEVO: Selector de Producto */}
          <div className="p-6 bg-blanco/50">
            <label className="text-sm font-medium text-gris-grafito mb-2 block">
              1. Selecciona tu tipo de servicio:
            </label>
            <div className="flex bg-gris-grafito/10 p-1 rounded-lg">
              {products.map((product) => (
                <button
                  key={product.name}
                  onClick={() => setSelectedProduct(product)}
                  className={`w-full px-2 py-2.5 rounded-md font-medium text-sm transition-all ${
                    selectedProduct.name === product.name
                      ? 'bg-blanco shadow text-azul-confianza'
                      : 'text-gris-grafito/70'
                  }`}
                >
                  {product.name}
                </button>
              ))}
            </div>
          </div>

          {/* Parte 1 y 2: El Producto (Ahora dinámico) */}
          <div className="p-8">
            <div className="flex justify-between items-baseline mb-4">
              <span className="text-lg font-medium text-gris-grafito">
                Dispositivo Cuentatrón ({selectedProduct.name})
              </span>
              {/* 5. PRECIO DINÁMICO */}
              <span className="text-2xl font-bold text-gris-grafito">
                ${selectedProduct.price} <span className="text-base font-normal">MXN</span>
              </span>
            </div>
            <p className="text-sm text-gris-grafito/80 mb-6">
              Pago único. Incluye: ✓ Dispositivo de monitoreo WiFi, ✓ Pantalla de
              consumo en tiempo real.
            </p>

            <div className="flex justify-between items-baseline">
              <span className="text-lg font-medium text-gris-grafito">
                Servicio de Asesoría
              </span>
              <span className="text-2xl font-bold text-gris-grafito">
                desde $69.00 <span className="text-base font-normal">/mes</span>
              </span>
            </div>
            <p className="text-sm text-gris-grafito/80">
              (Se contrata por separado al activar el dispositivo).
            </p>
          </div>

          <div className="bg-azul-confianza/10 text-center p-6">
            <p className="text-lg font-bold text-azul-confianza">
              🎉 Paga tu dispositivo hoy y obtén...
            </p>
            <p className="text-2xl font-bold text-azul-confianza mt-1">
              ¡EL PRIMER MES DE SERVICIO ES GRATIS!
            </p>
          </div>
        </div>

        {/* --- REQUISITOS LEGALES (Sigue igual) --- */}
        <div className="w-full max-w-lg mt-8 space-y-3">
          <label className="flex items-center space-x-3 cursor-pointer">
            <input
              type="checkbox"
              className="h-4 w-4 accent-azul-confianza"
              checked={agreedToTerms}
              onChange={(e) => setAgreedToTerms(e.target.checked)}
            />
            <span className="text-sm text-gris-grafito/90">
              He leído y acepto los{' '}
              <a href="/cuentatron/terminos-venta" target="_blank" rel="noopener noreferrer" className="text-azul-confianza underline">
                Términos y Condiciones de Venta
              </a>.
            </span>
          </label>
          <label className="flex items-center space-x-3 cursor-pointer">
            <input
              type="checkbox"
              className="h-4 w-4 accent-azul-confianza"
              checked={agreedToWarranty}
              onChange={(e) => setAgreedToWarranty(e.target.checked)}
            />
            <span className="text-sm text-gris-grafito/90">
              He leído la{' '}
              <a href="/cuentatron/garantia" target="_blank" rel="noopener noreferrer" className="text-azul-confianza underline">
                Política de Garantía (6 meses)
              </a>.
            </span>
          </label>
          <div className="text-sm text-gris-grafito/90 pt-2">
            Al comprar, tus datos serán tratados según nuestro{' '}
            <a href="/cuentatron/privacidad-ecommerce" target="_blank" rel="noopener noreferrer" className="text-azul-confianza underline">
              Aviso de Privacidad E-Commerce
            </a>.
          </div>
        </div>

        {/* --- BOTÓN DE PAGO (Sigue igual) --- */}
        <div className="w-full max-w-lg mt-6">
          <button
            onClick={handleCheckout}
            disabled={!canCheckout}
            className={`w-full bg-verde-ahorro text-gris-grafito font-bold text-lg px-10 py-4 rounded-lg transition-all duration-300 shadow-lg flex justify-center items-center ${
              canCheckout
                ? 'hover:brightness-95'
                : 'opacity-50 cursor-not-allowed'
            }`}
          >
            {isLoading ? (
              <FiLoader className="animate-spin text-2xl" />
            ) : (
              'SÍ, QUIERO MI DISPOSITIVO Y MES GRATIS'
            )}
          </button>
          {error && (
            <p className="text-center text-alerta-rojo mt-4">{error}</p>
          )}
          <div className="flex justify-center items-center space-x-6 mt-6 text-gris-grafito/70">
            <span className="flex items-center text-sm">
              <FiLock className="mr-1.5" /> Pago 100% Seguro con Stripe
            </span>
            <span className="flex items-center text-sm">
              <FiCheckCircle className="mr-1.5" /> 6 Meses de Garantía en Hardware
            </span>
          </div>
        </div>

      </div>
    </section>
  )
}