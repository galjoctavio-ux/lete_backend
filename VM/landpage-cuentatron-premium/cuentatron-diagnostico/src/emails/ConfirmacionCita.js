// src/emails/ConfirmacionCita.js
// Usaremos los componentes de react-email/components si los instalamos,
// pero por ahora, esto es JSX simple que Resend entiende.

import * as React from 'react';

// Estos datos (nombre, dia, hora) los pasaremos como props
export const ConfirmacionCitaEmail = ({
  nombreCliente = 'Cliente',
  diaCita = 'Martes, 12 de Noviembre',
  horaCita = '11:00 AM',
}) => (
  <div>
    <h1>¡Hola, {nombreCliente}!</h1>
    <p>Felicidades. Tu pago ha sido recibido y tu cita está confirmada.</p>
    <p>Has dado el primer paso para tomar el control de tu consumo energético.</p>

    <hr />

    <h2>Datos de tu Cita:</h2>
    <ul>
      <li><strong>Servicio:</strong> Monitoreo Especial Cuentatrón (7 Días)</li>
      <li><strong>Día:</strong> {diaCita}</li>
      <li><strong>Hora:</strong> {horaCita}</li>
    </ul>

    <hr />

    <h3>Instrucción Clave (Por favor confirma de enterado):</h3>
    <p>
      Para asegurar la precisión del diagnóstico, es vital que durante los 7 días de monitoreo
      no conectes aparatos de alto consumo que no uses habitualmente (soldadoras, maquinaria pesada, etc.).
    </p>
    <p>
      Un Ingeniero de Cuentatrón te visitará puntualmente. Si necesitas reagendar, por favor
      usa el enlace en tu invitación de calendario o contáctanos por WhatsApp.
    </p>

    <hr />
    <p>
      Atentamente,<br />
      El equipo de Cuentatrón / TESIVIL
    </p>
  </div>
);

export default ConfirmacionCitaEmail;