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
const geminiModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest" });

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
          htmlBody = `<h1>¡Hola y bienvenido a Mr. Frío!</h1><p>Tu suscripción ha sido activada exitosamente.</p><p>Puedes acceder a tu panel de control en https://api.mrfrio.mx/mi-cuenta.html</p>`;
      }

      // Enviar correo de bienvenida
      console.log(`[DEBUG] Enviando correo de bienvenida (plantilla HTML) a ${email}...`);
      await resend.emails.send({
          from: 'Mr. Frío <bienvenido@mrfrio.mx>',
          to: [email],
          subject: '¡Bienvenido a Mr. Frío! Siguientes Pasos 🚀',
          html: htmlBody
      });
      console.log("[DEBUG] ✅ Correo de bienvenida enviado con éxito.");

      // Enviar mensaje de WhatsApp
      if (telefono_whatsapp) {
          console.log(`[DEBUG] Enviando WhatsApp de bienvenida a ${telefono_whatsapp}...`);
          try {
              await twilioClient.messages.create({
                  body: `¡Hola ${nombreCliente}! 👋 Bienvenido a Mr. Frío. Tu suscripción está activa y tu dispositivo está listo para ser instalado. Revisa tu correo (${email}) para ver las instrucciones.`,
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

// --- AHORA SÍ, USAMOS express.json() PARA EL RESTO DE RUTAS ---
app.use(express.json());

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
      // ¡AQUÍ EMPIEZA LA LÓGICA DE COMANDOS!
      // 1. ¿Este chat_id está vinculado a un cliente?
      const { data: cliente, error: clienteError } = await supabase
        .from('clientes')
        .select(`
          id, 
          nombre, 
          en_chat_humano_hasta,
          dia_de_corte,                 
          ciclo_bimestral,              
          fecha_inicio_servicio,        
          lectura_cierre_periodo_anterior, 
          lectura_medidor_inicial,       
          dispositivos_lete ( device_id )
        `)
        .eq('telegram_chat_id', chat_id)
        .single();

      // 1a. Si NO está vinculado, recordarle
      if (clienteError || !cliente) {
        console.log(`[TELEGRAM] Chat ${chat_id} no vinculado envió: ${textoRecibido}`);
        await enviarMensajeTelegram(chat_id, "No entendí ese comando. Si quieres vincular tu cuenta, envía tu correo electrónico.");
        return res.sendStatus(200);
      }
      
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

      // --- PROCESADOR DE COMANDOS ---
      switch (comando) {
        
        case 'voltaje':
          const fluxQuery = `
            from(bucket: "${influxBucket}")
              |> range(start: 0) // Buscamos en todo el historial
              |> filter(fn: (r) => r._measurement == "energia")
              |> filter(fn: (r) => r._field == "vrms")
              |> filter(fn: (r) => r.device_id == "${device_id}")
              |> last()
          `;
          
          let voltaje = null;
          let timestamp = null; // <-- Variable para guardar la fecha
          console.log(`[INFLUX] Ejecutando query para ${device_id}: ${fluxQuery.replace(/\s+/g, ' ')}`);

          try {
            // Usamos 'for await...of' para consumir el stream de Influx
            for await (const { values, tableMeta } of queryApi.iterateRows(fluxQuery)) {
              const o = tableMeta.toObject(values);
              voltaje = o._value;
              timestamp = o._time; // <-- Capturamos la fecha del registro
            }

            if (voltaje !== null) {
              // Formateamos la fecha a la zona horaria local
              const fechaReporte = new Date(timestamp).toLocaleString('es-MX', { timeZone: 'America/Mexico_City' });
              await enviarMensajeTelegram(chat_id, `⚡ El último voltaje reportado fue: *${voltaje.toFixed(2)} V* (registrado el ${fechaReporte})`);
            } else {
              // Mensaje de error actualizado (ya no menciona 15 min)
              await enviarMensajeTelegram(chat_id, "No pude encontrar ningún dato de voltaje para tu dispositivo. ¿Está tu dispositivo conectado y enviando datos?");
            }

          } catch (err) {
            console.error(`[INFLUX ERR] Error consultando voltaje: ${err.message}`);
            await enviarMensajeTelegram(chat_id, "Hubo un error al consultar la base de datos de mediciones.");
          }
          break;

        // ... (código del case 'voltaje' que termina en 'break;')

        case 'watts':
        case 'potencia': // Alias
          const fluxQueryWatts = `
            from(bucket: "${influxBucket}")
              |> range(start: 0) // Buscamos en todo el historial
              |> filter(fn: (r) => r._measurement == "energia")
              |> filter(fn: (r) => r._field == "power") // <-- CAMBIO A "power"
              |> filter(fn: (r) => r.device_id == "${device_id}")
              |> last()
          `;
          
          let watts = null;
          let timestampWatts = null;
          console.log(`[INFLUX] Ejecutando query para ${device_id}: ${fluxQueryWatts.replace(/\s+/g, ' ')}`);

          try {
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
          break;

        case 'consumo_hoy':
        case 'consumo_de_hoy':
        case 'hoy': { // <-- LLAVE DE APERTURA
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
          
          let consumoHoy = null; // Esta variable ahora vive SÓLO aquí
          console.log(`[INFLUX] Ejecutando query para ${device_id}: ${fluxQueryHoy.replace(/\s+/g, ' ')}`);

          try {
            for await (const { values, tableMeta } of queryApi.iterateRows(fluxQueryHoy)) {
              const o = tableMeta.toObject(values);
              consumoHoy = o._value;
            }

            // --- ¡NUEVA LÓGICA! ---
            // 1. Preparamos el mensaje principal
            let mensaje = "Aún no se registran datos de consumo para el día de hoy.";
            if (consumoHoy !== null) {
              mensaje = `📊 Tu consumo acumulado de *hoy* es: *${consumoHoy.toFixed(3)} kWh*`;
            }
            
            // 2. Obtenemos el acumulado del periodo
            const { kwh_periodo_actual, error_periodo } = await getConsumoAcumuladoPeriodo(cliente, device_id);

            // 3. Añadimos la línea extra si no hubo error
            if (!error_periodo) {
                mensaje += `\n\nLlevas un total de *${kwh_periodo_actual.toFixed(3)} kWh* acumulados en tu periodo actual.`;
            }
            
            // 4. Enviamos el mensaje combinado
            await enviarMensajeTelegram(chat_id, mensaje);
            // --- FIN DE LÓGICA NUEVA ---

          } catch (err) {
            console.error(`[INFLUX ERR] Error consultando consumo_hoy: ${err.message}`);
            await enviarMensajeTelegram(chat_id, "Hubo un error al calcular tu consumo de hoy.");
          }
          break;
        } // <-- LLAVE DE CIERRE

        case 'consumo_ayer':
        case 'consumo_de_ayer':
        case 'ayer': { // <-- LLAVE DE APERTURA
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
          
          // --- ¡ESTA ES LA CORRECCIÓN CLAVE! ---
          let consumoAyer = null; // Se llama 'consumoAyer', no 'consumoHoy'
          
          console.log(`[INFLUX] Ejecutando query para ${device_id}: ${fluxQueryAyer.replace(/\s+/g, ' ')}`);

          try {
            for await (const { values, tableMeta } of queryApi.iterateRows(fluxQueryAyer)) {
              const o = tableMeta.toObject(values);
              consumoAyer = o._value; // Asignar a 'consumoAyer'
            }

            // --- ¡NUEVA LÓGICA! ---
            // 1. Preparamos el mensaje principal
            let mensaje = "No se encontraron datos de consumo para el día de ayer.";
            if (consumoAyer !== null) { // Usar 'consumoAyer'
              mensaje = `🗓️ Tu consumo total de *ayer* fue: *${consumoAyer.toFixed(3)} kWh*`; // Usar 'consumoAyer'
            }
            
            // 2. Obtenemos el acumulado del periodo
            const { kwh_periodo_actual, error_periodo } = await getConsumoAcumuladoPeriodo(cliente, device_id);

            // 3. Añadimos la línea extra si no hubo error
            if (!error_periodo) {
                mensaje += `\n\nLlevas un total de *${kwh_periodo_actual.toFixed(3)} kWh* acumulados en tu periodo actual.`;
            }
            
            // 4. Enviamos el mensaje combinado
            await enviarMensajeTelegram(chat_id, mensaje);
            // --- FIN DE LÓGICA NUEVA ---

          } catch (err) {
            console.error(`[INFLUX ERR] Error consultando consumo_ayer: ${err.message}`);
            await enviarMensajeTelegram(chat_id, "Hubo un error al calcular tu consumo de ayer.");
          }
          break;
        } // <-- LLAVE DE CIERRE

        // ... (aquí va el 'default:')  

        // ... aquí irán /consumo_hoy, /watts, etc. ...

        default: { // <-- Encerramos en llaves para crear un ámbito seguro
          console.log(`[POLICIA] Mensaje no reconocido de ${cliente.nombre}. Iniciando lógica de desvío.`);
          
          // 1. Revisar la DB. ¿Está en un chat humano?
          const ahora = new Date();
          const fechaLimiteHumano = cliente.en_chat_humano_hasta ? new Date(cliente.en_chat_humano_hasta) : null;

          // --- Escenario 1: Chat Humano ACTIVO ---
          // (El temporizador 'en_chat_humano_hasta' está en el futuro)
          if (fechaLimiteHumano && fechaLimiteHumano > ahora) {
            console.log(`[POLICIA] Chat humano activo. Reenviando a Chatwoot y reiniciando timer.`);
            
            // Paso A: Reenviar mensaje al CRM
            // (La variable 'cliente' y 'textoRecibido' están disponibles desde el inicio del 'Caso 4')
            await reenviarAChatwoot(cliente, textoRecibido); 
            
            // Paso B: Reiniciar el temporizador (ej. 1 hora más desde ahora)
            const nuevaHoraLimite = new Date(Date.now() + 60 * 60 * 1000).toISOString();
            await supabase
                .from('clientes')
                .update({ en_chat_humano_hasta: nuevaHoraLimite })
                .eq('id', cliente.id);
            
            // NO respondemos nada. El agente humano en Chatwoot lo hará.
          
          // --- Escenario 2: Chat Humano INACTIVO (Llamar al Detective Gemini) ---
          } else {
            console.log(`[POLICIA] Chat humano inactivo. Llamando a Gemini...`);
            
            // Paso A: Enviar mensaje a Gemini para clasificar la intención
            const respuestaGemini = await llamarAGemini(textoRecibido);
            
            // --- Sub-escenario 2a: ¡Necesita soporte humano! ---
            if (respuestaGemini.intencion === 'soporte_humano') {
              console.log(`[POLICIA] Gemini detectó 'soporte_humano'. Transfiriendo a Chatwoot.`);
              
              // Paso A: Reenviar al CRM
              await reenviarAChatwoot(cliente, textoRecibido);
              
              // Paso B: Actualizar la DB para INICIAR el chat humano (1 hora)
              const horaLimite = new Date(Date.now() + 60 * 60 * 1000).toISOString();
              await supabase
                  .from('clientes')
                  .update({ en_chat_humano_hasta: horaLimite })
                  .eq('id', cliente.id);
                  
              // Paso C: Responder al cliente en Telegram
              await enviarMensajeTelegram(chat_id, "Entendido, tu mensaje requiere atención especial. Estoy transfiriendo tu chat a un agente humano, un momento por favor... 🧑‍💻");
            
            // --- Sub-escenario 2b: No es soporte (intención desconocida) ---
            } else {
              console.log(`[POLICIA] Gemini detectó 'desconocido'. Respondiendo con menú.`);
              
              // Respondemos con el menú de ayuda estándar
              await enviarMensajeTelegram(chat_id, 
                "No reconocí ese comando. Prueba con alguna de estas opciones:\n\n" +
                "*/hoy* - _Consumo acumulado del día_\n" +
                "*/ayer* - _Consumo total de ayer_\n" +
                "*/voltaje* - _Último voltaje registrado_\n" +
                "*/watts* - _Consumo instantáneo (potencia)_" +
                "\n\n_Si tienes un problema o quieres cancelar, solo escríbelo y te transferiré con un humano._"
              );
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


// --- FUNCIÓN DE AYUDA: LLAMAR A GEMINI (El "Detective") ---
async function llamarAGemini(textoUsuario) {
    if (!geminiApiKey) return { intencion: 'desconocido' }; // Guardián

    try {
        const prompt = `
          Eres un clasificador de intenciones para un bot de monitoreo de energía llamado "Cuentatrón".
          Analiza el siguiente mensaje del usuario y clasifícalo en una de estas dos intenciones:
          1. "soporte_humano": Si el usuario expresa frustración, enojo, confusión, quiere cancelar, reporta un error grave, o pide explícitamente hablar con una persona.
          2. "desconocido": Si es un saludo, una pregunta general, o cualquier otra cosa que no sea una solicitud de soporte urgente.
          
          Responde SOLAMENTE con un objeto JSON válido, nada más.
          
          Ejemplos:
          - Usuario: "Esto no sirve, quiero cancelar mi suscripción ya" -> {"intencion": "soporte_humano"}
          - Usuario: "Hola buenos días" -> {"intencion": "desconocido"}
          - Usuario: "mi dispositivo no reporta desde ayer" -> {"intencion": "soporte_humano"}
          - Usuario: "cuanto cuesta el kwh" -> {"intencion": "desconocido"}
          - Usuario: "ayuda por favor" -> {"intencion": "soporte_humano"}
          - Usuario: "gracias" -> {"intencion": "desconocido"}
          
          Mensaje del usuario a clasificar:
          "${textoUsuario}"
        `;
        
        const result = await geminiModel.generateContent(prompt);
        const response = await result.response;
        const text = response.text();
        
        // Limpiar la respuesta de Gemini (a veces añade ```json ... ```)
        const jsonText = text.replace(/```json/g, '').replace(/```/g, '').trim();
        console.log(`[GEMINI] Respuesta cruda: ${text}. JSON Limpio: ${jsonText}`);
        
        return JSON.parse(jsonText); // Debería ser { intencion: "..." }

    } catch (error) {
        console.error(`[GEMINI ERR] Error al llamar a la API: ${error.message}`);
        return { intencion: 'desconocido' }; // Fallback
    }
}

// --- FUNCIÓN DE AYUDA: REENVIAR A CHATWOOT (El "Oficial") ---
// (Esta función es compleja, maneja la API de Chatwoot)
async function reenviarAChatwoot(cliente, texto) {
    if (!chatwootUrl || !chatwootAccountId || !chatwootToken) return; // Guardián

    const headers = {
        'Content-Type': 'application/json; charset=utf-8',
        'api_access_token': chatwootToken
    };

    try {
        // --- Paso 1: Buscar o Crear Contacto en Chatwoot ---
        // Usamos el 'telegram_chat_id' como identificador único
        const urlSearch = `${chatwootUrl}/api/v1/accounts/${chatwootAccountId}/contacts/search?q=${cliente.telegram_chat_id}`;
        let response = await fetch(urlSearch, { method: 'GET', headers });
        let data = await response.json();
        
        let contact_id;
        if (data.payload.length > 0) {
            contact_id = data.payload[0].id;
            console.log(`[CHATWOOT] Contacto encontrado: ${contact_id}`);
        } else {
            console.log(`[CHATWOOT] Contacto no encontrado, creando uno nuevo...`);
            const urlCreateContact = `${chatwootUrl}/api/v1/accounts/${chatwootAccountId}/contacts`;
            const contactPayload = {
                name: cliente.nombre,
                email: cliente.email || undefined,
                phone_number: cliente.telefono_whatsapp || undefined,
                identifier: cliente.telegram_chat_id // Identificador único
            };
            response = await fetch(urlCreateContact, { method: 'POST', headers, body: JSON.stringify(contactPayload) });
            data = await response.json();
            contact_id = data.payload.contact.id;
            console.log(`[CHATWOOT] Contacto creado: ${contact_id}`);
        }

        // --- Paso 2: Buscar Conversación Activa ---
        // (Chatwoot no tiene un "find or create" fácil para conversaciones de Telegram)
        // Por simplicidad, crearemos una nueva conversación si no encontramos una.
        // (En una v2, buscaríamos conversaciones existentes para este contact_id)
        
        // --- Paso 3: Crear Conversación (o mensaje) ---
        // (Este es el "Inbox" que creaste en Chatwoot para tu bot de Telegram)
        // ¡¡IMPORTANTE!! Debes crear un "Canal" de tipo "API" en Chatwoot
        // y obtener el ID de ese Inbox.
        const INBOX_ID_TELEGRAM = '83046'; // <-- ¡¡REEMPLAZA ESTO!!

        const urlCreateMessage = `${chatwootUrl}/api/v1/accounts/${chatwootAccountId}/conversations`;
        const messagePayload = {
            inbox_id: INBOX_ID_TELEGRAM,
            contact_id: contact_id,
            message: {
                content: texto,
                message_type: "incoming" // Lo registramos como "entrante"
            },
            status: "open" // Abrir el ticket
        };

        response = await fetch(urlCreateMessage, { method: 'POST', headers, body: JSON.stringify(messagePayload) });
        data = await response.json();

        if (response.ok) {
            console.log(`[CHATWOOT] Mensaje reenviado y conversación creada/actualizada: ${data.id}`);
        } else {
            console.error(`[CHATWOOT ERR] Error al crear mensaje: ${data.message}`);
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
    const supabaseUrlBase = process.env.SUPABASE_URL;

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
  if (!process.env.TELEGRAM_BOT_TOKEN) console.warn("⚠️  AVISO: TELEGRAM_BOT_TOKEN no está definido en .env");
});
