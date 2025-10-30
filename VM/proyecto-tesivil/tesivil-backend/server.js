/*
 * SERVIDOR BACKEND TESIVIL (v2 con Resend)
 * Recibe datos de contacto y los envía por correo usando Resend.
 */

// 1. Importar las dependencias
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Resend } = require('resend'); // Importamos Resend

// 2. Inicializar la aplicación Express y Resend
const app = express();
const PORT = process.env.PORT || 3002; // <-- Puerto 3002
const resend = new Resend(process.env.RESEND_API_KEY);

console.log(`Resend inicializado. Enviando correos a: ${process.env.EMAIL_TO}`);
console.log(`Enviando correos desde: ${process.env.EMAIL_FROM}`);

// 3. Configurar Middlewares
app.use(cors()); // Permitir peticiones (lo ajustaremos en Nginx)
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 4. Definir el Endpoint (Ruta) para el Formulario
app.post('/api/contacto', async (req, res) => {
    
    console.log('Recibida petición en /api/contacto');
    
    // 5. Extraer y validar datos (¡ahora incluye email!)
    const { nombre, email, telefono, empresa, mensaje, origen } = req.body;

    if (!nombre || !email || !telefono || !mensaje) {
        console.log("Datos incompletos", { nombre, email, telefono, mensaje });
        return res.status(400).json({ 
            success: false, 
            message: 'Faltan campos obligatorios.' 
        });
    }

    console.log("Datos recibidos:", { nombre, email, telefono, origen });

    // 6. Construir el HTML del correo
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

    // 7. Enviar el correo usando Resend
    try {
        console.log("Enviando correo con Resend...");
        
        const { data, error } = await resend.emails.send({
            from: process.env.EMAIL_FROM,
            to: [process.env.EMAIL_TO],
            subject: `Nuevo Lead (TESIVIL) - ${origen}`,
            html: htmlBody,
            reply_to: email // ¡Aquí usamos el email del cliente!
        });

        // Manejo de error de Resend
        if (error) {
            console.error('Error al enviar el correo (Resend):', error);
            return res.status(500).json({ 
                success: false, 
                message: 'Error interno del servidor. Intenta más tarde.' 
            });
        }

        console.log("Correo enviado exitosamente. ID:", data.id);
        
        // Respondemos al frontend con éxito
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

// 8. Iniciar el servidor
app.listen(PORT, () => {
    console.log(`Servidor de backend TESIVIL corriendo en http://localhost:${PORT}`);
});