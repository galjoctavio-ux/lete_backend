import Stripe from 'stripe'
import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { Resend } from 'resend'

// 1. Inicializar Clientes
// ----------------------------------------------------------------
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2024-06-20',
});

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY! // ¡Importante! Usar la Service Role Key
);

const resend = new Resend(process.env.RESEND_API_KEY!);
const logisticsEmail = process.env.LOGISTICS_EMAIL_ADDRESS!;
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET!;
// ----------------------------------------------------------------


// 2. Función para guardar la orden en Supabase
// ----------------------------------------------------------------
async function saveOrderToSupabase(session: Stripe.Checkout.Session) {
  // Extrae los datos del cliente de la sesión de Stripe
  const customerEmail = session.customer_details?.email;
  const customerName = session.customer_details?.name;
  const customerRfc = session.customer_details?.tax_ids?.[0]?.value || null; // (Mejora #4)
  const { line1, line2, city, state, postal_code, country } = session.shipping_details?.address!;
  
  const shippingAddress = `${line1}${line2 ? ', ' + line2 : ''}, ${city}, ${state} ${postal_code}, ${country}`;

  // Prepara el objeto para tu tabla 'orders'
  const orderData = {
    stripe_session_id: session.id,
    customer_name: customerName,
    customer_email: customerEmail,
    shipping_address: shippingAddress,
    customer_rfc: customerRfc,
    amount_total: session.amount_total,
    payment_status: session.payment_status,
    terms_accepted_version: session.metadata?.terms_accepted || null, // (Mejora #1)
    stripe_customer_id: typeof session.customer === 'string' ? session.customer : null, // (Corrección Fase 0)
  };

  // Inserta en Supabase
  const { data, error } = await supabase
    .from('orders') // <-- El nombre de tu tabla
    .insert(orderData)
    .select() // Pide que te devuelva la fila insertada
    .single(); // Esperamos solo un resultado

  if (error) {
    console.error('Error al guardar orden en Supabase:', error);
    throw new Error(`Error Supabase: ${error.message}`);
  }

  console.log('Orden guardada exitosamente en Supabase:', data.id);
  return data; // Devuelve la orden guardada
}
// ----------------------------------------------------------------


// 3. Función para notificar a Logística (Mejora #3)
// ----------------------------------------------------------------
async function sendLogisticsEmail(session: Stripe.Checkout.Session, orderId: number) {
  const customerName = session.customer_details?.name;
  const customerEmail = session.customer_details?.email;
  const { line1, line2, city, state, postal_code, country } = session.shipping_details?.address!;
  const shippingAddress = `${line1}${line2 ? ', ' + line2 : ''}, ${city}, ${state} ${postal_code}, ${country}`;
  
  try {
    await resend.emails.send({
      from: 'Ventas Cuentatrón <ventas@mrfrio.mx>', // Reemplaza con tu email verificado en Resend
      to: logisticsEmail,
      subject: `¡Nueva Venta! Orden #${orderId} - Cuentatrón Hardware`,
      html: `
        <h1>¡Nueva Venta de Hardware!</h1>
        <p><strong>Orden Supabase ID:</strong> ${orderId}</p>
        <p><strong>Stripe Session ID:</strong> ${session.id}</p>
        <hr>
        <h3>Datos del Cliente</h3>
        <p><strong>Nombre:</strong> ${customerName}</p>
        <p><strong>Email:</strong> ${customerEmail}</p>
        <hr>
        <h3>Dirección de Envío</h3>
        <p>${shippingAddress}</p>
      `,
    });
    console.log('Email de logística enviado a:', logisticsEmail);
  } catch (error) {
    console.error('Error al enviar email de logística:', error);
    // No lanzamos un error aquí para no fallar el webhook, solo lo registramos.
  }
}
// ----------------------------------------------------------------


// 4. El Webhook Handler (La función POST principal)
// ----------------------------------------------------------------
export async function POST(req: Request) {
  const buf = await req.text();
  const sig = req.headers.get('stripe-signature')!;

  if (!sig) {
    console.error('Webhook: Falta la firma de Stripe.');
    return NextResponse.json({ message: 'Webhook: Falta la firma.' }, { status: 400 });
  }
  if (!webhookSecret) {
    console.error('Webhook: Falta la variable STRIPE_WEBHOOK_SECRET.');
    return NextResponse.json({ message: 'Webhook: Configuración incompleta.' }, { status: 500 });
  }

  let event: Stripe.Event;

  try {
    // 1. Verificar la firma del Webhook (SEGURIDAD)
    event = stripe.webhooks.constructEvent(buf, sig, webhookSecret);
  } catch (err: any) {
    console.error(`Webhook: Error en firma: ${err.message}`);
    return NextResponse.json({ message: `Webhook Error: ${err.message}` }, { status: 400 });
  }

  // 2. Manejar los eventos que nos importan
  try {
    let session: Stripe.Checkout.Session;
    let eventType = event.type;

    switch (eventType) {
      // Se llama cuando un pago con Tarjeta se completa
      case 'checkout.session.completed':
        session = event.data.object as Stripe.Checkout.Session;
        console.log('Webhook: Pago con tarjeta completado.', session.id);
        break;

      // Se llama cuando un pago de OXXO se confirma (días después)
      case 'checkout.session.async_payment_succeeded':
        session = event.data.object as Stripe.Checkout.Session;
        console.log('Webhook: Pago OXXO completado.', session.id);
        break;
      
      default:
        console.log(`Webhook: Evento no manejado: ${eventType}`);
        return NextResponse.json({ received: true }, { status: 200 });
    }

    // 3. Ejecutar nuestras acciones (si es un evento de pago)
    const savedOrder = await saveOrderToSupabase(session);
    await sendLogisticsEmail(session, savedOrder.id);
  
  } catch (err: any) {
    console.error('Webhook: Error al procesar el evento:', err.message);
    return NextResponse.json({ message: 'Error interno del Webhook.' }, { status: 500 });
  }

  // 4. Responder a Stripe que todo salió bien
  return NextResponse.json({ received: true }, { status: 200 });
}