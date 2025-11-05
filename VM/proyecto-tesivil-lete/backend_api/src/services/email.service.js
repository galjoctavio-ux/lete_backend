import { Resend } from 'resend';
import dotenv from 'dotenv';

dotenv.config();

const resend = new Resend(process.env.RESEND_API_KEY);

// Asumimos que tu dominio verificado en Resend es tesivil.com
const fromEmail = 'reportes@tesivil.com'; 

/**
 * Envía el email con el reporte al cliente
 * @param {string} clienteEmail - El email del cliente
 * @param {string} clienteNombre - El nombre del cliente
 * @param {string} pdfUrl - La URL pública del PDF
 */
export const enviarReportePorEmail = async (clienteEmail, clienteNombre, pdfUrl) => {
  if (!process.env.RESEND_API_KEY) {
    console.warn('RESEND_API_KEY no está configurada. Saltando envío de email.');
    return;
  }

  if (!pdfUrl) {
     console.warn('No hay pdfUrl. Saltando envío de email.');
     return;
  }

  console.log(`Enviando reporte a ${clienteEmail}...`);

  try {
    const { data, error } = await resend.emails.send({
      from: `Reportes Tesivil <${fromEmail}>`,
      to: [clienteEmail],
      subject: 'Tu Reporte de Diagnóstico Eléctrico está listo',
      html: `
        Hola ${clienteNombre},<br><br>
        Gracias por utilizar nuestros servicios de "Luz en tu Espacio".<br>
        Adjuntamos tu reporte de diagnóstico detallado.<br><br>
        Puedes verlo o descargarlo aquí: <a href="${pdfUrl}">Ver Reporte PDF</a><br><br>
        Atentamente,<br>
        El equipo de Tesivil
      `,
      // Nota: Resend no adjunta la URL directamente,
      // la ponemos como un enlace en el HTML.
    });

    if (error) {
      throw new Error(error.message);
    }

    console.log('Email enviado exitosamente. ID:', data.id);
    return data.id;

  } catch (error) {
    console.error('Error al enviar email con Resend:', error.message);
    // No relanzamos el error para no fallar toda la revisión
  }
};
