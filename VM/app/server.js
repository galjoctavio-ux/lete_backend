// --- 1. IMPORTAR LIBRERÍAS ---
require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const fetch = require('node-fetch'); // Ya lo estabas usando, perfecto
const QRCode = require('qrcode');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { Resend } = require('resend');
const fs = require('fs').promises;
const path = require('path');
const { createProxyMiddleware } = require('http-proxy-middleware');
const twilio = require('twilio');
const { InfluxDB } = require('@influxdata/influxdb-client'); // <-- AÑADIR ESTA LÍNEA
const { GoogleGenerativeAI } = require('@google/generative-ai');
const QuickChart = require('quickchart-js');

const resend = new Resend(process.env.RESEND_API_KEY);
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// --- NUEVA CONSTANTE DE TELEGRAM ---
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN; // ¡Asegúrate de que esté en tu .env!

// --- GUARDIÁN DE VARIABLES DE ENTORNO ---
if (!process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_KEY.length < 150) {
    console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
    console.error("ERROR CRÍTICO: ¡SUPABASE_SERVICE_KEY no está cargada o está incompleta!");
    // ... (resto del guardián)
    process.exit(1); 
}
// --- FIN DEL GUARDIÁN ---

// --- ¡NUEVA CONFIGURACIÓN DE INFLUXDB! ---
const influxUrl = process.env.INFLUX_URL;
const influxToken = process.env.INFLUX_TOKEN;
const influxOrg = process.env.INFLUX_ORG;
const influxBucket = process.env.INFLUX_BUCKET_new; // Usamos el bucket de tu python

if (!influxUrl || !influxToken || !influxOrg || !influxBucket) {
    console.warn("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
    console.warn("AVISO: Faltan variables de entorno de InfluxDB (URL, TOKEN, ORG, BUCKET).");
    console.warn("El bot de Telegram no podrá consultar mediciones.");
    console.warn("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
}
const influxClient = new InfluxDB({ url: influxUrl, token: influxToken });
const queryApi = influxClient.getQueryApi(influxOrg);
// --- FIN DE CONFIGURACIÓN INFLUXDB ---

// --- ¡NUEVA CONFIGURACIÓN DE GEMINI! ---
const geminiApiKey = process.env.GEMINI_API_KEY;
if (!geminiApiKey) {
    console.warn("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
    console.warn("AVISO: Falta GEMINI_API_KEY. El 'Policía' de IA no funcionará.");
    console.warn("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
}
const genAI = new GoogleGenerativeAI(geminiApiKey);
const geminiModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

// --- ¡NUEVA CONFIGURACIÓN DE CHATWOOT! ---
const chatwootUrl = process.env.CHATWOOT_URL;
const chatwootAccountId = process.env.CHATWOOT_ACCOUNT_ID;
const chatwootToken = process.env.CHATWOOT_API_ACCESS_TOKEN;

if (!chatwootUrl || !chatwootAccountId || !chatwootToken) {
    console.warn("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
    console.warn("AVISO: Faltan variables de Chatwoot. El desvío a soporte humano no funcionará.");
    console.warn("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
}
// --- FIN DE CONFIGURACIONES NUEVAS ---

// --- 2. CONFIGURACIÓN INICIAL ---
const app = express();
const port = process.env.PORT || 3000;
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
const supabaseUrl = process.env.SUPABASE_URL;

app.use(express.static(path.join(__dirname, 'public')));

app.get('/test-pdf', (req, res) => {
    const pdfPath = path.join(__dirname, 'public', 'Instrucciones.pdf');
    const existe = require('fs').existsSync(pdfPath); // Usamos sync aquí por simplicidad
    console.log(`[TEST-PDF] Buscando PDF en: ${pdfPath}`);
    console.log(`[TEST-PDF] ¿Existe? ${existe}`);
        
    if (existe) {
        res.send(`✅ El PDF SÍ existe en: ${pdfPath}`);
    } else {
        res.status(404).send(`❌ PDF NO encontrado en: ${pdfPath}`);
    }
});

// --- CONFIGURACIÓN DEL PROXY DE AUTENTICACIÓN ---
console.log(`[INIT] Creando proxy para /auth/v1 -> ${supabaseUrl}`);
app.use('/auth/v1', createProxyMiddleware({
    target: supabaseUrl,
    changeOrigin: true,
    ws: true,
    logLevel: 'debug',
    
    pathRewrite: (path, req) => {
        const newPath = '/auth/v1' + path;
        console.log(`[PROXY REWRITE] Ruta original: ${path}. Nueva ruta: ${newPath}`);
        return newPath;
    },

    onProxyReq: (proxyReq, req, res) => {
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

// --- RUTA WEBHOOK DE STRIPE ---
// (Esta ruta se define ANTES de app.use(express.json()))
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
      
      if (clienteExistente && clienteExistente.stripe_subscription_id) {
        console.log(`[DEBUG] ⚠️ Webhook duplicado para cliente ${cliente_id}. Ya tiene una suscripción. Ignorando.`);
        return res.status(200).send({ received: true, skipped: 'already_processed' });
      }
      
      console.log(`[DEBUG] Cliente ${cliente_id} validado, procediendo a activar.`);

      const subscription = await stripe.subscriptions.retrieve(stripeSubscriptionId);
      const fechaInicio = new Date();
      let fechaProximoPago;
      if (subscription.trial_end) {
        fechaProximoPago = new Date(subscription.trial_end * 1000);
      } else if (subscription.current_period_end) {
        fechaProximoPago = new Date(subscription.current_period_end * 1000);
      } else {
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

      // 2. Actualizar la tabla 'dispositivos_lete'
      console.log(`[DEBUG] Actualizando tabla 'dispositivos_lete' para device_id: ${device_id}`);
      // ... (Toda la lógica de diagnóstico de dispositivos que ya tenías...)
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
      console.log(`[DEBUG] ✅ Dispositivo actualizado correctamente a 'vendido'.`);
            
      // --- NUEVA LÓGICA DE BIENVENIDA ---
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

      // Leer y personalizar la plantilla HTML de bienvenida
      console.log(`[DEBUG] Leyendo plantilla de correo bienvenida.html...`);
      let htmlBody;
      try {
          const plantillaPath = path.join(__dirname, 'email-templates', 'bienvenida.html');
          htmlBody = await fs.readFile(plantillaPath, 'utf-8');
          htmlBody = htmlBody.replace(/{{NombreDelCliente}}/g, nombreCliente)
                              .replace(/{{FechaDelProximoPago}}/g, fechaPagoFormateada)
                              .replace(/{{user_email}}/g, email);
      } catch (readError) {
          console.error("[DEBUG] ❌ ERROR CRÍTICO: No se pudo leer la plantilla bienvenida.html.", readError.message);
          htmlBody = `<h1>¡Hola y bienvenido a Cuentatrón!</h1><p>Tu suscripción ha sido activada exitosamente.</p><p>Puedes acceder a tu panel de control en https://www.tesivil.com/mi-cuenta.html</p>`;
      }

      // Enviar correo de bienvenida
      console.log(`[DEBUG] Enviando correo de bienvenida (plantilla HTML) a ${email}...`);
      await resend.emails.send({
          from: 'Cuentatrón <bienvenido@tesivil.com>',
          to: [email],
          subject: '¡Bienvenido a Cuentatrón! Siguientes Pasos 🚀',
          html: htmlBody
      });
      console.log("[DEBUG] ✅ Correo de bienvenida enviado con éxito.");

      // Enviar mensaje de WhatsApp
      if (telefono_whatsapp) {
          console.log(`[DEBUG] Enviando WhatsApp de bienvenida a ${telefono_whatsapp}...`);
          try {
              await twilioClient.messages.create({
                  body: `¡Hola ${nombreCliente}! 👋 Bienvenido a Cuentatrón. Tu suscripción está activa y tu dispositivo está listo para ser instalado. Revisa tu correo (${email}) para ver las instrucciones.`,
                  from: process.env.TWILIO_FROM_NUMBER, // Usa tu variable de entorno
                  to: `whatsapp:${telefono_whatsapp}`
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

// --- LÓGICA DE NEGOCIO Y REGLAS (Port de Python) ---
const IVA = 1.16;
const TARIFAS_CFE = {
    '01': [
        { hasta_kwh: 150, precio: 1.08 },
        { hasta_kwh: 280, precio: 1.32 },
        { hasta_kwh: Infinity, precio: 3.85 }
    ],
    '01A': [
        { hasta_kwh: 150, precio: 1.08 },
        { hasta_kwh: 300, precio: 1.32 },
        { hasta_kwh: Infinity, precio: 3.85 }
    ],
    'PDBT': [
        { hasta_kwh: Infinity, precio: 5.60 }
    ],
    'DAC': [
        { hasta_kwh: Infinity, precio: 7.80 }
    ]
};
// --- FIN DE LÓGICA DE NEGOCIO ---

// --- AHORA SÍ, USAMOS express.json() PARA EL RESTO DE RUTAS ---
app.use(express.json());

// --- ¡NUEVO ENDPOINT! WEBHOOK DE CHATWOOT (VERSIÓN FINAL v6) ---
app.post('/api/chatwoot-webhook', async (req, res) => {
    const event = req.body;

    try {
        // --- CASO 1: Mensaje nuevo de un agente ---
        if (event.event === 'message_created' && 
            event.message_type === 'outgoing' && 
            event.private === false) {

            console.log('[CHATWOOT WEBHOOK] Es una respuesta de un agente.');
            const agentMessage = event.content;
            const telegram_chat_id = event.conversation?.meta?.sender?.identifier;

            if (telegram_chat_id) {
                if (agentMessage) {
                    console.log(`[CHATWOOT WEBHOOK] Reenviando a Telegram (${telegram_chat_id}): ${agentMessage}`);
                    await enviarMensajeTelegram(telegram_chat_id, agentMessage);
                } else {
                    console.warn(`[CHATWOOT WEBHOOK] El mensaje del agente no tenía contenido de texto. No se reenvió.`);
                }
            } else {
                console.warn('[CHATWOOT WEBHOOK] (message_created) NO SE ENCONTRÓ EL CHAT_ID en event.conversation.meta.sender.identifier');
            }
        
        // --- CASO 2: El estado de la conversación cambió ---
        } else if (event.event === 'conversation_status_changed') {
            
            console.log(`[CHATWOOT WEBHOOK] Cambio de estado detectado: ${event.status}`);
            const telegram_chat_id = event.meta?.sender?.identifier;

            if (event.status === 'resolved' && telegram_chat_id) {
                console.log(`[POLICIA] Chatwoot resolvió el chat. Devolviendo control a Gemini para ${telegram_chat_id}.`);
                
                // 1. Limpiamos el temporizador en la DB
                await supabase
                    .from('clientes')
                    .update({ en_chat_humano_hasta: null }) 
                    .eq('telegram_chat_id', telegram_chat_id);
                
                // --- ¡NUEVA LÍNEA! Notificamos al usuario ---
                await enviarMensajeTelegram(telegram_chat_id, 
                    "✅ ¡Chat finalizado! Tu conversación con nuestro agente ha terminado. El asistente de IA (yo) vuelve a tomar el control.\n\nSi tienes otra duda o problema, solo escribe de nuevo."
                );
            
            } else if (event.status === 'resolved') {
                console.warn(`[CHATWOOT WEBHOOK] (status_changed) El chat se resolvió, pero NO SE PUDO encontrar el telegram_chat_id.`);
            }
        }

    } catch (err) {
        console.error('[CHATWOOT WEBHOOK] Error fatal en el webhook:', err.message);
    }

    // Responder siempre 200 a Chatwoot
    res.sendStatus(200);
});

// --- ¡NUEVA FUNCIÓN DE AYUDA PARA TELEGRAM! ---
async function enviarMensajeTelegram(chat_id, text) {
  // Solo envía si tenemos un token configurado
  if (!TELEGRAM_BOT_TOKEN) {
    console.error("[TELEGRAM] Error: TELEGRAM_BOT_TOKEN no está en .env. No se puede enviar mensaje.");
    return;
  }
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id, text, parse_mode: 'Markdown' })
    });
    const json = await response.json();
    if (json.ok) {
        console.log(`[TELEGRAM] Mensaje enviado a ${chat_id}`);
    } else {
        console.error(`[TELEGRAM] Error API: ${json.description}`);
    }
  } catch (error) {
    console.error(`[TELEGRAM] Error enviando mensaje a ${chat_id}:`, error.message);
  }
}

// --- ¡NUEVO ENDPOINT! WEBHOOK DE TELEGRAM (v2 - Flujo por Email) ---
app.post('/api/telegram-webhook', async (req, res) => {
  const update = req.body;

  // Asegurarnos de que es un mensaje de texto
  if (!update.message || !update.message.text) {
    return res.sendStatus(200); // Responder OK, pero no hacer nada
  }

  const chat_id = update.message.chat.id.toString(); // Guardar siempre como string
  const textoRecibido = update.message.text.trim();

  console.log(`[TELEGRAM] Mensaje recibido de ${chat_id}: ${textoRecibido}`);

  try {
    // Caso 1: El usuario envía /start
    if (textoRecibido === '/start') {
      await enviarMensajeTelegram(chat_id, 
        "¡Hola! 👋 Bienvenido a las alertas de Cuentatrón.\n\nPara vincular tu cuenta, por favor escribe el correo electrónico que registraste."
      );
    } 
    // Caso 2: El usuario envía un email
    else if (isValidEmail(textoRecibido)) {
      const email = textoRecibido.toLowerCase();
      console.log(`[TELEGRAM] ${chat_id} envió un email: ${email}. Buscando...`);
      
      // 1. Buscar cliente por email
      const { data: cliente, error } = await supabase
        .from('clientes')
        .select('id, nombre, telegram_chat_id')
        .eq('email', email)
        .single();

      if (error || !cliente) {
        console.warn(`[TELEGRAM] Email no encontrado: ${email}`);
        await enviarMensajeTelegram(chat_id, "❌ Lo siento, no encontré ese correo. Verifica que esté escrito correctamente o intenta con otro.");
        return res.sendStatus(200);
      }
      
      // Chequeo: ¿Ya está vinculado a ESTE chat?
      if (cliente.telegram_chat_id === chat_id) {
         await enviarMensajeTelegram(chat_id, `✅ Este chat ya está vinculado a tu cuenta (${cliente.nombre}).`);
         return res.sendStatus(200);
      }

      // 2. Generar código y expiración (10 minutos)
      const codigo = crypto.randomInt(100000, 999999).toString(); // 6 dígitos
      const expires_at = new Date(Date.now() + 10 * 60 * 1000).toISOString();

      // 3. Guardar en Supabase
      const { error: updateError } = await supabase
        .from('clientes')
        .update({
          telegram_link_code: codigo,
          telegram_link_expires_at: expires_at
        })
        .eq('id', cliente.id);
      
      if (updateError) throw updateError;
      
      console.log(`[TELEGRAM] Código ${codigo} generado para ${email}. Enviando email con Resend...`);

      // 4. Enviar email con Resend (¡ya lo tienes configurado!)
      await resend.emails.send({
          from: 'Cuentatrón <bienvenido.cuentatron@tesivil.com>',
          to: [email],
          subject: `Tu código de Cuentatrón: ${codigo}`,
          html: `<h1>Tu código de un solo uso</h1>
                 <p>Hola ${cliente.nombre || 'cliente'},</p>
                 <p>Usa el siguiente código para vincular tu cuenta de Telegram. Este código expira en 10 minutos.</p>
                 <h2 style="font-size: 32px; letter-spacing: 4px; text-align: center;">${codigo}</h2>`
      });
      
      // 5. Responder en Telegram
      await enviarMensajeTelegram(chat_id, "✅ ¡Perfecto! Te acabo de enviar un código de 6 dígitos a tu correo. Por favor, escríbelo en este chat para confirmar.");
    }
    // Caso 3: El usuario envía un código de 6 dígitos
    else if (/^\d{6}$/.test(textoRecibido)) {
      const codigo = textoRecibido;
      console.log(`[TELEGRAM] ${chat_id} envió un código: ${codigo}. Verificando...`);

      // 1. Buscar el código en la DB (y que no haya expirado)
      const { data: cliente, error } = await supabase
        .from('clientes')
        .select('id, nombre')
        .eq('telegram_link_code', codigo)
        .gt('telegram_link_expires_at', 'now()') // ¡Importante! Revisa que aún sea válido
        .single();

      if (error || !cliente) {
        console.warn(`[TELEGRAM] Código ${codigo} no válido o expirado.`);
        await enviarMensajeTelegram(chat_id, "❌ Código incorrecto o expirado. Por favor, envía tu email de nuevo para generar otro código.");
        return res.sendStatus(200);
      }
      
      // 2. ¡Éxito! Vincular la cuenta
      console.log(`[TELEGRAM] Código VÁLIDO. Vinculando chat_id ${chat_id} con cliente ${cliente.id} (${cliente.nombre})`);
      
      const { error: updateError } = await supabase
        .from('clientes')
        .update({
          telegram_chat_id: chat_id,        // ¡La vinculación oficial!
          telegram_link_code: null,         // Limpiar código
          telegram_link_expires_at: null    // Limpiar expiración
        })
        .eq('id', cliente.id);
      
      if (updateError) throw updateError;
      
      await enviarMensajeTelegram(chat_id, `✅ ¡Cuenta vinculada! A partir de ahora recibirás tus alertas aquí, ${cliente.nombre}.`);
    }
    // Caso 4: Mensaje genérico / Comando
    else {
      // 1. ¿Este chat_id está vinculado a un cliente?
      console.log(`[TELEGRAM] Buscando cliente para chat_id: ${chat_id}`); // <-- Log de depuración
      
      const { data: cliente, error: clienteError } = await supabase
        .from('clientes')
        .select(`
          id, 
          nombre, 
          email,
          telefono_whatsapp,
          telegram_chat_id,
          en_chat_humano_hasta,
          dia_de_corte,                 
          ciclo_bimestral,              
          fecha_inicio_servicio,        
          lectura_cierre_periodo_anterior, 
          lectura_medidor_inicial,  
          tipo_tarifa,
          fecha_proximo_pago,
          alerta_fuga_activa,
          alerta_voltaje_estado,     
          dispositivos_lete ( device_id )
        `)
        .eq('telegram_chat_id', chat_id)
        .limit(1)
        .single();

      // 1a. Si NO está vinculado O HUBO UN ERROR, recordarle
      if (clienteError || !cliente) {
        
        // --- ¡NUEVO BLOQUE DE DIAGNÓSTICO! ---
        if (clienteError) {
            console.error(`[TELEGRAM DB ERROR] Falló la consulta de cliente:`, clienteError.message);
        }
        // --- FIN DE DIAGNÓSTICO ---
        
        console.log(`[TELEGRAM] Chat ${chat_id} no vinculado envió: ${textoRecibido}`);
        await enviarMensajeTelegram(chat_id, "No entendí ese comando. Si quieres vincular tu cuenta, envía tu correo electrónico.");
        return res.sendStatus(200);
      }
      
      console.log(`[TELEGRAM] Cliente encontrado: ${cliente.nombre} (ID: ${cliente.id})`); // <-- Log de depuración
      
      // 1b. Si SÍ está vinculado, ¡procesar!
      // (En el futuro, aquí revisaremos 'en_chat_humano_hasta' para el Policía)
      
      // Obtenemos el primer device_id asociado a este cliente
      // Nota: .select() con JOIN devuelve un array
      const device_id = cliente.dispositivos_lete[0]?.device_id;
      
      if (!device_id) {
         await enviarMensajeTelegram(chat_id, "Tu cuenta está vinculada, pero no encontramos un dispositivo activo. Contacta a soporte.");
         return res.sendStatus(200);
      }

      console.log(`[TELEGRAM] Comando de ${cliente.nombre} (${device_id}): ${textoRecibido}`);
      const comando = textoRecibido.toLowerCase().trim().replace('/', '');

      // --- PROCESADOR DE COMANDOS (REFACTORIZADO Y CORREGIDO) ---
      switch (comando) {
        
        case 'voltaje':
          await handleVoltaje(chat_id, device_id);
          break;

        case 'watts':
        case 'potencia':
          await handleWatts(chat_id, device_id);
          break;

        case 'consumo_hoy':
        case 'consumo_de_hoy':
        case 'hoy':
          await handleConsumoHoy(chat_id, device_id, cliente);
          break;

        case 'consumo_ayer':
        case 'consumo_de_ayer':
        case 'ayer':
          await handleConsumoAyer(chat_id, device_id, cliente);
          break;

        case 'grafica_ayer':
        case 'grafica':
          await handleGraficaAyer(chat_id, device_id);
          break;

        case 'grafica_semanal':
        case 'semanal':
          await handleGraficaSemanal(chat_id, device_id);
          break;

        case 'usar_telegram': {
          console.log(`[PREFERENCIA] ${cliente.nombre} solicita cambiar a Telegram.`);
          try {
            await supabase
              .from('clientes')
              .update({ prefiere_telegram: true })
              .eq('id', cliente.id);
            await enviarMensajeTelegram(chat_id, "✅ ¡Listo! A partir de ahora, tus reportes diarios y alertas llegarán *solo* por Telegram.");
          } catch (err) {
            console.error(`[DB ERR] Error al cambiar preferencia a Telegram: ${err.message}`);
            await enviarMensajeTelegram(chat_id, "Hubo un error al guardar tu preferencia. Por favor, intenta de nuevo.");
          }
          break;
        }

        case 'usar_whatsapp': {
          console.log(`[PREFERENCIA] ${cliente.nombre} solicita cambiar a WhatsApp.`);
          try {
            await supabase
              .from('clientes')
              .update({ prefiere_telegram: false })
              .eq('id', cliente.id);
            await enviarMensajeTelegram(chat_id, "✅ ¡Entendido! Tus reportes diarios y alertas volverán a enviarse por WhatsApp.");
          } catch (err) {
            console.error(`[DB ERR] Error al cambiar preferencia a WhatsApp: ${err.message}`);
            await enviarMensajeTelegram(chat_id, "Hubo un error al guardar tu preferencia. Por favor, intenta de nuevo.");
          }
          break;
        }

        // --- LOS CASES 'agregar_numero' Y 'quitar_numero' HAN SIDO ELIMINADOS ---

        default: { // <-- LÓGICA DEL "ASISTENTE" (v2)
          console.log(`[ASISTENTE] Mensaje no reconocido de ${cliente.nombre}. Iniciando lógica de IA.`);
          
          // 1. Lógica "Policía": ¿Está en un chat humano?
          const ahora = new Date();
          const fechaLimiteHumano = cliente.en_chat_humano_hasta ? new Date(cliente.en_chat_humano_hasta) : null;

          // --- Escenario 1: Chat Humano ACTIVO ---
          if (fechaLimiteHumano && fechaLimiteHumano > ahora) {
            console.log(`[POLICIA] Chat humano activo. Reenviando a Chatwoot y reiniciando timer.`);
            await reenviarAChatwoot(cliente, textoRecibido); 
            const nuevaHoraLimite = new Date(Date.now() + 60 * 60 * 1000).toISOString();
            await supabase
                .from('clientes')
                .update({ en_chat_humano_hasta: nuevaHoraLimite })
                .eq('id', cliente.id);
            // NO respondemos nada. El agente humano lo hará.
          
          // --- Escenario 2: Chat Humano INACTIVO (Llamar al Asistente Gemini) ---
          } else {
            console.log(`[ASISTENTE] Chat humano inactivo. Llamando a Gemini v2...`);
            
            // ¡Llama al nuevo cerebro que detecta MÚLTIPLES intenciones!
            const respuestaGemini = await llamarAGemini(textoRecibido);
            const intencion = respuestaGemini.intencion;

            console.log(`[ASISTENTE] Intención detectada: ${intencion}`);

            // --- ¡NUEVO! Router de Intenciones (v4 - Diagnósticos) ---
            switch (intencion) {
                
                // --- Caso 1: Soporte Humano ---
                case 'soporte_humano':
                  console.log(`[ASISTENTE] Detectó 'soporte_humano'. Transfiriendo a Chatwoot.`);
                  await reenviarAChatwoot(cliente, textoRecibido);
                  const horaLimite = new Date(Date.now() + 60 * 60 * 1000).toISOString();
                  await supabase
                      .from('clientes')
                      .update({ en_chat_humano_hasta: horaLimite })
                      .eq('id', cliente.id);
                  await enviarMensajeTelegram(chat_id, "Entendido, tu mensaje requiere atención especial. Estoy transfiriendo tu chat, un momento por favor... 🧑‍💻");
                  break;

                // --- Casos 2-8: NUEVAS Funciones de Diagnóstico ---
                case 'pedir_proyeccion_pago':
                  await handleProyeccionPago(chat_id, device_id, cliente);
                  break;
                case 'pedir_diagnostico_fuga_tierra':
                  await handleDiagnosticoFugaTierra(chat_id, cliente);
                  break;
                case 'pedir_diagnostico_fantasma':
                  await handleDiagnosticoFantasma(chat_id, device_id);
                  break;
                case 'pedir_diagnostico_voltaje':
                  await handleDiagnosticoVoltaje(chat_id, device_id, cliente);
                  break;
                case 'pedir_hora_pico':
                  await handleHoraPico(chat_id, device_id);
                  break;
                case 'pedir_fecha_corte_cfe':
                  await handleFechaCorteCFE(chat_id, cliente);
                  break;
                case 'pedir_pago_cuentatron':
                  await handlePagoCuentatron(chat_id, cliente);
                  break;

                // --- Caso 9: FAQ Empresa ---
                case 'faq_servicios_empresa':
                  console.log("[ASISTENTE] Detectó 'faq_servicios_empresa'. Generando respuesta...");
                  await enviarMensajeTelegram(chat_id, "Consultando al experto... 🧠");
                  const respuestaFAQ = await handleFAQServicios(textoRecibido); 
                  await enviarMensajeTelegram(chat_id, respuestaFAQ);
                  break;

                // --- Casos 10-15: Comandos de Datos (los que ya teníamos) ---
                case 'pedir_consumo_hoy':
                  await handleConsumoHoy(chat_id, device_id, cliente);
                  break;
                case 'pedir_consumo_ayer':
                  await handleConsumoAyer(chat_id, device_id, cliente);
                  break;
                case 'pedir_voltaje':
                  await handleVoltaje(chat_id, device_id);
                  break;
                case 'pedir_watts':
                  await handleWatts(chat_id, device_id);
                  break;
                case 'pedir_grafica_ayer':
                  await handleGraficaAyer(chat_id, device_id);
                  break;
                case 'pedir_grafica_semanal':
                  await handleGraficaSemanal(chat_id, device_id);
                  break;

                // --- Caso 16: Desconocido ---
                case 'desconocido':
                default:
                  console.log(`[ASISTENTE] Gemini detectó 'desconocido'. Respondiendo con menú.`);
                  await enviarMensajeTelegram(chat_id, 
                    "¡Hola, soy tu asistente de energía! Puedes pedirme cosas como:\n\n" +
                    "📊 *Diagnósticos y Proyecciones*\n" +
                    "- _'¿Cuánto voy a pagar de luz?'_\n" +
                    "- _'¿Mi voltaje es normal?'_\n" +
                    "- _'¿Tengo una fuga de corriente?'_\n" +
                    "- _'¿Tengo consumo fantasma?'_\n" +
                    "- _'¿A qué hora del día gasto más?'_\n\n" +
                    "🗓️ *Fechas y Datos Rápidos*\n" +
                    "- _'¿Cuánto gasté ayer?'_\n" +
                    "- _'Muéstrame la gráfica semanal.'_\n" +
                    "- _'¿Cuándo es mi corte de CFE?'_\n" +
                    "- _'¿Cuándo pago mi suscripción?'_\n\n" +
                    "Si tienes un problema o una pregunta diferente (como '¿qué es un volt?' o '¿ustedes instalan focos?'), solo escríbelo y te ayudaré."
                  );
                  break;
            }
          }
          break; 
        } // <-- Cierre de las llaves del default
      }
    }

  } catch (err) {
    console.error("[TELEGRAM] Error fatal en el webhook:", err.message);
    // Enviar un mensaje de error al usuario si es posible
    await enviarMensajeTelegram(chat_id, "Ocurrió un error en el servidor. Por favor, intenta más tarde.");
  }

  res.sendStatus(200); // Siempre responder 200 a Telegram
});


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

// --- FUNCIÓN DE AYUDA: VALIDAR EMAIL ---
function isValidEmail(email) {
  const re = /^(([^<>()[\]\\.,;:\s@"]+(\.[^<>()[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/;
  return re.test(String(email).toLowerCase());
}

// --- FUNCIÓN DE AYUDA: CALCULAR COSTO CFE (Port de Python) ---
function calcularCostoEstimadoJS(kwh_consumidos, tipo_tarifa) {
    if (!TARIFAS_CFE[tipo_tarifa]) {
        console.warn(`⚠️ Advertencia: Tarifa '${tipo_tarifa}' no reconocida. No se puede calcular el costo.`);
        return 0.0;
    }
    let costo_sin_iva = 0.0;
    let kwh_restantes = kwh_consumidos;
    let limite_anterior = 0;
    for (const escalon of TARIFAS_CFE[tipo_tarifa]) {
        const limite_actual = escalon.hasta_kwh;
        const kwh_en_este_escalon = Math.min(kwh_restantes, limite_actual - limite_anterior);
        costo_sin_iva += kwh_en_este_escalon * escalon.precio;
        kwh_restantes -= kwh_en_este_escalon;
        if (kwh_restantes <= 0) break;
        limite_anterior = limite_actual;
    }
    return costo_sin_iva * IVA;
}

// --- FUNCIÓN DE AYUDA: OBTENER RANGOS DE FECHA (HOY/AYER) ---
function getFechasParaQuery(tipo) {
    const zonaHoraria = 'America/Mexico_City';
    const ahora = new Date(new Date().toLocaleString('en-US', { timeZone: zonaHoraria }));

    let inicio, fin;

    if (tipo === 'hoy') {
        inicio = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate(), 0, 0, 0);
        fin = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate(), 23, 59, 59);
    } else if (tipo === 'ayer') {
        const ayer = new Date(ahora.getTime() - 24 * 60 * 60 * 1000);
        inicio = new Date(ayer.getFullYear(), ayer.getMonth(), ayer.getDate(), 0, 0, 0);
        fin = new Date(ayer.getFullYear(), ayer.getMonth(), ayer.getDate(), 23, 59, 59);
    }

    // Devolvemos las fechas en formato ISO 8601 UTC, requerido por Flux
    return {
        start: inicio.toISOString(),
        stop: fin.toISOString()
    };
}

// --- FUNCIÓN DE AYUDA: OBTENER RANGO SEMANAL ---
function getFechasParaQuerySemanal() {
    const zonaHoraria = 'America/Mexico_City';
    const ahora = new Date(new Date().toLocaleString('en-US', { timeZone: zonaHoraria }));

    // Fin: Hoy a las 23:59:59
    const fin = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate(), 23, 59, 59);

    // Inicio: 6 días ANTES de hoy (para un total de 7 días)
    const inicio = new Date(ahora.getTime() - 6 * 24 * 60 * 60 * 1000);
    inicio.setHours(0, 0, 0, 0); // Lo ponemos a las 00:00:00

    // Devolvemos las fechas en formato ISO 8601 UTC
    return {
        start: inicio.toISOString(),
        stop: fin.toISOString()
    };
}

// --- ¡NUEVO BLOQUE! FUNCIONES DE ACCIÓN PARA EL BOT ---
// (Estas son las funciones que sacamos del 'switch')

async function handleVoltaje(chat_id, device_id) {
  const fluxQuery = `
    from(bucket: "${influxBucket}")
      |> range(start: 0)
      |> filter(fn: (r) => r._measurement == "energia")
      |> filter(fn: (r) => r._field == "vrms")
      |> filter(fn: (r) => r.device_id == "${device_id}")
      |> last()
  `;
  console.log(`[INFLUX] Ejecutando query para ${device_id}: ${fluxQuery.replace(/\s+/g, ' ')}`);
  try {
    let voltaje = null;
    let timestamp = null;
    for await (const { values, tableMeta } of queryApi.iterateRows(fluxQuery)) {
      const o = tableMeta.toObject(values);
      voltaje = o._value;
      timestamp = o._time;
    }
    if (voltaje !== null) {
      const fechaReporte = new Date(timestamp).toLocaleString('es-MX', { timeZone: 'America/Mexico_City' });
      await enviarMensajeTelegram(chat_id, `⚡ El último voltaje reportado fue: *${voltaje.toFixed(2)} V* (registrado el ${fechaReporte})`);
    } else {
      await enviarMensajeTelegram(chat_id, "No pude encontrar ningún dato de voltaje para tu dispositivo. ¿Está tu dispositivo conectado y enviando datos?");
    }
  } catch (err) {
    console.error(`[INFLUX ERR] Error consultando voltaje: ${err.message}`);
    await enviarMensajeTelegram(chat_id, "Hubo un error al consultar la base de datos de mediciones.");
  }
}

async function handleWatts(chat_id, device_id) {
  const fluxQueryWatts = `
    from(bucket: "${influxBucket}")
      |> range(start: 0)
      |> filter(fn: (r) => r._measurement == "energia")
      |> filter(fn: (r) => r._field == "power")
      |> filter(fn: (r) => r.device_id == "${device_id}")
      |> last()
  `;
  console.log(`[INFLUX] Ejecutando query para ${device_id}: ${fluxQueryWatts.replace(/\s+/g, ' ')}`);
  try {
    let watts = null;
    let timestampWatts = null;
    for await (const { values, tableMeta } of queryApi.iterateRows(fluxQueryWatts)) {
      const o = tableMeta.toObject(values);
      watts = o._value;
      timestampWatts = o._time;
    }
    if (watts !== null) {
      const fechaReporte = new Date(timestampWatts).toLocaleString('es-MX', { timeZone: 'America/Mexico_City' });
      await enviarMensajeTelegram(chat_id, `💡 El último consumo instantáneo fue: *${watts.toFixed(2)} W* (registrado el ${fechaReporte})`);
    } else {
      await enviarMensajeTelegram(chat_id, "No pude encontrar ningún dato de potencia (Watts) para tu dispositivo.");
    }
  } catch (err) {
    console.error(`[INFLUX ERR] Error consultando watts: ${err.message}`);
    await enviarMensajeTelegram(chat_id, "Hubo un error al consultar la base de datos de mediciones.");
  }
}

async function handleConsumoHoy(chat_id, device_id, cliente) {
  const fechasHoy = getFechasParaQuery('hoy');
  const fluxQueryHoy = `
    from(bucket: "${influxBucket}")
      |> range(start: ${fechasHoy.start}, stop: ${fechasHoy.stop})
      |> filter(fn: (r) => r._measurement == "energia")
      |> filter(fn: (r) => r._field == "power")
      |> filter(fn: (r) => r.device_id == "${device_id}")
      |> integral(unit: 1s)
      |> map(fn: (r) => ({ _value: r._value / 3600000.0 }))
      |> sum()
  `;
  console.log(`[INFLUX] Ejecutando query para ${device_id}: ${fluxQueryHoy.replace(/\s+/g, ' ')}`);
  try {
    let consumoHoy = null;
    for await (const { values, tableMeta } of queryApi.iterateRows(fluxQueryHoy)) {
      const o = tableMeta.toObject(values);
      consumoHoy = o._value;
    }
    let mensaje = "Aún no se registran datos de consumo para el día de hoy.";
    if (consumoHoy !== null) {
      mensaje = `📊 Tu consumo acumulado de *hoy* es: *${consumoHoy.toFixed(3)} kWh*`;
    }
    
    // --- ¡NUEVA LÓGICA DE COSTO! ---
    const { kwh_periodo_actual, error_periodo } = await getConsumoAcumuladoPeriodo(cliente, device_id);
    if (!error_periodo) {
        // 1. Calcular el costo
        const costo_periodo_actual = calcularCostoEstimadoJS(kwh_periodo_actual, cliente.tipo_tarifa);
        
        // 2. Añadir ambas cosas al mensaje
        mensaje += `\n\nLlevas un total de *${kwh_periodo_actual.toFixed(3)} kWh* acumulados en tu periodo actual, con un costo estimado de *$${costo_periodo_actual.toFixed(2)}*.`;
    }
    // --- FIN DE LÓGICA NUEVA ---
    
    await enviarMensajeTelegram(chat_id, mensaje);
  } catch (err) {
    console.error(`[INFLUX ERR] Error consultando consumo_hoy: ${err.message}`);
    await enviarMensajeTelegram(chat_id, "Hubo un error al calcular tu consumo de hoy.");
  }
}

async function handleConsumoAyer(chat_id, device_id, cliente) {
  const fechasAyer = getFechasParaQuery('ayer');
  const fluxQueryAyer = `
    from(bucket: "${influxBucket}")
      |> range(start: ${fechasAyer.start}, stop: ${fechasAyer.stop})
      |> filter(fn: (r) => r._measurement == "energia")
      |> filter(fn: (r) => r._field == "power")
      |> filter(fn: (r) => r.device_id == "${device_id}")
      |> integral(unit: 1s)
      |> map(fn: (r) => ({ _value: r._value / 3600000.0 }))
      |> sum()
  `;
  console.log(`[INFLUX] Ejecutando query para ${device_id}: ${fluxQueryAyer.replace(/\s+/g, ' ')}`);
  try {
    let consumoAyer = null;
    for await (const { values, tableMeta } of queryApi.iterateRows(fluxQueryAyer)) {
      const o = tableMeta.toObject(values);
      consumoAyer = o._value;
    }
    let mensaje = "No se encontraron datos de consumo para el día de ayer.";
    if (consumoAyer !== null) {
      mensaje = `🗓️ Tu consumo total de *ayer* fue: *${consumoAyer.toFixed(3)} kWh*`;
    }

    // --- ¡NUEVA LÓGICA DE COSTO! ---
    const { kwh_periodo_actual, error_periodo } = await getConsumoAcumuladoPeriodo(cliente, device_id);
    if (!error_periodo) {
        // 1. Calcular el costo
        const costo_periodo_actual = calcularCostoEstimadoJS(kwh_periodo_actual, cliente.tipo_tarifa);
        
        // 2. Añadir ambas cosas al mensaje
        mensaje += `\n\nLlevas un total de *${kwh_periodo_actual.toFixed(3)} kWh* acumulados en tu periodo actual, con un costo estimado de *$${costo_periodo_actual.toFixed(2)}*.`;
    }
    // --- FIN DE LÓGICA NUEVA ---

    await enviarMensajeTelegram(chat_id, mensaje);
  } catch (err) {
    console.error(`[INFLUX ERR] Error consultando consumo_ayer: ${err.message}`);
    await enviarMensajeTelegram(chat_id, "Hubo un error al calcular tu consumo de ayer.");
  }
}

async function handleGraficaAyer(chat_id, device_id) {
  console.log(`[GRAFICA] Solicitando gráfica de ayer para ${device_id}`);
  const fechasAyer = getFechasParaQuery('ayer');
  const fluxQueryGrafica = `
    from(bucket: "${influxBucket}")
      |> range(start: ${fechasAyer.start}, stop: ${fechasAyer.stop})
      |> filter(fn: (r) => r._measurement == "energia")
      |> filter(fn: (r) => r._field == "power")
      |> filter(fn: (r) => r.device_id == "${device_id}")
      |> aggregateWindow(every: 1h, fn: mean, createEmpty: false)
      |> yield(name: "mean")
  `;
  const labels = [];
  const dataPoints = [];
  try {
    console.log(`[INFLUX GRAFICA] Ejecutando query: ${fluxQueryGrafica.replace(/\s+/g, ' ')}`);
    for await (const { values, tableMeta } of queryApi.iterateRows(fluxQueryGrafica)) {
      const o = tableMeta.toObject(values);
      const hora = new Date(o._time).toLocaleTimeString('es-MX', { 
          hour: '2-digit', 
          minute: '2-digit', 
          timeZone: 'America/Mexico_City' 
      });
      labels.push(hora);
      dataPoints.push(o._value.toFixed(2));
    }
    if (dataPoints.length === 0) {
      await enviarMensajeTelegram(chat_id, "No encontré suficientes datos de ayer para generar una gráfica.");
      return; // Usamos return en lugar de break
    }
    const chart = new QuickChart();
    chart.setWidth(500).setHeight(300).setBackgroundColor('#ffffff');
    chart.setConfig({
      type: 'line',
      data: {
        labels: labels,
        datasets: [{
          label: 'Consumo (Watts)',
          data: dataPoints,
          fill: false,
          borderColor: 'rgb(75, 192, 192)',
          tension: 0.1
        }]
      },
      options: { title: { display: true, text: 'Consumo Promedio (Watts) de Ayer' } }
    });
    const chartUrl = await chart.getShortUrl();
    console.log(`[GRAFICA] URL de QuickChart generada: ${chartUrl}`);
    await enviarMensajeTelegram(chat_id, chartUrl);
  } catch (err) {
    console.error(`[INFLUX ERR] Error generando gráfica: ${err.message}`);
    await enviarMensajeTelegram(chat_id, "Hubo un error al generar tu gráfica de ayer.");
  }
}

async function handleGraficaSemanal(chat_id, device_id) {
  console.log(`[GRAFICA] Solicitando gráfica semanal para ${device_id}`);
  const fechasSemana = getFechasParaQuerySemanal();
  const fluxQuerySemanal = `
    from(bucket: "${influxBucket}")
      |> range(start: ${fechasSemana.start}, stop: ${fechasSemana.stop})
      |> filter(fn: (r) => r._measurement == "energia")
      |> filter(fn: (r) => r._field == "power")
      |> filter(fn: (r) => r.device_id == "${device_id}")
      |> aggregateWindow(every: 1d, fn: integral, createEmpty: false)
      |> map(fn: (r) => ({ _time: r._time, _value: r._value / 3600000.0 }))
      |> yield(name: "sum")
  `;
  const labels = [];
  const dataPoints = [];
  try {
    console.log(`[INFLUX GRAFICA] Ejecutando query: ${fluxQuerySemanal.replace(/\s+/g, ' ')}`);
    for await (const { values, tableMeta } of queryApi.iterateRows(fluxQuerySemanal)) {
      const o = tableMeta.toObject(values);
      const dia = new Date(o._time).toLocaleDateString('es-MX', {
          weekday: 'short',
          day: '2-digit',
          month: '2-digit',
          timeZone: 'America/Mexico_City'
      });
      labels.push(dia.replace('.', ''));
      dataPoints.push(o._value.toFixed(3));
    }
    if (dataPoints.length === 0) {
      await enviarMensajeTelegram(chat_id, "No encontré suficientes datos de los últimos 7 días para generar una gráfica.");
      return; // Usamos return en lugar de break
    }
    const chart = new QuickChart();
    chart.setWidth(500).setHeight(300).setBackgroundColor('#ffffff');
    chart.setConfig({
      type: 'bar',
      data: {
        labels: labels,
        datasets: [{
          label: 'Consumo (kWh)',
          data: dataPoints,
          backgroundColor: 'rgba(54, 162, 235, 0.6)'
        }]
      },
      options: { title: { display: true, text: 'Consumo Diario (kWh) - Últimos 7 Días' } }
    });
    const chartUrl = await chart.getShortUrl();
    console.log(`[GRAFICA] URL de QuickChart generada: ${chartUrl}`);
    await enviarMensajeTelegram(chat_id, chartUrl);
  } catch (err) {
    console.error(`[INFLUX ERR] Error generando gráfica: ${err.message}`);
    await enviarMensajeTelegram(chat_id, "Hubo un error al generar tu gráfica semanal.");
  }
}

// --- ¡NUEVO BLOQUE! FUNCIONES DE DIAGNÓSTICO Y CUENTA ---

async function handleProyeccionPago(chat_id, device_id, cliente) {
    await enviarMensajeTelegram(chat_id, "Consultando al experto... 🧠");
    try {
        // 1. Obtener consumo acumulado (ya lo tenemos)
        const { kwh_periodo_actual, error_periodo } = await getConsumoAcumuladoPeriodo(cliente, device_id);
        if (error_periodo) throw new Error(error_periodo);

        // 2. Calcular fechas y días
        const zonaHoraria = 'America/Mexico_City';
        const hoy_date_obj = new Date(new Date().toLocaleString('en-US', { timeZone: zonaHoraria }));
        const hoy_aware = {
            date: new Date(hoy_date_obj.getFullYear(), hoy_date_obj.getMonth(), hoy_date_obj.getDate())
        };
        const { ultima_fecha_de_corte, proxima_fecha_de_corte } = calcularFechasCorteJS(hoy_aware, cliente.dia_de_corte, cliente.ciclo_bimestral);
        
        if (!ultima_fecha_de_corte || !proxima_fecha_de_corte) throw new Error("No se pudieron calcular las fechas del ciclo.");

        const dias_transcurridos = Math.max(1, (hoy_aware.date - ultima_fecha_de_corte) / (1000 * 60 * 60 * 24));
        const dias_totales_del_ciclo = (proxima_fecha_de_corte - ultima_fecha_de_corte) / (1000 * 60 * 60 * 24);

        // 3. Calcular proyección
        const promedio_diario_real = kwh_periodo_actual / dias_transcurridos;
        const proyeccion_kwh = promedio_diario_real * dias_totales_del_ciclo;
        const costo_proyectado = calcularCostoEstimadoJS(proyeccion_kwh, cliente.tipo_tarifa);

        // 4. Formatear respuesta
        let mensaje = `¡Hola ${cliente.nombre}! Basado en tu consumo hasta hoy, aquí tienes tu proyección para este bimestre:\n\n` +
                      `Llevas *${kwh_periodo_actual.toFixed(2)} kWh* consumidos en ${dias_transcurridos.toFixed(0)} días.\n` +
                      `Tu promedio es de *${promedio_diario_real.toFixed(2)} kWh* por día.\n\n` +
                      `Si continúas a este ritmo, tu proyección de pago de CFE será de aprox.:\n` +
                      `**$${costo_proyectado.toFixed(2)} MXN** (IVA incluido).`;
        
        await enviarMensajeTelegram(chat_id, mensaje);

    } catch (err) {
        console.error(`[ERR Proyección Pago] ${err.message}`);
        await enviarMensajeTelegram(chat_id, "Tuve problemas para calcular tu proyección. Intenta más tarde.");
    }
}

async function handleDiagnosticoFugaTierra(chat_id, cliente) {
    await enviarMensajeTelegram(chat_id, "Consultando al experto... 🧠");
    // Lógica simple: solo leemos la bandera que actualiza el script de Python
    if (cliente.alerta_fuga_activa === true) {
        await enviarMensajeTelegram(chat_id, "⚠️ **¡Alerta!** Mi sistema de vigilancia (que corre cada hora) **sí ha detectado una fuga de corriente a tierra** en tu instalación.\n\nEsto es un riesgo de seguridad y puede aumentar tu recibo. Te recomendamos contactar a un electricista certificado lo antes posible.");
    } else {
        await enviarMensajeTelegram(chat_id, "✅ **¡Buenas noticias!** Mi sistema de vigilancia **no detecta una fuga a tierra** activa en este momento.\n\n¿Te gustaría que revise si tienes 'consumo fantasma' (aparatos gastando sin uso)?");
    }
}

async function handleDiagnosticoFantasma(chat_id, device_id) {
    await enviarMensajeTelegram(chat_id, "Consultando al experto.... 🧠");
    // Query a Influx por el consumo base de las últimas 3 madrugadas (3-5 AM)
    const fluxQueryFantasma = `
        import "date" // <-- 1. Importar el paquete

        from(bucket: "${influxBucket}")
          |> range(start: -3d)
          |> filter(fn: (r) => r._measurement == "energia" and r._field == "power" and r.device_id == "${device_id}")
          // --- 2. USAR EL PAQUETE ---
          |> filter(fn: (r) => date.hour(t: r._time) >= 3 and date.hour(t: r._time) < 5) 
          |> mean()
    `;
    try {
        let consumoBase = 0.0;
        for await (const { values, tableMeta } of queryApi.iterateRows(fluxQueryFantasma)) {
            const o = tableMeta.toObject(values);
            consumoBase = o._value || 0.0;
        }

        let mensaje = `Analicé tu consumo de las últimas madrugadas (3-5 AM) para buscar "consumo fantasma":\n\n` +
                      `Tu consumo base constante es de **${consumoBase.toFixed(1)} Watts**.\n\n`;

        if (consumoBase <= 50) {
            mensaje += "¡Felicidades! Ese es un consumo base muy bajo, probablemente solo tu refrigerador y módems.";
        } else if (consumoBase <= 150) {
            mensaje += "Esto es normal si incluye tu refri, módems y algún decodificador de TV. Si te parece alto, prueba desconectando cargadores o TVs que no estés usando.";
        } else {
            mensaje += "¡Es un consumo base algo alto! Es muy probable que tengas aparatos " +
                       "como computadoras, consolas o TVs en 'standby' gastando energía sin necesidad. ¡Desconéctalos por la noche y ahorra!";
        }
        await enviarMensajeTelegram(chat_id, mensaje);
    } catch (err) {
        console.error(`[ERR Fantasma] ${err.message}`);
        await enviarMensajeTelegram(chat_id, "Tuve problemas para calcular tu consumo fantasma. Intenta más tarde.");
    }
}

async function handleDiagnosticoVoltaje(chat_id, device_id, cliente) {
    await enviarMensajeTelegram(chat_id, "Consultando al experto... 🧠");
    
    // Lógica simple: leemos el estado que actualiza el script de Python
    const estado = cliente.alerta_voltaje_estado;

    if (estado === 'alto') {
        await enviarMensajeTelegram(chat_id, "⚡ **¡Cuidado!** Mi sistema de vigilancia (que corre cada hora) ha detectado **picos de voltaje ALTO** (arriba de 132V) recientemente en tu instalación.\n\nEsto puede dañar electrónicos sensibles. Te recomendamos usar reguladores.");
    } else if (estado === 'bajo') {
        await enviarMensajeTelegram(chat_id, "📉 **¡Atención!** Mi sistema de vigilancia ha detectado **caídas de voltaje BAJO** (debajo de 108V) recientemente.\n\nEl voltaje bajo puede forzar y dañar motores (refrigerador, bombas). Sería bueno que un electricista revise.");
    } else {
        // Si el estado es 'normal', le damos el dato en tiempo real
        await enviarMensajeTelegram(chat_id, "Revisé el estado de tu voltaje y mi sistema de vigilancia reporta que está **normal y estable**.");
        // Opcional: Llamar a la función que ya teníamos
        await handleVoltaje(chat_id, device_id);
    }
}

async function handleHoraPico(chat_id, device_id) {
    await enviarMensajeTelegram(chat_id, "Consultando al experto... 🧠");
    
    // --- ¡QUERY CORREGIDA! ---
    // Esta query agrupa todas las "1 AMs", "2 AMs", etc. de los últimos 7 días,
    // calcula el PROMEDIO de cada hora, y luego ordena para encontrar la más alta.
    const fluxQueryPico = `
        import "date"
        
        from(bucket: "${influxBucket}")
          |> range(start: -7d)
          |> filter(fn: (r) => r._measurement == "energia" and r._field == "power" and r.device_id == "${device_id}")
          // 1. Añadimos una columna "hour" (0-23) a cada registro
          |> map(fn: (r) => ({ r with hour: date.hour(t: r._time) }))
          // 2. Agrupamos todos los registros por esa "hour"
          |> group(columns: ["hour"])
          // 3. Calculamos el promedio de 'power' para cada grupo de hora
          |> mean(column: "_value")
          // 4. Ordenamos de mayor a menor consumo
          |> sort(columns: ["_value"], desc: true)
          // 5. Tomamos solo el #1
          |> limit(n: 1)
    `;
    
    try {
        console.log(`[INFLUX HORA PICO] Ejecutando query: ${fluxQueryPico.replace(/\s+/g, ' ')}`);
        let horaPico = null; // Será un número de 0-23
        let valorPico = 0.0; // Será el promedio en Watts

        // El loop solo correrá una vez gracias a limit(n: 1)
        for await (const { values, tableMeta } of queryApi.iterateRows(fluxQueryPico)) {
            const o = tableMeta.toObject(values);
            horaPico = o.hour; // <-- Leemos la columna 'hour'
            valorPico = o._value;
        }
        
        if (horaPico !== null) {
            // --- Formateamos la hora (ej. 17 -> "5 PM" y 18 -> "6 PM") ---
            const horaSiguiente = (horaPico + 1) % 24;
            
            // Creamos un objeto de fecha falso solo para usar el formateador
            const fechaHoraPico = new Date(2000, 0, 1, horaPico);
            const fechaHoraSiguiente = new Date(2000, 0, 1, horaSiguiente);

            const horaFormateada = fechaHoraPico.toLocaleTimeString('es-MX', {
                hour: 'numeric', hour12: true, timeZone: 'America/Mexico_City'
            });
            const horaSiguienteFormateada = fechaHoraSiguiente.toLocaleTimeString('es-MX', {
                hour: 'numeric', hour12: true, timeZone: 'America/Mexico_City'
            });

            await enviarMensajeTelegram(chat_id, `Analizando tu última semana, tu "hora pico" de consumo (la hora en que *en promedio* gastas más) es entre las **${horaFormateada} y las ${horaSiguienteFormateada}**, con un consumo promedio de **${valorPico.toFixed(0)} Watts**.`);
        } else {
            await enviarMensajeTelegram(chat_id, "No tengo suficientes datos de la semana para encontrar tu 'hora pico'.");
        }
    } catch (err) {
        console.error(`[ERR Hora Pico] ${err.message}`);
        await enviarMensajeTelegram(chat_id, "Tuve problemas para calcular tu hora pico. Intenta más tarde.");
    }
}

async function handleFechaCorteCFE(chat_id, cliente) {
    const zonaHoraria = 'America/Mexico_City';
    const hoy_date_obj = new Date(new Date().toLocaleString('en-US', { timeZone: zonaHoraria }));
    const hoy_aware = {
        date: new Date(hoy_date_obj.getFullYear(), hoy_date_obj.getMonth(), hoy_date_obj.getDate())
    };
    const { proxima_fecha_de_corte } = calcularFechasCorteJS(hoy_aware, cliente.dia_de_corte, cliente.ciclo_bimestral);
    
    if (proxima_fecha_de_corte) {
        const fechaFormateada = proxima_fecha_de_corte.toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric' });
        await enviarMensajeTelegram(chat_id, `🗓️ Según tu configuración, tu próxima fecha de corte de CFE es el **${fechaFormateada}**.`);
    } else {
        await enviarMensajeTelegram(chat_id, "No pude determinar tu próxima fecha de corte. Verifica tu configuración en el panel web.");
    }
}

async function handlePagoCuentatron(chat_id, cliente) {
    if (cliente.fecha_proximo_pago) {
        const fechaFormateada = new Date(cliente.fecha_proximo_pago).toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric' });
        await enviarMensajeTelegram(chat_id, `💳 Tu suscripción a Cuentatrón se renueva el **${fechaFormateada}**.`);
    } else {
        await enviarMensajeTelegram(chat_id, "No encontré una fecha de renovación para tu suscripción. Contacta a soporte.");
    }
}

async function handleFAQServicios(textoUsuario) {
    // Usamos la función que ya teníamos, pero con un contexto específico
    if (!geminiApiKey) return "Lo siento, mi módulo de IA no está disponible.";
    
    console.log(`[GEMINI FAQ Empresa] Generando respuesta para: "${textoUsuario}"`);
    try {
        const prompt = `
            Eres un asistente de Cuentatrón, experto en monitoreo de energía.
            Tu trabajo NO es vender, sino aclarar qué servicios ofreces.
            Tu servicio es monitorear, NO reparar ni instalar.
            Responde la siguiente pregunta del usuario de forma amigable, breve, y dejando claro que Cuentatrón solo monitorea.
            
            Pregunta: "${textoUsuario}"
        `;
        const result = await geminiModel.generateContent(prompt);
        const response = await result.response;
        return response.text();
    } catch (error) {
        console.error(`[GEMINI ERR] Error al GENERAR respuesta de servicios: ${error.message}`);
        return "Tuve un problema al procesar tu pregunta.";
    }
}
// ... (después de handleGraficaSemanal)

async function generarRespuestaFAQ(textoUsuario) {
    if (!geminiApiKey) return "Lo siento, mi módulo de IA no está disponible en este momento.";
    
    console.log(`[GEMINI FAQ] Generando respuesta para: "${textoUsuario}"`);
    try {
        // Un prompt simple que le pide actuar como experto
        const prompt = `
            Eres un asistente de Cuentatrón, experto en energía eléctrica.
            Responde la siguiente pregunta del usuario de forma breve, amigable y fácil de entender en español.
            
            Pregunta: "${textoUsuario}"
        `;
        const result = await geminiModel.generateContent(prompt);
        const response = await result.response;
        return response.text(); // Devolvemos el texto generado
    } catch (error) {
        console.error(`[GEMINI ERR] Error al GENERAR respuesta: ${error.message}`);
        return "Tuve un problema al procesar tu pregunta. ¿Puedes intentar de nuevo?";
    }
}

// --- FUNCIÓN DE AYUDA: CALCULAR FECHAS DE CORTE...
// ... (el resto de tus funciones)

// --- FIN DEL NUEVO BLOQUE ---

// --- FUNCIÓN DE AYUDA: CALCULAR FECHAS DE CORTE (Port de Python) ---
// (Necesita la función getFechasParaQuery para la zona horaria)
function calcularFechasCorteJS(hoy_aware, dia_de_corte, ciclo_bimestral) {
    const hoy = hoy_aware.date; // Obtenemos la fecha 'pura'
    
    // Función interna para obtener el último día del mes (JS-compatible)
    function getLastDayOfMonth(year, month_js) { // month_js es 0-11
        return new Date(year, month_js + 1, 0).getDate();
    }

    let candidatos_pasados = [];
    for (let i = 0; i < 12; i++) {
        let mes_candidato_py = hoy.getMonth() + 1 - i; // +1 para ser 1-12 (Python style)
        let ano_candidato = hoy.getFullYear();
        
        if (mes_candidato_py <= 0) {
            mes_candidato_py += 12;
            ano_candidato -= 1;
        }

        const es_mes_par = (mes_candidato_py % 2 === 0);
        if ((ciclo_bimestral === 'par' && es_mes_par) || (ciclo_bimestral === 'impar' && !es_mes_par)) {
            try {
                // mes_candidato_py - 1 para convertir a 0-11 (JS style)
                const dia = Math.min(dia_de_corte, getLastDayOfMonth(ano_candidato, mes_candidato_py - 1));
                const fecha_candidata = new Date(ano_candidato, mes_candidato_py - 1, dia);
                
                if (fecha_candidata <= hoy) {
                    candidatos_pasados.push(fecha_candidata);
                }
            } catch (e) { /* Ignorar fechas inválidas */ }
        }
    }
    
    if (candidatos_pasados.length === 0) return { ultima_fecha_de_corte: null, proxima_fecha_de_corte: null };

    // Ordenar fechas (JS no tiene max() para fechas) y tomar la más reciente
    candidatos_pasados.sort((a, b) => b - a);
    const ultima_fecha_de_corte = candidatos_pasados[0];

    let mes_proximo_py = ultima_fecha_de_corte.getMonth() + 1 + 2; // +1 para 1-12
    let ano_proximo = ultima_fecha_de_corte.getFullYear();
    if (mes_proximo_py > 12) {
        mes_proximo_py -= 12;
        ano_proximo += 1;
    }

    // mes_proximo_py - 1 para convertir a 0-11 (JS style)
    const dia_proximo = Math.min(dia_de_corte, getLastDayOfMonth(ano_proximo, mes_proximo_py - 1));
    const proxima_fecha_de_corte = new Date(ano_proximo, mes_proximo_py - 1, dia_proximo);

    return { ultima_fecha_de_corte, proxima_fecha_de_corte };
}

// --- FUNCIÓN DE AYUDA: OBTENER CONSUMO ACUMULADO DEL PERIODO ---
async function getConsumoAcumuladoPeriodo(cliente, device_id) {
    // 1. Obtener fechas del periodo
    const zonaHoraria = 'America/Mexico_City';
    const hoy_date_obj = new Date(new Date().toLocaleString('en-US', { timeZone: zonaHoraria }));
    const hoy_aware = {
        date: new Date(hoy_date_obj.getFullYear(), hoy_date_obj.getMonth(), hoy_date_obj.getDate())
    };

    const { ultima_fecha_de_corte, proxima_fecha_de_corte } = calcularFechasCorteJS(
        hoy_aware,
        cliente.dia_de_corte,
        cliente.ciclo_bimestral
    );

    if (!ultima_fecha_de_corte) {
        return { kwh_periodo_actual: 0, error_periodo: "No se pudo calcular el periodo." };
    }

    // 2. Lógica de "Primer Periodo" (Port de Python)
    const fecha_inicio_servicio_date = new Date(cliente.fecha_inicio_servicio);
    let fecha_inicio_periodo_influx = ultima_fecha_de_corte;

    if (fecha_inicio_servicio_date && fecha_inicio_servicio_date > ultima_fecha_de_corte) {
        fecha_inicio_periodo_influx = fecha_inicio_servicio_date;
        console.log(`   -> [ACUMULADO] Cliente en primer periodo (instaló el ${fecha_inicio_servicio_date}).`);
    }

    // 3. Calcular consumo "acarreado"
    let kwh_acarreados = 0.0;
    if (fecha_inicio_servicio_date && 
        fecha_inicio_servicio_date > ultima_fecha_de_corte && 
        cliente.lectura_medidor_inicial && 
        cliente.lectura_cierre_periodo_anterior) {
        
        kwh_acarreados = parseFloat(cliente.lectura_medidor_inicial) - parseFloat(cliente.lectura_cierre_periodo_anterior);
        console.log(`   -> [ACUMULADO] Lógica de Primer Periodo. Acarreados: ${kwh_acarreados.toFixed(2)} kWh`);
    }

    // 4. Consultar InfluxDB para el consumo medido
    const inicio_periodo_influx_iso = fecha_inicio_periodo_influx.toISOString();
    
    // (Query hasta ahora)
    const fluxQueryAcumulado = `
        from(bucket: "${influxBucket}")
          |> range(start: ${inicio_periodo_influx_iso}) 
          |> filter(fn: (r) => r._measurement == "energia")
          |> filter(fn: (r) => r._field == "power")
          |> filter(fn: (r) => r.device_id == "${device_id}")
          |> integral(unit: 1s)
          |> map(fn: (r) => ({ _value: r._value / 3600000.0 }))
          |> sum()
    `;

    let kwh_medidos_influx = 0.0;
    try {
        console.log(`[INFLUX ACUM] Ejecutando query para ${device_id}: ${fluxQueryAcumulado.replace(/\s+/g, ' ')}`);
        for await (const { values, tableMeta } of queryApi.iterateRows(fluxQueryAcumulado)) {
            const o = tableMeta.toObject(values);
            kwh_medidos_influx = o._value || 0.0;
        }
    } catch (err) {
        console.error(`[INFLUX ERR] Error consultando acumulado: ${err.message}`);
        return { kwh_periodo_actual: 0, error_periodo: "Error consultando InfluxDB para el acumulado." };
    }

    // 5. El consumo total del periodo es la suma de ambos
    const kwh_periodo_actual = kwh_acarreados + kwh_medidos_influx;
    console.log(`   -> [ACUMULADO] Medido Influx: ${kwh_medidos_influx.toFixed(2)} kWh. Total periodo: ${kwh_periodo_actual.toFixed(2)} kWh`);

    return { kwh_periodo_actual, error_periodo: null };
}


// --- FUNCIÓN DE AYUDA: LLAMAR A GEMINI (v4 - Con Diagnósticos) ---
async function llamarAGemini(textoUsuario) {
    if (!geminiApiKey) return { intencion: 'desconocido' };
    try {
        const prompt = `
          Eres un asistente de IA para "Cuentatrón", un servicio de monitoreo de energía.
          Tu trabajo es clasificar la intención del usuario en UNA de las siguientes categorías.
          Responde SOLAMENTE con un objeto JSON válido con la clave "intencion".

          --- CATEGORÍAS DE INTENCIÓN ---

          1. "soporte_humano":
             - El usuario está frustrado, enojado, confundido, quiere cancelar, o pide un humano.
             - Ejemplos: "Esto no sirve", "Quiero cancelar", "ayuda por favor", "mi dispositivo está en rojo"

          2. "pedir_proyeccion_pago":
             - El usuario quiere saber cuánto va a pagar de luz en su recibo.
             - Ejemplos: "¿Cuánto voy a pagar de luz?", "¿De cuánto va a llegar mi recibo?", "dame mi proyección de pago"

          3. "pedir_diagnostico_fuga_tierra":
             - El usuario pregunta si tiene una fuga de corriente o fuga a tierra.
             - Ejemplos: "¿Tengo una fuga?", "¿Por qué me llegó una alerta de fuga?", "revisa si tengo fugas"

          4. "pedir_diagnostico_fantasma":
             - El usuario pregunta por consumo "vampiro" o "fantasma", o consumo base.
             - Ejemplos: "¿Tengo consumo fantasma?", "¿Cuánto gasto en la madrugada?"

          5. "pedir_diagnostico_voltaje":
             - El usuario pregunta si su voltaje es normal, alto o bajo.
             - Ejemplos: "¿Mi voltaje está bien?", "¿Es normal el voltaje?", "revisa mi voltaje"
          
          6. "pedir_hora_pico":
             - El usuario pregunta a qué hora del día consume más energía.
             - Ejemplos: "¿A qué hora gasto más luz?", "dame mi hora pico"

          7. "pedir_fecha_corte_cfe":
             - El usuario pregunta por su fecha de corte de CFE.
             - Ejemplos: "¿Cuándo es mi corte de CFE?", "¿Cuándo pago la luz?"

          8. "pedir_pago_cuentatron":
             - El usuario pregunta por su pago del servicio Cuentatrón.
             - Ejemplos: "¿Cuándo pago Cuentatrón?", "fecha de pago de mi suscripción"

          9. "faq_servicios_empresa":
             - El usuario pregunta por servicios que no ofreces (instalaciones, reparaciones).
             - Ejemplos: "¿Ustedes pueden cambiar mi foco?", "¿Reparan refrigeradores?"

          10. "pedir_consumo_hoy":
              - Ejemplos: "¿Cuánto he gastado hoy?", "consumo de hoy"

          11. "pedir_consumo_ayer":
              - Ejemplos: "¿Cuánto consumí ayer?", "reporte de ayer"
          
          12. "pedir_voltaje":
              - Ejemplos: "¿Cómo está el voltaje?", "dame el voltaje"
          
          13. "pedir_watts":
              - Ejemplos: "¿Cuántos watts estoy gastando?", "potencia actual"
          
          14. "pedir_grafica_ayer":
              - Ejemplos: "muéstrame la gráfica de ayer", "quiero ver la gráfica"
          
          15. "pedir_grafica_semanal":
              - Ejemplos: "muéstrame la gráfica de la semana", "consumo semanal"

          16. "desconocido":
              - Saludos, gracias, o algo no relacionado.
              - Ejemplos: "hola", "gracias", "ok"

          ---
          Mensaje del usuario a clasificar:
          "${textoUsuario}"
        `;
        
        const result = await geminiModel.generateContent(prompt);
        const response = await result.response;
        const text = response.text();
        const jsonText = text.replace(/```json/g, '').replace(/```/g, '').trim();
        console.log(`[GEMINI v4] Respuesta cruda: ${text}. JSON Limpio: ${jsonText}`);
        return JSON.parse(jsonText);

    } catch (error) {
        console.error(`[GEMINI ERR] Error al llamar a la API: ${error.message}`);
        return { intencion: 'desconocido' };
    }
}

// --- FUNCIÓN DE AYUDA: REENVIAR A CHATWOOT (El "Oficial") ---
// (Esta función es compleja, maneja la API de Chatwoot)
//
// --- ¡¡VERSIÓN CORREGIDA!! ---
//
// --- FUNCIÓN DE AYUDA: REENVIAR A CHATWOOT (v4 - Sincronizado) ---
async function reenviarAChatwoot(cliente, texto) {
    if (!chatwootUrl || !chatwootAccountId || !chatwootToken) return;

    const INBOX_ID_TELEGRAM = '83046'; // <-- ID de tu bandeja
    const headers = {
        'Content-Type': 'application/json; charset=utf-8',
        'api_access_token': chatwootToken
    };
    let contact_id;

    try {
        // --- Paso 1: Buscar, Crear O ACTUALIZAR Contacto ---
        if (!cliente.email) {
            console.error(`[CHATWOOT ERR] El cliente ${cliente.id} no tiene email.`);
            return;
        }
        const urlSearch = `${chatwootUrl}/api/v1/accounts/${chatwootAccountId}/contacts/search?q=${encodeURIComponent(cliente.email)}`;
        let response = await fetch(urlSearch, { method: 'GET', headers });
        let data = await response.json();
        
        if (data.payload.length > 0) {
            // --- Contacto Encontrado ---
            contact_id = data.payload[0].id;
            const chatwootIdentifier = data.payload[0].identifier;
            
            console.log(`[CHATWOOT] Contacto encontrado por email (${cliente.email}): ${contact_id}`);

            // --- ¡NUEVA LÓGICA DE ACTUALIZACIÓN! ---
            // Comparamos el ID de Chatwoot con el ID de Supabase
            if (chatwootIdentifier !== cliente.telegram_chat_id) {
                console.warn(`[CHATWOOT SYNC] ¡Identifier desactualizado! Actualizando ${chatwootIdentifier} -> ${cliente.telegram_chat_id}`);
                
                const urlUpdateContact = `${chatwootUrl}/api/v1/accounts/${chatwootAccountId}/contacts/${contact_id}`;
                const updatePayload = {
                    identifier: cliente.telegram_chat_id // Actualizamos el ID de Telegram
                };
                // Usamos PATCH para actualizar solo este campo
                await fetch(urlUpdateContact, { 
                    method: 'PATCH', 
                    headers, 
                    body: JSON.stringify(updatePayload) 
                });
            }
            // --- FIN DE LÓGICA DE ACTUALIZACIÓN ---

        } else {
            // --- Contacto No Encontrado ---
            console.log(`[CHATWOOT] Contacto no encontrado, creando uno nuevo...`);
            const urlCreateContact = `${chatwootUrl}/api/v1/accounts/${chatwootAccountId}/contacts`;
            const contactPayload = {
                name: cliente.nombre,
                email: cliente.email,
                phone_number: cliente.telefono_whatsapp || undefined,
                identifier: cliente.telegram_chat_id // Guardamos el ID correcto
            };
            response = await fetch(urlCreateContact, { method: 'POST', headers, body: JSON.stringify(contactPayload) });
            data = await response.json();
            contact_id = data.payload.contact.id;
            console.log(`[CHATWOOT] Contacto creado: ${contact_id}`);
        }

        // --- Paso 2: Buscar Conversación (Lógica de Historial) ---
        const urlBuscarConversaciones = `${chatwootUrl}/api/v1/accounts/${chatwootAccountId}/contacts/${contact_id}/conversations`;
        response = await fetch(urlBuscarConversaciones, { method: 'GET', headers });
        data = await response.json();

        if (!response.ok) throw new Error("No se pudieron buscar conversaciones.");

        let conversacion = data.payload.find(conv => 
            conv.inbox_id.toString() === INBOX_ID_TELEGRAM && conv.status === 'open'
        );

        if (conversacion) {
            // --- Escenario A: Conversación ABIERTA encontrada ---
            console.log(`[CHATWOOT] Conversación abierta encontrada: ${conversacion.id}. Añadiendo mensaje...`);
            const urlAddMessage = `${chatwootUrl}/api/v1/accounts/${chatwootAccountId}/conversations/${conversacion.id}/messages`;
            const messagePayload = { content: texto, message_type: "incoming" };
            await fetch(urlAddMessage, { method: 'POST', headers, body: JSON.stringify(messagePayload) });
            console.log(`[CHATWOOT] Mensaje añadido a conversación ${conversacion.id}`);
            
        } else {
            conversacion = data.payload.find(conv => 
                conv.inbox_id.toString() === INBOX_ID_TELEGRAM && conv.status === 'resolved'
            );

            if (conversacion) {
                // --- Escenario B: Conversación RESUELTA encontrada ---
                console.log(`[CHATWOOT] Conversación resuelta encontrada: ${conversacion.id}. Reabriendo y añadiendo mensaje...`);
                const urlAddMessage = `${chatwootUrl}/api/v1/accounts/${chatwootAccountId}/conversations/${conversacion.id}/messages`;
                const messagePayload = { content: texto, message_type: "incoming" };
                await fetch(urlAddMessage, { method: 'POST', headers, body: JSON.stringify(messagePayload) });
                
                const urlToggleStatus = `${chatwootUrl}/api/v1/accounts/${chatwootAccountId}/conversations/${conversacion.id}/toggle_status`;
                await fetch(urlToggleStatus, { 
                    method: 'POST', 
                    headers, 
                    body: JSON.stringify({ status: 'open' })
                });
                console.log(`[CHATWOOT] Conversación ${conversacion.id} re-abierta.`);

            } else {
                // --- Escenario C: No hay historial. Crear una nueva ---
                console.log(`[CHATWOOT] No hay conversación abierta o resuelta. Creando una nueva...`);
                const urlCreateConversation = `${chatwootUrl}/api/v1/accounts/${chatwootAccountId}/conversations`;
                const conversationPayload = {
                    inbox_id: INBOX_ID_TELEGRAM,
                    contact_id: contact_id,
                    message: { content: texto, message_type: "incoming" },
                    status: "open"
                };
                response = await fetch(urlCreateConversation, { method: 'POST', headers, body: JSON.stringify(conversationPayload) });
                data = await response.json();
                console.log(`[CHATWOOT] Conversación nueva creada: ${data.id}`);
            }
        }
    } catch (error) {
        console.error(`[CHATWOOT ERR] Error fatal en la función: ${error.message}`);
    }
}

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
    
    if (error) {
      console.error("Error en /verificar-dispositivo:", error.message);
      return res.status(404).json({ error: 'Dispositivo no encontrado o código QR inválido.' });
    }
    
    if (!data || !data.planes_lete) {
      console.error(`❌ El dispositivo ${device_id} no tiene plan asociado`);
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
    if (lectura_medidor_inicial === null || lectura_medidor_inicial === undefined || lectura_medidor_inicial === '' ||
        consumo_recibo_anterior === null || consumo_recibo_anterior === undefined || consumo_recibo_anterior === '' ||
        lectura_cierre_periodo_anterior === null || lectura_cierre_periodo_anterior === undefined || lectura_cierre_periodo_anterior === '') {
       return res.status(400).json({ error: 'La lectura inicial, el consumo anterior y la lectura de cierre son obligatorios.' });
    }


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

    // Paso 2: Crear usuario en Supabase Auth
    const { data: authData, error: authError } = await supabase.auth.signUp({
      email: email,
      password: crypto.randomBytes(16).toString('hex')
    });
    if (authError) throw authError;

    // Paso 3: Crear cliente en nuestra tabla 'clientes'
    const telefonoNormalizado = telefono ? `+521${telefono.replace(/\D/g, '').slice(-10)}` : null; // Limpia y normaliza
    
    const lecturaInicialValida = parseFloat(lectura_medidor_inicial);
    const consumoAnteriorValido = parseFloat(consumo_recibo_anterior);
    const lecturaCierreValida = parseFloat(lectura_cierre_periodo_anterior);

    if (isNaN(lecturaInicialValida) || isNaN(consumoAnteriorValido) || isNaN(lecturaCierreValida)) {
        return res.status(400).json({ error: 'Los valores de lectura y consumo deben ser números válidos.' });
    }

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
      name: nombre,
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
      success_url: `https://www.tesivil.com/bienvenido.html?email=${encodeURIComponent(email)}`,
      cancel_url: `https://www.tesivil.com/registro.html?dispositivo=${device_id}&error=cancelado`,
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

// RUTA 4: LOGIN CON MAGIC LINK (CORREGIDA Y SEGURA)
app.post('/api/login', async (req, res) => {
    const { email } = req.body;
    const miPropiaUrlBase = 'https://www.tesivil.com'; // La URL base de tu API
    const supabaseUrlBase = process.env.SUPABASE_URL;

    try {
        console.log(`[LOGIN] Solicitud de magic link para: ${email}`);

        // --- ¡NUEVA VERIFICACIÓN! ---
        // 1. Buscar si el cliente existe en tu tabla 'clientes'
        // Usamos .select('id') porque solo necesitamos saber si existe, es más rápido.
        const { data: cliente, error: clienteError } = await supabase
            .from('clientes')
            .select('id') 
            .eq('email', email)
            .single();

        // 2. Si hay un error o el cliente NO se encuentra
        if (clienteError || !cliente) {
            console.warn(`[LOGIN] Intento de login para email no registrado: ${email}`);
            
            // --- NOTA DE SEGURIDAD IMPORTANTE ---
            // NUNCA le decimos al usuario "El correo no existe".
            // Eso permite a un atacante adivinar qué correos SÍ están registrados.
            // Siempre damos una respuesta genérica, aunque no hagamos nada.
            return res.status(200).json({ message: 'Si tu correo está registrado, recibirás un enlace en breve.' });
        }
        // --- FIN DE LA VERIFICACIÓN ---

        // Si llegamos aquí, el email SÍ existe en nuestra DB.
        console.log(`[LOGIN] Email ${email} verificado (Cliente ID: ${cliente.id}). Generando enlace...`);

        // Paso 1: Pedirle a Supabase (admin) que GENERE el enlace
        const { data, error: linkError } = await supabase.auth.admin.generateLink({
            type: 'magiclink',
            email: email,
            options: {
                redirectTo: 'https://www.tesivil.com/mi-cuenta.html'
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
            from: 'Cuentatrón <bienvenido@tesivil.com>',
            to: [email],
            subject: 'Inicia sesión en Cuentatrón',
            html: `<h1>Hola de nuevo!</h1>
                    <p>Haz clic en el siguiente enlace para iniciar sesión en tu cuenta de Cuentatrón:</p>
                    <a href="${cloakedLink}" style="font-size: 16px; color: white; background-color: #007bff; padding: 10px 20px; text-decoration: none; border-radius: 5px;">
                        Iniciar Sesión
                    </a>
                    <br><br>
                    <p>Este enlace es válido por 5 minutos. Si no solicitaste esto, puedes ignorar este correo.</p>`
        });

        if (resendError) throw resendError;

        // Damos la misma respuesta genérica para que el atacante no sepa si tuvo éxito o no.
        res.status(200).json({ message: 'Si tu correo está registrado, recibirás un enlace en breve.' });

    } catch (err) {
        console.error("Error en /api/login:", err.message);
        // En caso de un error real del servidor, también damos una respuesta genérica
        res.status(200).json({ message: 'Si tu correo está registrado, recibirás un enlace en breve.' });
    }
});

// --- 5. RUTAS SEGURAS (Requieren Login de Usuario) ---
// server.js (línea 1113 aprox)
app.get('/api/mi-cuenta', verificarUsuario, async (req, res) => {
  // --- INICIO DE NUEVO CÓDIGO DE DIAGNÓSTICO ---
  console.log('--- [DIAGNÓSTICO /api/mi-cuenta] ---');
  console.log('1. Objeto req.user del middleware:', JSON.stringify(req.user, null, 2));
  
  const userId = req.user.id;
  console.log('2. userId extraído:', userId);
  // --- FIN DE NUEVO CÓDIGO DE DIAGNÓSTICO ---

  try {
    const { data: cliente, error: clienteError } = await supabase
      .from('clientes')
      .select('*')
      .eq('auth_user_id', userId)
      .single();
    
    // --- MÁS DIAGNÓSTICO ---
    console.log('3. Resultado de la consulta de cliente:', JSON.stringify(cliente, null, 2));
    console.log('4. Error de la consulta de cliente:', clienteError ? clienteError.message : 'No hay error');
    // --- FIN DE DIAGNÓSTICO ---

    if (clienteError) throw clienteError;
    
    // --- ¡NUEVA GUARDIA! ---
    // Si el cliente es nulo, no podemos continuar.
    if (!cliente) {
        console.error('¡ERROR FATAL! No se encontró el cliente en la DB para el auth_user_id:', userId);
        return res.status(404).json({ error: 'No se pudo encontrar el perfil de cliente asociado a esta cuenta.' });
    }
    // --- FIN DE GUARDIA ---

    const { data: dispositivos, error: dispositivosError } = await supabase
      .from('dispositivos_lete')
      .select(`device_id, estado, planes_lete ( nombre_plan, precio )`)
      .eq('cliente_id', cliente.id); // Si llegamos aquí, cliente.id SÍ existe
    
    if (dispositivosError) throw dispositivosError;
    
    console.log('5. ¡Éxito! Enviando datos al frontend.');
    res.status(200).json({ perfil: cliente, dispositivos: dispositivos });
  
  } catch (err) { 
    // --- MEJORA DEL CATCH ---
    console.error('--- [ERROR EN CATCH /api/mi-cuenta] ---');
    console.error('Error completo:', err);
    console.error('Mensaje de error:', err.message);
    // --- FIN DE MEJORA ---
    res.status(500).json({ error: err.message }); 
  }
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
        
        const { data: cliente, error: clienteError } = await supabase
            .from('clientes')
            .select('id, stripe_customer_id')
            .eq('auth_user_id', userId)
            .single();

        if (clienteError) throw new Error(`Cliente no encontrado: ${clienteError.message}`);

        const updatesSupabase = {};
        const updatesStripe = {};
        
        if (nombre) {
            updatesSupabase.nombre = nombre;
            updatesStripe.name = nombre;
        }
        
        if (telefono_whatsapp) {
            const digits = telefono_whatsapp.replace(/\D/g, '');
            if (digits.length === 10) {
                const telefonoNormalizado = `+521${digits}`;
                updatesSupabase.telefono_whatsapp = telefonoNormalizado;
                updatesStripe.phone = telefonoNormalizado;
            } else if (digits.length > 0) {
                return res.status(400).json({ error: 'El número de WhatsApp debe tener 10 dígitos.' });
            }
        }
        
        console.log('[PERFIL] Actualizando Supabase...');
        const { error: updateError } = await supabase
            .from('clientes')
            .update(updatesSupabase)
            .eq('id', cliente.id);

        if (updateError) throw updateError;

        if (Object.keys(updatesStripe).length > 0 && cliente.stripe_customer_id) {
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
      .eq('device_id', device_id); // Asumiendo que device_id se envía en el body

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
    data_server_url: '34.53.115.235', // <-- VALOR FIJO (Asumiendo que esta es tu IP)
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

    const registroUrl = `https://www.tesivil.com/registro.html?dispositivo=${device_id}`;
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
  console.log(`✅ Servidor "TESIVIL" corriendo en el puerto ${port}`);
  if (!process.env.SUPABASE_URL) console.warn("AVISO: SUPABASE_URL no está definida.");
  if (!process.env.SUPABASE_SERVICE_KEY) console.warn("AVISO: SUPABASE_SERVICE_KEY no está definida.");
  if (!process.env.STRIPE_SECRET_KEY) console.warn("AVISO: STRIPE_SECRET_KEY no está definida.");
  if (!process.env.STRIPE_WEBHOOK_SECRET) console.warn("AVISO: STRIPE_WEBHOOK_SECRET no está definida.");
  if (!process.env.TELEGRAM_BOT_TOKEN) console.warn("⚠️  AVISO: TELEGRAM_BOT_TOKEN no está definido en .env");
});