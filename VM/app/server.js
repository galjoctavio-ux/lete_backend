// --- 1. IMPORTAR LIBRERÍAS ---
require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const fetch = require('node-fetch');
const QRCode = require('qrcode');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { Resend } = require('resend');
const fs = require('fs').promises; // <-- AÑADIR
const path = require('path'); // <-- AÑADIR
const { createProxyMiddleware } = require('http-proxy-middleware'); // <-- AÑADIR
const twilio = require('twilio'); // <-- AÑADIR

const resend = new Resend(process.env.RESEND_API_KEY);
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN); // <-- AÑADIR


// --- GUARDIÁN DE VARIABLES DE ENTORNO ---
// Revisa si la llave de servicio está cargada y parece válida.
if (!process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_KEY.length < 150) {
    console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
    console.error("ERROR CRÍTICO: ¡SUPABASE_SERVICE_KEY no está cargada o está incompleta!");
    console.error("Esto causa fallos de RLS y 'Invalid API key'.");
    console.error("Asegúrate de que la llave esté entre comillas dobles (\"\") en tu .env");
    console.error("y reinicia PM2 con 'pm2 delete api-mrfrio' y 'pm2 start ecosystem.config.js'");
    console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
    
    // Detiene la aplicación para que no continúe en un estado roto.
    process.exit(1); 
}
// --- FIN DEL GUARDIÁN ---

// --- 2. CONFIGURACIÓN INICIAL ---
const app = express();
const port = process.env.PORT || 3000;
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
const supabaseUrl = process.env.SUPABASE_URL; // Asegúrate de tener SUPABASE_URL en tu .env

// Sirve archivos estáticos (como el PDF) desde la carpeta 'public'
app.use(express.static(path.join(__dirname, 'public'))); // <-- ESTA ES LA SOLUCIÓN

// --- RUTA DE DIAGNÓSTICO (del texto que me pasaste, ¡es buena idea!) ---
app.get('/test-pdf', (req, res) => {
    const pdfPath = path.join(__dirname, 'public', 'Instrucciones.pdf');
    const existe = fs.existsSync(pdfPath);
    console.log(`[TEST-PDF] Buscando PDF en: ${pdfPath}`);
    console.log(`[TEST-PDF] ¿Existe? ${existe}`);
        
    if (existe) {
        res.send(`✅ El PDF SÍ existe en: ${pdfPath}`);
    } else {
        res.status(404).send(`❌ PDF NO encontrado en: ${pdfPath}`);
    }
});
// --- FIN DE RUTA DE DIAGNÓSTICO ---

// --- CONFIGURACIÓN DEL PROXY DE AUTENTICACIÓN (con logs de depuración y pathRewrite) ---
console.log(`[INIT] Creando proxy para /auth/v1 -> ${supabaseUrl}`);
app.use('/auth/v1', createProxyMiddleware({
    target: supabaseUrl,
    changeOrigin: true,
    ws: true,
    logLevel: 'debug',
    
    // --- 🔥 INICIO DE LA SOLUCIÓN 🔥 ---
    pathRewrite: (path, req) => {
        // 'path' en este punto es '/verify?token=...' (sin el /auth/v1)
        // Necesitamos reconstruir la ruta completa que Supabase espera.
        const newPath = '/auth/v1' + path;
        console.log(`[PROXY REWRITE] Ruta original: ${path}. Nueva ruta: ${newPath}`);
        return newPath;
    },
    // --- 🔥 FIN DE LA SOLUCIÓN 🔥 ---

    onProxyReq: (proxyReq, req, res) => {
        // proxyReq.path ya incluirá la ruta re-escrita
        console.log(`[PROXY REQ] -> ${req.method} ${proxyReq.path}`);
        proxyReq.setHeader('apikey', process.env.SUPABASE_ANON_KEY);
        proxyReq.setHeader('Authorization', `Bearer ${process.env.SUPABASE_ANON_KEY}`);
    },
    onProxyRes: (proxyRes, req, res) => {
        console.log(`[PROXY RES] <- Status: ${proxyRes.statusCode} Para: ${req.originalUrl}`);
    },
    onError: (err, req, res) => {
        console.error('[PROXY ERROR]', err.message);
        res.status(502).send('Error en el proxy de autenticación.');
    }
}));
// --- FIN DEL PROXY ---

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// --- 7. RUTA WEBHOOK (Unificada y con Depuración) ---
// Esta ruta se define ANTES de app.use(express.json()) para que Stripe pueda verificar la firma.
app.post('/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  console.log("\n--- [DEBUG] Webhook de Stripe recibido ---");
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.error(`[DEBUG] ❌ Falló la verificación de la firma del Webhook: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log(`[DEBUG] Tipo de evento: ${event.type}, ID del evento: ${event.id}`);

  // --- Caso 1: Checkout completado (el más importante) ---
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const { email, device_id, cliente_id } = session.metadata;
    const stripeSubscriptionId = session.subscription;

    console.log(`[DEBUG] Metadata recibida: device_id=${device_id}, cliente_id=${cliente_id}, email=${email}`);

    // Verificación crítica: sin esta metadata, no podemos continuar de forma segura.
    if (!cliente_id || !device_id) {
      console.error("[DEBUG] ❌ Faltan 'cliente_id' o 'device_id' en la metadata. Abortando.");
      return res.status(400).send("Metadata incompleta.");
    }

    try {
      // --- IDEMPOTENCIA: VERIFICAR SI ESTA SUSCRIPCIÓN YA FUE PROCESADA ---
      const { data: clienteExistente, error: checkError } = await supabase
        .from('clientes')
        .select('stripe_subscription_id')
        .eq('id', cliente_id)
        .single();

      if (checkError) {
        console.error(`[DEBUG] ❌ Error buscando cliente ${cliente_id} para chequeo inicial:`, checkError.message);
        throw new Error(`Error en chequeo inicial para cliente ${cliente_id}`);
      }
      
      // Si el cliente ya tiene un ID de suscripción, es un evento duplicado.
      if (clienteExistente && clienteExistente.stripe_subscription_id) {
        console.log(`[DEBUG] ⚠️ Webhook duplicado para cliente ${cliente_id}. Ya tiene una suscripción. Ignorando.`);
        return res.status(200).send({ received: true, skipped: 'already_processed' });
      }
      
      console.log(`[DEBUG] Cliente ${cliente_id} validado, procediendo a activar.`);

      const subscription = await stripe.subscriptions.retrieve(stripeSubscriptionId);
      const fechaInicio = new Date();
      let fechaProximoPago;
      // Si hay trial, usa trial_end en lugar de current_period_end
      if (subscription.trial_end) {
        fechaProximoPago = new Date(subscription.trial_end * 1000);
        console.log(`[DEBUG] Usando trial_end: ${fechaProximoPago.toISOString()}`);
      } else if (subscription.current_period_end) {
        fechaProximoPago = new Date(subscription.current_period_end * 1000);
        console.log(`[DEBUG] Usando current_period_end: ${fechaProximoPago.toISOString()}`);
      } else {
        console.warn(`[DEBUG] ⚠️ Ni trial_end ni current_period_end disponibles. Usando fallback de 30 días.`);
        fechaProximoPago = new Date();
        fechaProximoPago.setDate(fechaProximoPago.getDate() + 30);
      }

      // 1. Actualizar la tabla 'clientes'
      console.log(`[DEBUG] Actualizando tabla 'clientes' para ID: ${cliente_id}`);
      const { error: clienteError } = await supabase
        .from('clientes')
        .update({
          subscription_status: 'active',
          stripe_subscription_id: stripeSubscriptionId,
          stripe_customer_id: session.customer,
          fecha_inicio_servicio: fechaInicio.toISOString().split('T')[0],
          fecha_proximo_pago: fechaProximoPago.toISOString().split('T')[0],
        })
        .eq('id', cliente_id);
      if (clienteError) throw new Error(`Error actualizando cliente ${cliente_id}: ${clienteError.message}`);
      console.log("[DEBUG] ✅ Tabla 'clientes' actualizada.");

      // 2. Actualizar la tabla 'dispositivos_lete' (Versión con Diagnóstico)
      console.log(`[DEBUG] Actualizando tabla 'dispositivos_lete' para device_id: ${device_id}`);

      // PRIMERO: Ver TODAS las filas que coinciden (sin .single())
      const { data: todasLasFilas, error: checkAllError } = await supabase
        .from('dispositivos_lete')
        .select('*')
        .eq('device_id', device_id);

      if (checkAllError) {
        console.error(`[DEBUG] ❌ Error consultando dispositivos:`, checkAllError.message);
        throw new Error(`Error al consultar dispositivo ${device_id}`);
      }

      console.log(`[DEBUG] 🔎 Filas encontradas para device_id '${device_id}':`, JSON.stringify(todasLasFilas, null, 2));
      console.log(`[DEBUG] 🔎 Número total de filas: ${todasLasFilas?.length || 0}`);

      if (!todasLasFilas || todasLasFilas.length === 0) {
        console.error(`[DEBUG] ❌ NO SE ENCONTRÓ el dispositivo ${device_id} en la tabla`);
        throw new Error(`Dispositivo ${device_id} no existe en la base de datos`);
      }

      if (todasLasFilas.length > 1) {
        console.error(`[DEBUG] ⚠️ ¡DUPLICADOS! Se encontraron ${todasLasFilas.length} filas con device_id '${device_id}'`);
        // Muestra todas las filas duplicadas
        todasLasFilas.forEach((fila, idx) => {
          console.log(`[DEBUG] Fila ${idx + 1}:`, JSON.stringify(fila));
        });
        throw new Error(`Hay ${todasLasFilas.length} dispositivos con el mismo device_id. Limpia la base de datos.`);
      }

      // Si llegamos aquí, hay exactamente 1 fila
      const dispositivoExistente = todasLasFilas[0];
      console.log(`[DEBUG] ✅ Dispositivo único encontrado. Estado actual: '${dispositivoExistente.estado}', cliente_id actual: ${dispositivoExistente.cliente_id}`);

      // SEGUNDO: Actualizar el dispositivo
      const { data: dispData, error: dispError } = await supabase
        .from('dispositivos_lete')
        .update({ 
          estado: 'vendido', 
          cliente_id: cliente_id 
        })
        .eq('device_id', device_id)
        .select()

      if (dispError) {
        console.error(`[DEBUG] ❌ Error de Supabase al actualizar dispositivo:`, dispError.message);
        throw new Error(`Error de base de datos al actualizar: ${dispError.message}`);
      }

      console.log(`[DEBUG] ✅ Dispositivo actualizado correctamente a 'vendido'. Respuesta:`, JSON.stringify(dispData));
            
      // --- NUEVA LÓGICA DE BIENVENIDA ---

      // Paso 3: Obtener datos frescos del cliente
      console.log(`[DEBUG] Obteniendo datos de cliente ${cliente_id} para mensajes.`);
      const { data: clienteInfo, error: fetchError } = await supabase
          .from('clientes')
          .select('nombre, telefono_whatsapp')
          .eq('id', cliente_id)
          .single();

      if (fetchError) throw new Error(`No se pudo obtener info de cliente ${cliente_id}: ${fetchError.message}`);

      const { nombre, telefono_whatsapp } = clienteInfo;
      const nombreCliente = nombre || 'Cliente';
      const fechaPagoFormateada = fechaProximoPago.toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric' });

      // Paso 4: Leer y personalizar la plantilla HTML de bienvenida
      console.log(`[DEBUG] Leyendo plantilla de correo bienvenida.html...`);
      let htmlBody;
      try {
          const plantillaPath = path.join(__dirname, 'email-templates', 'bienvenida.html');
          htmlBody = await fs.readFile(plantillaPath, 'utf-8'); // <-- POR ESTO

          htmlBody = htmlBody.replace(/{{NombreDelCliente}}/g, nombreCliente)
                              .replace(/{{FechaDelProximoPago}}/g, fechaPagoFormateada)
                              .replace(/{{user_email}}/g, email);

      } catch (readError) {
          console.error("[DEBUG] ❌ ERROR CRÍTICO: No se pudo leer la plantilla bienvenida.html.", readError.message);
          // Continuar de todas formas, pero enviar un correo simple como fallback
          htmlBody = `<h1>¡Hola y bienvenido a Mr. Frío!</h1><p>Tu suscripción ha sido activada exitosamente.</p><p>Puedes acceder a tu panel de control en https://api.mrfrio.mx/mi-cuenta.html</p>`;
      }

      // Paso 5: Enviar correo de bienvenida usando el HTML leído
      console.log(`[DEBUG] Enviando correo de bienvenida (plantilla HTML) a ${email}...`);
      await resend.emails.send({
          from: 'Mr. Frío <bienvenido@mrfrio.mx>',
          to: [email],
          subject: '¡Bienvenido a Mr. Frío! Siguientes Pasos 🚀',
          html: htmlBody // <-- Aquí usamos el HTML del archivo
      });
      console.log("[DEBUG] ✅ Correo de bienvenida enviado con éxito.");

      // Paso 6: Enviar mensaje de WhatsApp con Twilio
      if (telefono_whatsapp) {
          console.log(`[DEBUG] Enviando WhatsApp de bienvenida a ${telefono_whatsapp}...`);
          try {
              await twilioClient.messages.create({
                  body: `¡Hola ${nombreCliente}! 👋 Bienvenido a Mr. Frío. Tu suscripción está activa y tu dispositivo está listo para ser instalado. Revisa tu correo (${email}) para ver las instrucciones.`,
                  from: 'whatsapp:+14155238886', // Número Sandbox de Twilio (o tu número comprado)
                  to: `whatsapp:${telefono_whatsapp}` // Número del cliente (ej. whatsapp:+52133...)
              });
              console.log("[DEBUG] ✅ WhatsApp de bienvenida enviado.");
          } catch (twilioError) {
              console.warn(`[DEBUG] ⚠️ Falló el envío de WhatsApp a ${telefono_whatsapp}: ${twilioError.message}`);
          }
      } else {
          console.log("[DEBUG] ⚠️ No se encontró teléfono_whatsapp para el cliente, omitiendo WhatsApp.");
      }
      // --- FIN DE LÓGICA DE BIENVENIDA ---
    } catch (error) {
        console.error(`[DEBUG] ❌ Error fatal procesando 'checkout.session.completed':`, error.message);
        return res.status(500).json({ error: error.message });
    }
  }

  // --- Caso 2: La suscripción se actualizó (renovaciones, cancelaciones, etc.) ---
  if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
    const subscription = event.data.object;
    const stripeSubscriptionId = subscription.id;
    const estadoStripe = subscription.status;

    console.log(`[DEBUG] Actualizando estado de suscripción ${stripeSubscriptionId} a ${estadoStripe}`);
    try {
      let nuevoEstadoCliente = 'paused';
      if (estadoStripe === 'active') nuevoEstadoCliente = 'active';
      if (estadoStripe === 'canceled' || event.type === 'customer.subscription.deleted') nuevoEstadoCliente = 'cancelled';
      if (estadoStripe === 'past_due' || estadoStripe === 'unpaid') nuevoEstadoCliente = 'paused';

      let fechaProximoPagoFormateada = null;
      if (subscription.current_period_end && !isNaN(subscription.current_period_end)) {
        const fechaProximoPago = new Date(subscription.current_period_end * 1000);
        if (!isNaN(fechaProximoPago.getTime())) {
          fechaProximoPagoFormateada = fechaProximoPago.toISOString().split('T')[0];
        }
      }

      const { error } = await supabase
        .from('clientes')
        .update({
          subscription_status: nuevoEstadoCliente,
          fecha_proximo_pago: fechaProximoPagoFormateada,
        })
        .eq('stripe_subscription_id', stripeSubscriptionId);
      if (error) throw error;

      if (nuevoEstadoCliente === 'cancelled') {
        const { data: cliente } = await supabase.from('clientes').select('id').eq('stripe_subscription_id', stripeSubscriptionId).single();
        if (cliente) {
          await supabase.from('dispositivos_lete').update({ estado: 'cancelled' }).eq('cliente_id', cliente.id);
        }
      }
      console.log(`[DEBUG] ✅ Suscripción ${stripeSubscriptionId} actualizada a ${nuevoEstadoCliente}.`);
    } catch (error) {
      console.error(`[DEBUG] ❌ Error procesando ${event.type}:`, error.message);
      return res.status(500).json({ error: error.message });
    }
  }

  // Respondemos a Stripe que todo salió bien para este evento.
  res.status(200).send({ received: true });
});

// --- AHORA SÍ, USAMOS express.json() PARA EL RESTO DE RUTAS ---
app.use(express.json());

// --- 3. MIDDLEWARE DE AUTENTICACIÓN ---
const verificarUsuario = async (req, res, next) => {
  const token = req.headers.authorization?.split('Bearer ')[1];
  if (!token) {
    return res.status(401).json({ error: 'Acceso no autorizado: Token no proporcionado.' });
  }
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) {
    return res.status(401).json({ error: 'Acceso no autorizado: Token inválido.' });
  }
  req.user = user;
  next();
};

// --- FUNCIÓN DE AYUDA: TRADUCTOR DE ERRORES ---
function traducirError(err) {
  console.error("Error original:", err.message);
  if (err.message.includes('invalid') && err.message.includes('Email address')) {
    return { status: 400, message: 'El formato de tu correo electrónico no es válido. Por favor, revísalo.' };
  }
  if (err.message.includes('User already registered') || (err.message.includes('duplicate key') && err.message.includes('clientes_email_key'))) {
    return { status: 409, message: 'Este correo electrónico ya está registrado en nuestro sistema.' };
  }
  if (err.message.includes('For security purposes')) {
    return { status: 429, message: 'Estás intentando registrarte demasiado rápido. Por favor, espera unos segundos.' };
  }
  if (err.type && err.type.startsWith('Stripe')) {
    console.error("Error de Stripe:", err.message);
    return { status: 500, message: `Hubo un problema con nuestro procesador de pagos (Error: S-01). Por favor, contacta a soporte.` };
  }
  return { status: 500, message: 'Error interno del servidor. Nuestro equipo ha sido notificado.' };
}

// --- 4. RUTAS PÚBLICAS (Proceso de Registro y Login) ---

// RUTA 1: VERIFICAR DISPOSITIVO
app.get('/api/verificar-dispositivo', async (req, res) => {
  const { device_id } = req.query;
  if (!device_id) { 
    return res.status(400).json({ error: 'Falta device_id' }); 
  }
  
  try {
    console.log(`[DEBUG] Verificando dispositivo: ${device_id}`);
    
    const { data, error } = await supabase
      .from('dispositivos_lete')
      .select(`
        estado,
        plan_id,
        planes_lete (
          nombre_plan,
          precio
        )
      `)
      .eq('device_id', device_id)
      .single();
    
    console.log('[DEBUG] Respuesta de Supabase:', JSON.stringify(data, null, 2));
    console.log('[DEBUG] Error de Supabase:', error);
    
    if (error) {
      console.error("Error en /verificar-dispositivo:", error.message);
      return res.status(404).json({ error: 'Dispositivo no encontrado o código QR inválido.' });
    }
    
    // Verificación adicional
    if (!data || !data.planes_lete) {
      console.error(`❌ El dispositivo ${device_id} no tiene plan asociado`);
      console.error('Data recibida:', JSON.stringify(data));
      return res.status(500).json({ 
        error: 'Error de configuración del dispositivo. Contacta a soporte.',
        debug: data
      });
    }
    
    if (data.estado !== 'sin_vender') { 
      return res.status(409).json({ 
        error: `Este dispositivo ya fue registrado (estado: ${data.estado}).` 
      }); 
    }
    
    res.status(200).json(data);
    
  } catch (err) { 
    console.error("Error crítico en /verificar-dispositivo:", err);
    res.status(500).json({ 
      error: 'Error interno del servidor.', 
      details: err.message 
    }); 
  }
});

// RUTA 2: REGISTRAR CLIENTE
app.post('/api/registrar-cliente', async (req, res) => {
  const {
    device_id, email, telefono, nombre, tipo_tarifa,
    ciclo_bimestral, dia_de_corte, lectura_medidor_inicial, consumo_recibo_anterior, lectura_cierre_periodo_anterior,
    "cf-turnstile-response": turnstileToken
  } = req.body;

  try {
    // Paso A: Seguridad CAPTCHA
    const captchaResponse = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: process.env.TURNSTILE_SECRET_KEY, response: turnstileToken })
    });
    const captchaData = await captchaResponse.json();
    if (!captchaData.success) {
      return res.status(403).json({ error: 'Verificación anti-bot fallida.' });
    }
    // --- NUEVA VALIDACIÓN DE CAMPOS OBLIGATORIOS ---
    if (lectura_medidor_inicial === null || lectura_medidor_inicial === undefined || lectura_medidor_inicial === '' ||
        consumo_recibo_anterior === null || consumo_recibo_anterior === undefined || consumo_recibo_anterior === '' ||
        lectura_cierre_periodo_anterior === null || lectura_cierre_periodo_anterior === undefined || lectura_cierre_periodo_anterior === '') {
       return res.status(400).json({ error: 'La lectura inicial, el consumo anterior y la lectura de cierre son obligatorios.' });
    }
    // --- FIN DE VALIDACIÓN ---


    // Paso 1: Validar dispositivo y obtener plan de Stripe
    const { data: dispositivo, error: dispError } = await supabase
      .from('dispositivos_lete')
      .select('plan_id, estado')
      .eq('device_id', device_id)
      .single();
    if (dispError) throw new Error(`Dispositivo ${device_id} no encontrado en la base de datos.`);
    if (dispositivo.estado !== 'sin_vender') {
      return res.status(409).json({ error: `Este dispositivo ya fue registrado (estado: ${dispositivo.estado}).` });
    }

    const { data: plan, error: planError } = await supabase
      .from('planes_lete')
      .select('stripe_plan_id')
      .eq('id', dispositivo.plan_id)
      .single();
    if (planError || !plan?.stripe_plan_id) {
      throw new Error(`No se encontró un plan de Stripe para el dispositivo ${device_id}.`);
    }
    const stripePriceId = plan.stripe_plan_id;

    // --- ORDEN CORREGIDO PARA ELIMINAR LA CONDICIÓN DE CARRERA ---

    // Paso 2: Crear usuario en Supabase Auth
    const { data: authData, error: authError } = await supabase.auth.signUp({
      email: email,
      password: crypto.randomBytes(16).toString('hex')
    });
    if (authError) throw authError;

    // Paso 3: Crear cliente en nuestra tabla 'clientes'
    const telefonoNormalizado = telefono ? `+521${telefono}` : null;
    
    // --- PARSEO DE CAMPOS OBLIGATORIOS ---
    const lecturaInicialValida = parseFloat(lectura_medidor_inicial);
    const consumoAnteriorValido = parseFloat(consumo_recibo_anterior);
    const lecturaCierreValida = parseFloat(lectura_cierre_periodo_anterior);

    if (isNaN(lecturaInicialValida) || isNaN(consumoAnteriorValido) || isNaN(lecturaCierreValida)) {
        return res.status(400).json({ error: 'Los valores de lectura y consumo deben ser números válidos.' });
    }

    // --- CÁLCULO CORREGIDO (Request 2) ---
    const kwhPromedioDiario = (consumoAnteriorValido / 60).toFixed(4);    

    const { data: clienteData, error: clienteError } = await supabase
      .from('clientes')
      .insert({
        nombre, email, telefono_whatsapp: telefonoNormalizado,
        auth_user_id: authData.user.id,
        tipo_tarifa, ciclo_bimestral, dia_de_corte,
        lectura_medidor_inicial: lecturaInicialValida,
        consumo_recibo_anterior: consumoAnteriorValido,
        lectura_cierre_periodo_anterior: lecturaCierreValida,
        kwh_promedio_diario: kwhPromedioDiario,
        subscription_status: 'pending_payment',
      })
      .select('id')
      .single();
    if (clienteError) throw clienteError;
    const nuevoClienteId = clienteData.id;

    // Paso 4: Crear cliente en Stripe
    const customer = await stripe.customers.create({
      email: email,
      name: nombre, // <--- ¡CORREGIDO! De 'nombre' a 'name'
      phone: telefonoNormalizado,
      metadata: { db_cliente_id: nuevoClienteId }
    });

    // Actualizamos nuestro cliente con el ID de Stripe
    await supabase.from('clientes').update({ stripe_customer_id: customer.id }).eq('id', nuevoClienteId);

    // Paso 5: Crear la sesión de Checkout de Stripe
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription',
      customer: customer.id,
      line_items: [{ price: stripePriceId, quantity: 1 }],
      metadata: {
        email: email,
        device_id: device_id,
        cliente_id: nuevoClienteId.toString()
      },
      subscription_data: { trial_period_days: 30 },
      success_url: `https://api.mrfrio.mx/bienvenido.html?email=${encodeURIComponent(email)}`,
      cancel_url: `https://api.mrfrio.mx/registro.html?dispositivo=${device_id}&error=cancelado`,
    });

    // Paso 6: Vincular dispositivo con el cliente (estado 'pendiente_pago')
    await supabase
      .from('dispositivos_lete')
      .update({ estado: 'pendiente_pago', cliente_id: nuevoClienteId })
      .eq('device_id', device_id);

    // Paso 7: Devolver el link de pago
    res.status(200).json({ checkout_url: session.url });

  } catch (err) {
    const { status, message } = traducirError(err);
    res.status(status).json({ error: message });
  }
});

// RUTA 4: LOGIN CON MAGIC LINK (MEJORADA Y CON LINK CLOAKING)
app.post('/api/login', async (req, res) => {
    const { email } = req.body;
    const miPropiaUrlBase = 'https://api.mrfrio.mx'; // La URL base de tu API
    const supabaseUrlBase = process.env.SUPABASE_URL; // Ej: 'https://evpcxzhdkjwbnpwnzyme.supabase.co'

    try {
        console.log(`[LOGIN] Solicitando magic link para: ${email}`);
        
        // Paso 1: Pedirle a Supabase (admin) que GENERE el enlace
        const { data, error: linkError } = await supabase.auth.admin.generateLink({
            type: 'magiclink',
            email: email,
            options: {
                redirectTo: 'https://api.mrfrio.mx/mi-cuenta.html'
            }
        });

        if (linkError) throw linkError;

        const originalLink = data.properties.action_link;
        console.log('[LOGIN] Enlace original de Supabase:', originalLink);

        // Paso 2: MODIFICAR el enlace para usar nuestro dominio (el proxy)
        const cloakedLink = originalLink.replace(supabaseUrlBase, miPropiaUrlBase);
        
        console.log('[LOGIN] Enlace "encubierto" para Resend:', cloakedLink);

        // Paso 3: ENVIAR el correo nosotros mismos usando Resend
        const { error: resendError } = await resend.emails.send({
            from: 'Mr. Frío <bienvenido@mrfrio.mx>',
            to: [email],
            subject: 'Inicia sesión en Mr. Frío',
            html: `<h1>Hola de nuevo!</h1>
                    <p>Haz clic en el siguiente enlace para iniciar sesión en tu cuenta de Mr. Frío:</p>
                    <a href="${cloakedLink}" style="font-size: 16px; color: white; background-color: #007bff; padding: 10px 20px; text-decoration: none; border-radius: 5px;">
                        Iniciar Sesión
                    </a>
                    <br><br>
                    <p>Este enlace es válido por 5 minutos. Si no solicitaste esto, puedes ignorar este correo.</p>`
        });

        if (resendError) throw resendError;

        res.status(200).json({ message: 'Enlace de inicio de sesión enviado a tu correo.' });

    } catch (err) {
        console.error("Error en /api/login:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// --- 5. RUTAS SEGURAS (Requieren Login de Usuario) ---
app.get('/api/mi-cuenta', verificarUsuario, async (req, res) => {
  const userId = req.user.id;
  try {
    const { data: cliente, error: clienteError } = await supabase.from('clientes').select('*').eq('auth_user_id', userId).single();
    if (clienteError) throw clienteError;
    
    const { data: dispositivos, error: dispositivosError } = await supabase.from('dispositivos_lete').select(`device_id, estado, planes_lete ( nombre_plan, precio )`).eq('cliente_id', cliente.id);
    if (dispositivosError) throw dispositivosError;
    
    res.status(200).json({ perfil: cliente, dispositivos: dispositivos });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// RUTA 5: ACTUALIZAR PERFIL DE USUARIO
app.post('/api/actualizar-perfil', verificarUsuario, async (req, res) => {
    const { nombre, telefono_whatsapp } = req.body;
    const userId = req.user.id;

    if (!nombre && !telefono_whatsapp) {
        return res.status(400).json({ error: 'No se proporcionaron datos para actualizar.' });
    }

    try {
        console.log(`[PERFIL] Actualizando perfil para auth_user_id: ${userId}`);
        
        // 1. Obtener el cliente_id y stripe_customer_id de nuestra DB
        const { data: cliente, error: clienteError } = await supabase
            .from('clientes')
            .select('id, stripe_customer_id')
            .eq('auth_user_id', userId)
            .single();

        if (clienteError) throw new Error(`Cliente no encontrado: ${clienteError.message}`);

        // --- Preparar datos ---
        const updatesSupabase = {};
        const updatesStripe = {};
        
        if (nombre) {
            updatesSupabase.nombre = nombre;
            updatesStripe.name = nombre;
        }
        
        if (telefono_whatsapp) {
            // Normalizamos el teléfono a 10 dígitos -> +521...
            const digits = telefono_whatsapp.replace(/\D/g, ''); // Quitar no-dígitos
            if (digits.length === 10) {
                const telefonoNormalizado = `+521${digits}`;
                updatesSupabase.telefono_whatsapp = telefonoNormalizado;
                updatesStripe.phone = telefonoNormalizado;
            } else if (digits.length > 0) {
                // Si el usuario escribió algo, pero no son 10 dígitos
                return res.status(400).json({ error: 'El número de WhatsApp debe tener 10 dígitos.' });
            }
        }
        
        // 2. Actualizar nuestra tabla 'clientes' en Supabase
        console.log('[PERFIL] Actualizando Supabase...');
        const { error: updateError } = await supabase
            .from('clientes')
            .update(updatesSupabase)
            .eq('id', cliente.id);

        if (updateError) throw updateError;

        // 3. (IMPORTANTE) Actualizar el cliente en Stripe
        if (Object.keys(updatesStripe).length > 0) {
            console.log('[PERFIL] Actualizando Stripe...');
            await stripe.customers.update(cliente.stripe_customer_id, updatesStripe);
        }

        res.status(200).json({ message: 'Perfil actualizado exitosamente.' });
    } catch (err) {
        console.error("Error actualizando perfil:", err.message);
        res.status(500).json({ error: 'Error interno al actualizar el perfil.' });
    }
});

app.post('/api/cancelar-suscripcion', verificarUsuario, async (req, res) => {
  const { device_id } = req.body;
  const userId = req.user.id;
  try {
    const { data: cliente, error: clienteError } = await supabase
      .from('clientes')
      .select('id, stripe_subscription_id')
      .eq('auth_user_id', userId)
      .single();
    if (clienteError) throw new Error("Cliente no encontrado.");

    const stripeSubscriptionId = cliente.stripe_subscription_id;
    if (!stripeSubscriptionId) {
      return res.status(404).json({ error: 'No se encontró una suscripción activa de Stripe para este usuario.' });
    }

    await stripe.subscriptions.update(stripeSubscriptionId, {
      cancel_at_period_end: true
    });
    console.log(`Suscripción ${stripeSubscriptionId} marcada para cancelar al final del período.`);

    await supabase
      .from('clientes')
      .update({ subscription_status: 'cancelled' })
      .eq('id', cliente.id);

    await supabase
      .from('dispositivos_lete')
      .update({ estado: 'cancelled' })
      .eq('device_id', device_id);

    res.status(200).json({ message: 'Tu suscripción ha sido programada para cancelación. No se te volverá a cobrar.' });
  } catch (err) {
    console.error("Error cancelando suscripción:", err);
    res.status(500).json({ error: err.message });
  }
});

// --- 6. RUTAS DE ADMINISTRACIÓN (Internas) ---
app.get('/api/admin/get-plans', async (req, res) => {
  try {
    const { data, error } = await supabase.from('planes_lete').select('id, nombre_plan, precio').order('precio', { ascending: true });
    if (error) throw error;
    res.status(200).json(data);
  } catch (err) {
    console.error("Error obteniendo planes:", err.message);
    res.status(500).json({ error: 'Error interno al obtener planes.' });
  }
});

app.post('/api/admin/provision-device', async (req, res) => {
  const {
    secret_key, device_id, plan_id,
    voltage_cal, power_cal,
    current_cal_1, current_cal_2, current_cal_3,
    current_cal_4, current_cal_5, current_cal_6, current_cal_7
  } = req.body;

  if (secret_key !== process.env.ADMIN_SECRET_KEY) {
    return res.status(403).json({ error: 'Acceso denegado: Llave secreta inválida.' });
  }

  const datosDispositivo = {
    device_id, plan_id, voltage_cal, power_cal, 
    data_server_url: '34.53.115.235', // <-- VALOR FIJO
    estado: 'sin_vender',
    ...(current_cal_1 != null && current_cal_1 !== '' && { current_cal_1 }),
    ...(current_cal_2 != null && current_cal_2 !== '' && { current_cal_2 }),
    ...(current_cal_3 != null && current_cal_3 !== '' && { current_cal_3 }),
    ...(current_cal_4 != null && current_cal_4 !== '' && { current_cal_4 }),
    ...(current_cal_5 != null && current_cal_5 !== '' && { current_cal_5 }),
    ...(current_cal_6 != null && current_cal_6 !== '' && { current_cal_6 }),
    ...(current_cal_7 != null && current_cal_7 !== '' && { current_cal_7 }),
  };

  try {
    const { data: dispositivoGuardado, error } = await supabase
      .from('dispositivos_lete')
      .insert(datosDispositivo)
      .select()
      .single();

    if (error) {
      if (error.code === '23505') {
        return res.status(409).json({ error: `El device_id '${device_id}' ya existe en el inventario.` });
      }
      throw new Error(`Error en DB al insertar: ${error.message}`);
    }

    const registroUrl = `https://api.mrfrio.mx/registro.html?dispositivo=${device_id}`;
    const qrImageDataUrl = await QRCode.toDataURL(registroUrl);

    res.status(201).json({
      dispositivo: dispositivoGuardado,
      qrCodeDataUrl: qrImageDataUrl
    });
  } catch (err) {
    console.error("Error aprovisionando dispositivo:", err.message);
    res.status(500).json({ error: 'Error interno del servidor al aprovisionar.' });
  }
});

// --- 8. INICIAR EL SERVIDOR ---
app.listen(port, () => {
  console.log(`✅ Servidor "Mr. Frío" corriendo en el puerto ${port}`);
  if (!process.env.SUPABASE_URL) console.warn("AVISO: SUPABASE_URL no está definida.");
  if (!process.env.SUPABASE_SERVICE_KEY) console.warn("AVISO: SUPABASE_SERVICE_KEY no está definida.");
  if (!process.env.STRIPE_SECRET_KEY) console.warn("AVISO: STRIPE_SECRET_KEY no está definida.");
  if (!process.env.STRIPE_WEBHOOK_SECRET) console.warn("AVISO: STRIPE_WEBHOOK_SECRET no está definida.");
});