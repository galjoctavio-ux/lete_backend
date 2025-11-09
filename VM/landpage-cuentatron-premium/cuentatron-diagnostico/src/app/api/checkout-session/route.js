// src/app/api/checkout-session/route.js

import { Stripe } from 'stripe';
import { NextResponse } from 'next/server';

// Inicializamos Stripe con la clave secreta desde las variables de entorno
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Esta es la función POST que se activará cuando el botón de "Comprar" llame a esta API
export async function POST(request) {
  try {
    // 1. Construimos las URLs absolutas para Stripe.
    // Stripe necesita saber a dónde redirigir al usuario
    // después del pago (éxito) o si cancela.

    // Obtenemos el "origin" (ej: http://localhost:3000)
    const origin = request.headers.get('origin') || 'http://localhost:3000';

    // Tu basePath (el que pusiste en next.config.mjs)
    const basePath = '/cuentatron/diagnostico-personalizado';

    // URL de Éxito (a la que acabamos de construir)
    const successUrl = `${origin}${basePath}/gracias-por-tu-compra`;

    // URL de Cancelación (de vuelta a la landing page)
    const cancelUrl = `${origin}${basePath}/`;

    // 2. Creamos la sesión de Checkout en Stripe
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'], // Aceptamos solo tarjeta
      line_items: [
        {
          price: process.env.NEXT_PUBLIC_STRIPE_PRICE_ID, // El ID de precio que guardaste
          quantity: 1,
        },
      ],
      mode: 'payment', // Es un pago único, no suscripción
      success_url: successUrl, // Redirigir aquí si el pago es exitoso
      cancel_url: cancelUrl,   // Redirigir aquí si el usuario cancela
    });

    // 3. Devolvemos la URL de la sesión de Checkout al frontend
    // El frontend usará esta URL para redirigir al usuario a Stripe
   return NextResponse.json({ url: session.url, id: session.id }, { status: 200 });

  } catch (error) {
    // Manejamos errores
    console.error('Error al crear la sesión de Stripe:', error.message);
    return NextResponse.json({ error: 'Error al crear la sesión de pago.', details: error.message }, { status: 500 });
  }
}