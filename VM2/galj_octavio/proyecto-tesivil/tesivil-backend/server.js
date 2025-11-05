/*
 * SERVIDOR BACKEND TESIVIL (v3 con Resend + Anti-Bot)
 * Recibe datos de contacto y los envía por correo usando Resend.
 * Incluye validación de Cloudflare Turnstile y un Honeypot.
 */

// 1. Importar las dependencias
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Resend } = require('resend');

// 2. Inicializar la aplicación Express y Resend
const app = express();
const PORT = process.env.PORT || 3002;
const resend = new Resend(process.env.RESEND_API_KEY);

// Claves Anti-Bot
const TURNSTILE_SECRET_KEY = process.env.TURNSTILE_SECRET_KEY;
const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

console.log(`Resend inicializado. Enviando correos a: ${process.env.EMAIL_TO}`);
console.log(`Enviando correos desde: ${process.env.EMAIL_FROM}`);
console.log(`Cloudflare Turnstile: ${TURNSTILE_SECRET_KEY ? 'CONFIGURADO' : 'NO CONFIGURADO'}`);


// 3. Configurar Middlewares
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// IMPORTANTE: Si corres esto detrás de Nginx o un balanceador de carga,
// esto es necesario para que req.ip obtenga la IP real del visitante.
app.set('trust proxy', 1);


// 4. Definir el Endpoint (Ruta) para el Formulario
app.post('/api/contacto', async (req, res) => {
    
    console.log('Recibida petición en /api/contacto');
    
    // 5. Extraer y validar datos
    const { 
        nombre, email, telefono, empresa, mensaje, origen, 
        website_url, // <-- Campo Honeypot
        'cf-turnstile-response': turnstileToken // <-- Token de Turnstile
    } = req.body;

    // --- DEFENSA ANTI-BOT 1: HONEYPOT ---
    // Si este campo (que debe estar oculto) tiene algún valor, es un bot.
    if (website_url && website_url !== '') {
        console.log('¡BOT DETECTADO (Honeypot)!');
        // Respondemos con éxito falso para engañar al bot
        return res.status(200).json({ 
            success: true, 
            message: 'Gracias por tu mensaje.' 
        });
    }

    // --- DEFENSA ANTI-BOT 2: CLOUDFLARE TURNSTILE ---
    if (!turnstileToken) {
        console.log('Validación fallida: No hay token de Turnstile.');
        return res.status(400).json({ 
            success: false, 
            message: 'Falló la verificación anti-bot (sin token).' 
        });
    }

    try {
        // Validamos el token con Cloudflare
        const response = await fetch(TURNSTILE_VERIFY_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                secret: TURNSTILE_SECRET_KEY,
                response: turnstileToken,
                remoteip: req.ip, // IP del visitante
            }),
        });

        const validationResult = await response.json();

        if (!validationResult.success) {
            console.log('Validación fallida (Turnstile):', validationResult['error-codes']);
            return res.status(403).json({ 
                success: false, 
                message: 'Falló la verificación anti-bot.' 
            });
        }
        
        console.log('Validación Turnstile exitosa.');

    } catch (turnstileError) {
        console.error('Error al contactar Turnstile:', turnstileError);
        return res.status(500).json({ 
            success: false, 
            message: 'Error en el servicio anti-bot. Intenta más tarde.' 
        });
    }
    // --- FIN DEFENSA ANTI-BOT ---


    // 6. Validar datos de negocio (humanos)
    if (!nombre || !email || !telefono || !mensaje) {
        console.log("Datos incompletos", { nombre, email, telefono, mensaje });
        return res.status(400).json({ 
            success: false, 
            message: 'Faltan campos obligatorios.' 
        });
    }

    console.log("Datos humanos recibidos:", { nombre, email, telefono, origen });

    // 7. Construir el HTML del correo
    const htmlBody = `
        <h1>Nuevo Contacto desde la Web TESIVIL</h1>
        <p><strong>Origen del Lead:</strong> ${origen}</p>
        <hr>
        <h3>Datos del Contacto:</h3>
        <p><strong>Nombre:</strong> ${nombre}</p>
        <p><strong>Email:</strong> ${email}</p>
        <p><strong>Teléfono:</strong> ${telefono}</p>
        <p><strong>Empresa:</strong> ${empresa || 'No especificada'}</p>
        <hr>
        <h3>Mensaje:</h3>
        <p>${mensaje.replace(/\n/g, '<br>')}</p>
    `;

    // 8. Enviar el correo usando Resend
    try {
        console.log("Enviando correo con Resend...");
        
        const { data, error } = await resend.emails.send({
            from: process.env.EMAIL_FROM,
            to: [process.env.EMAIL_TO],
            subject: `Nuevo Lead (TESIVIL) - ${origen}`,
            html: htmlBody,
            reply_to: email
        });

        if (error) {
            console.error('Error al enviar el correo (Resend):', error);
            return res.status(500).json({ 
                success: false, 
                message: 'Error interno del servidor. Intenta más tarde.' 
            });
        }

        console.log("Correo enviado exitosamente. ID:", data.id);
        
        return res.status(200).json({ 
            success: true, 
            message: 'Gracias — te contactamos en menos de 48 horas laborales.' 
        });

    } catch (error) {
        console.error('Error catastrófico (Try/Catch):', error);
        return res.status(500).json({ 
            success: false, 
            message: 'Error en el servidor.' 
        });
    }
});

// 9. Iniciar el servidor
app.listen(PORT, () => {
    console.log(`Servidor de backend TESIVIL corriendo en http://localhost:${PORT}`);
});