export default function PrivacidadPage() {
  return (
    <main className="container mx-auto max-w-3xl py-20 px-4">
      <h1 className="text-3xl font-bold mb-6">Aviso de Privacidad — Versión E-Commerce</h1>
      
      {/* La clase "prose" ahora funcionará gracias al plugin */}
      <div className="prose prose-lg max-w-none">
        <p>
          Tecnología y Software en la Ingeniería Civil S.A. de C.V., con domicilio en Zapopan, Jalisco, México, y responsable de la marca comercial Cuentatrón, es el responsable del tratamiento de los datos personales que usted nos proporciona a través de nuestro sitio web www.tesivil.com/cuentatron y de otros medios electrónicos relacionados con la compra, activación o uso del dispositivo.
        </p>
        <p>
          El presente Aviso de Privacidad se emite en cumplimiento de la Ley Federal de Protección de Datos Personales en Posesión de los Particulares (LFPDPPP) y tiene como objetivo informarle sobre el uso, protección y tratamiento de sus datos personales.
        </p>

        <h2 className="text-2xl font-bold mt-8 mb-4">1. Datos personales que recabamos</h2>
        <p>
          Los datos que podemos solicitarle incluyen, de manera enunciativa mas no limitativa:
        </p>
        <ul className="list-disc list-inside space-y-1 my-2 pl-4">
          <li>Nombre completo.</li>
          <li>Correo electrónico.</li>
          <li>Número telefónico.</li>
          <li>Domicilio para envío o facturación.</li>
          <li>Datos fiscales (RFC, razón social, uso de CFDI).</li>
          <li>Datos de pago (parciales o encriptados, a través de plataformas seguras).</li>
          <li>Información técnica del dispositivo Cuentatrón (número de serie, versión de firmware, hora de activación, dirección IP).</li>
        </ul>
        <p>
          En caso de que el usuario lo autorice, el dispositivo podrá enviar mediciones y datos eléctricos en tiempo real a nuestros servidores para mejorar la experiencia de uso.
        </p>

        <h2 className="text-2xl font-bold mt-8 mb-4">2. Finalidades del tratamiento de datos</h2>
        <p>
          Los datos personales recabados serán utilizados para las siguientes finalidades:
        </p>
        <h3 className="text-xl font-bold mt-6 mb-2">Finalidades primarias (necesarias):</h3>
        <ul className="list-disc list-inside space-y-1 my-2 pl-4">
          <li>Procesar compras y emitir facturas.</li>
          <li>Gestionar envíos, entregas e instalación de equipos.</li>
          <li>Proporcionar soporte técnico y asistencia postventa.</li>
          <li>Activar el servicio digital asociado al dispositivo.</li>
          <li>Gestionar garantías, devoluciones o reclamaciones.</li>
          <li>Cumplir con obligaciones legales y fiscales.</li>
        </ul>
        <h3 className="text-xl font-bold mt-6 mb-2">Finalidades secundarias (opcionales):</h3>
        <ul className="list-disc list-inside space-y-1 my-2 pl-4">
          <li>Enviar actualizaciones del producto, promociones o avisos informativos.</li>
          <li>Evaluar la calidad del servicio.</li>
          <li>Realizar encuestas o análisis estadísticos sobre el uso del dispositivo.</li>
        </ul>
        <p>
          En caso de no desear que sus datos se utilicen para finalidades secundarias, puede enviar un correo a{' '}
          <a href="mailto:privacidad-cuentatron@tesivil.com" className="text-azul-confianza hover:underline">
            privacidad-cuentatron@tesivil.com
          </a>
          {' '}indicando en el asunto “No deseo uso secundario de datos”.
        </p>

        <h2 className="text-2xl font-bold mt-8 mb-4">3. Transferencia de datos personales</h2>
        <p>
          Sus datos personales no serán compartidos con terceros sin su consentimiento expreso, salvo en los siguientes casos:
        </p>
        <ul className="list-disc list-inside space-y-1 my-2 pl-4">
          <li>Autoridades competentes que lo requieran conforme a la ley.</li>
          <li>Proveedores de servicios logísticos, de facturación o de procesamiento de pagos (como PayPal, Stripe o Mercado Pago).</li>
          <li>Servicios en la nube o alojamiento web con los que mantenemos contratos con cláusulas de confidencialidad y protección de datos.</li>
        </ul>

        <h2 className="text-2xl font-bold mt-8 mb-4">4. Derechos ARCO (Acceso, Rectificación, Cancelación y Oposición)</h2>
        <p>Usted tiene derecho a:</p>
        <ul className="list-disc list-inside space-y-1 my-2 pl-4">
          <li>Acceder a sus datos personales.</li>
          <li>Rectificarlos si son inexactos o incompletos.</li>
          <li>Cancelarlos cuando considere que no son necesarios para las finalidades señaladas.</li>
          <li>Oponerse a su tratamiento para fines específicos.</li>
        </ul>
        <p>
          Para ejercer cualquiera de estos derechos, deberá enviar una solicitud al correo electrónico{' '}
          <a href="mailto:privacidad-cuentatron@tesivil.com" className="text-azul-confianza hover:underline">
            privacidad-cuentatron@tesivil.com
          </a>
          {' '}con el asunto “Solicitud ARCO”, indicando su nombre completo, medio de contacto y una descripción del derecho que desea ejercer.
        </p>
        <p>
          Su solicitud será atendida en un plazo máximo de 20 días hábiles.
        </p>

        <h2 className="text-2xl font-bold mt-8 mb-4">5. Medidas de seguridad</h2>
        <p>
          Cuentatrón implementa medidas de seguridad administrativas, técnicas y físicas para proteger sus datos personales contra pérdida, uso indebido, acceso no autorizado, alteración o destrucción.
        </p>
        <p>
          El sitio web utiliza certificados SSL y métodos de cifrado de datos en sus transacciones.
        </p>

        <h2 className="text-2xl font-bold mt-8 mb-4">6. Uso de cookies y tecnologías similares</h2>
        <p>
          Nuestro sitio web utiliza cookies y tecnologías de seguimiento para mejorar la experiencia del usuario.
        </p>
        <p>
          Usted puede deshabilitar el uso de cookies desde la configuración de su navegador; sin embargo, esto podría limitar algunas funciones del sitio.
        </p>

        <h2 className="text-2xl font-bold mt-8 mb-4">7. Conservación de la información</h2>
        <p>
          Los datos personales se conservarán únicamente por el tiempo necesario para cumplir las finalidades del tratamiento y las obligaciones legales aplicables.
        </p>

        <h2 className="text-2xl font-bold mt-8 mb-4">8. Cambios al aviso de privacidad</h2>
        <p>
          Nos reservamos el derecho de modificar o actualizar este Aviso de Privacidad en cualquier momento.
        </p>
        <p>
          Las modificaciones serán publicadas en https://www.tesivil.com/cuentatron/privacidad-ecommerce/ y entrarán en vigor automáticamente a partir de su publicación.
        </p>

        <h2 className="text-2xl font-bold mt-8 mb-4">9. Contacto</h2>
        <p>
          Para cualquier duda, queja o aclaración relacionada con la protección de sus datos personales, puede contactarnos en:
        </p>
        <p>
          📧{' '}
          <a href="mailto:privacidad-cuentatron@tesivil.com" className="text-azul-confianza hover:underline">
            privacidad-cuentatron@tesivil.com
          </a>
        </p>
        <p>
          📍 Tecnología y Software en la Ingeniería Civil S.A. de C.V.
          <br />
          Zapopan, Jalisco, México.
        </p>
        <p className="mt-4">
          <em>Última actualización: 1 de noviembre de 2025.</em>
        </p>
      </div>
    </main>
  )
}