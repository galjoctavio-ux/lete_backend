// src/app/api/enviar-confirmacion/route.js

import { Resend } from 'resend';
import { NextResponse } from 'next/server';
// Importamos nuestra plantilla de correo React (que ya creamos)
import { ConfirmacionCitaEmail } from '@/emails/ConfirmacionCita';

// Inicializamos Resend con la clave de API
const resend = new Resend(process.env.RESEND_API_KEY);

// El correo "from" DEBE ser de un dominio que hayas verificado en Resend
const fromEmail = 'diagnosticos@tesivil.com'; // <-- CAMBIA ESTO por tu email verificado

export async function POST(request) {
  try {
    // 1. Obtenemos los datos que nos envía el frontend
    // (ya no es un payload de Calendly, es un JSON limpio)
    const { emailCliente, nombreCliente, fechaHoraISO } = await request.json();

    // 2. Validamos que tengamos los datos
    if (!emailCliente || !nombreCliente || !fechaHoraISO) {
      return NextResponse.json({ error: 'Faltan datos (email, nombre o fecha).' }, { status: 400 });
    }

    // 3. Formateamos la fecha/hora de la cita
    const fechaHoraCita = new Date(fechaHoraISO);

    const opcionesFecha = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/Mexico_City' };
    const opcionesHora = { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/Mexico_City' };

    const diaCita = fechaHoraCita.toLocaleDateString('es-MX', opcionesFecha);
    const horaCita = fechaHoraCita.toLocaleTimeString('es-MX', opcionesHora);

    // 4. Enviamos el correo usando Resend y nuestra plantilla React
    const { data, error } = await resend.emails.send({
      from: `Cuentatrón <${fromEmail}>`, // Ej: "Cuentatrón <diagnosticos@tesivil.com>"
      to: [emailCliente], // El correo del cliente
      subject: `Cita Confirmada: Tu Monitoreo Cuentatrón (Día: ${diaCita})`,
      react: ConfirmacionCitaEmail({
        nombreCliente: nombreCliente,
        diaCita: diaCita,
        horaCita: horaCita,
      }),
    });

    if (error) {
      console.error('Error de Resend:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    console.log('Correo de confirmación (vía Opción D) enviado a:', emailCliente);
    return NextResponse.json({ success: true, data }, { status: 200 });

  } catch (err) {
    console.error('Error en la API de enviar-confirmacion:', err.message);
    return NextResponse.json({ error: 'Error interno del servidor.' }, { status: 500 });
  }
}