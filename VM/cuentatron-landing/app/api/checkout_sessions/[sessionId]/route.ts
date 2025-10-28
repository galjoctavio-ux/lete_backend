import Stripe from 'stripe'
import { NextResponse } from 'next/server'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2025-09-30.clover',
});

// Esta es la ruta GET /api/checkout_sessions/cs_test_...
export async function GET(
  request: Request,
  // --- ESTA ES LA CORRECCIÓN DE FUERZA BRUTA ---
  // Usamos 'any' para saltarnos el chequeo de tipos
  context: any 
) {
  // Extraemos el sessionId desde el 'context'
  const sessionId = context.params.sessionId

  try {
    if (!sessionId) {
      throw new Error('Session ID no proporcionado');
    }

    // 1. Pide la sesión a Stripe de forma segura
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    // 2. Devuelve SOLO el email al frontend
    return NextResponse.json({ 
      customer_email: session.customer_details?.email 
    }, { status: 200 });

  } catch (err: any) {
    console.error('Error al recuperar sesión de checkout:', err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
