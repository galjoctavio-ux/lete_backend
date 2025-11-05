import Stripe from 'stripe'
import { NextResponse } from 'next/server'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2025-09-30.clover',
});

// 1. Cargamos los IDs de precio permitidos desde .env.local
//    Esto es una medida de seguridad clave.
const allowedPriceIds = {
  STRIPE_PRICE_ID_MONOFASICO: process.env.STRIPE_PRICE_ID_MONOFASICO!,
  STRIPE_PRICE_ID_BIFASICO: process.env.STRIPE_PRICE_ID_BIFASICO!,
  STRIPE_PRICE_ID_PANELES: process.env.STRIPE_PRICE_ID_PANELES!,
}

export async function POST(request: Request) {
  try {
    // 2. Leemos los datos que envió el frontend
    const { terms_version, priceIdEnvVarName } = await request.json();

    if (!terms_version) {
      throw new Error('No se especificó la versión de los términos.');
    }
    
    // 3. Validamos que el ID de precio solicitado esté en nuestra lista permitida
    if (!priceIdEnvVarName || !Object.keys(allowedPriceIds).includes(priceIdEnvVarName)) {
      throw new Error('ID de producto no válido.');
    }

    // Obtenemos el ID de precio real (ej. price_...)
    const priceId = allowedPriceIds[priceIdEnvVarName as keyof typeof allowedPriceIds];

    if (!priceId) {
      throw new Error(`El Price ID para ${priceIdEnvVarName} no está configurado en .env.local.`);
    }

    // 4. Leemos las otras variables de entorno
    const shippingRateId = process.env.STRIPE_SHIPPING_RATE_ID;
    const appUrl = process.env.NEXT_PUBLIC_APP_URL;

    if (!shippingRateId || !appUrl) {
      throw new Error('Faltan variables de envío o de la App URL.');
    }

    // 5. Crea la Sesión de Checkout en Stripe (AHORA ES DINÁMICO)
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card', 'oxxo'],
      mode: 'payment',
      
      line_items: [
        {
          price: priceId, // <-- Usamos el Price ID validado
          quantity: 1,
        },
      ],
      
      shipping_options: [
        {
          shipping_rate: shippingRateId,
        },
      ],
      shipping_address_collection: {
        allowed_countries: ['MX'],
      },
      tax_id_collection: {
        enabled: true,
      },
      metadata: {
        terms_accepted: terms_version,
      },
      success_url: `${appUrl}/compra/exitosa?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${appUrl}/compra/cancelada`,
    });

    return NextResponse.json({ url: session.url });

  } catch (err: any) {
    console.error('Error al crear la sesión de Stripe:', err);
    return NextResponse.json({ error: err.message || 'Error interno del servidor.' }, { status: 500 });
  }
}