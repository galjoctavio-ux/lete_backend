export default function GarantiaPage() {
  return (
    <main className="container mx-auto max-w-3xl py-20 px-4">
      <h1 className="text-3xl font-bold mb-6">Política de Garantía — Dispositivo Cuentatrón</h1>
      
      {/* Usamos 'prose' de Tailwind para formatear automáticamente el texto legal */}
      <div className="prose prose-lg max-w-none">
        <h2 className="text-2xl font-bold mt-8 mb-4">1. Cobertura de la Garantía</h2>
        <p>
          El dispositivo Cuentatrón cuenta con una garantía limitada de 6 meses a partir de la fecha de compra, contra defectos de fabricación o funcionamiento que impidan su uso normal bajo condiciones de instalación y operación adecuadas.
        </p>
        <p>
          Durante este periodo, Ingeniería y Distribución de Aires Acondicionados S.A.S. de C.V. se compromete a reparar o sustituir el producto sin costo alguno para el cliente, siempre que el defecto sea atribuible a materiales o procesos de manufactura.
        </p>

        <h2 className="text-2xl font-bold mt-8 mb-4">2. Condiciones para hacer válida la garantía</h2>
        <p>
          Para solicitar el servicio de garantía, el cliente deberá cumplir con los siguientes requisitos:
        </p>
        <ul className="list-disc list-inside space-y-1 my-2 pl-4">
          <li>Presentar comprobante de compra o factura original.</li>
          <li>Que el producto se encuentre dentro del periodo de garantía.</li>
          <li>Que el dispositivo no haya sido alterado, manipulado o intervenido por personas no autorizadas.</li>
          <li>Que el dispositivo haya sido instalado y utilizado conforme al manual de instalación y las especificaciones eléctricas indicadas.</li>
          <li>Que no existan daños por causas externas, como descargas eléctricas, humedad, líquidos, sobrevoltajes, conexión incorrecta o mal uso.</li>
        </ul>

        <h2 className="text-2xl font-bold mt-8 mb-4">3. Casos en los que la garantía no aplica</h2>
        <p>
          La garantía quedará sin efecto en los siguientes casos:
        </p>
        <ul className="list-disc list-inside space-y-1 my-2 pl-4">
          <li>Si el daño es consecuencia de una instalación inadecuada o fuera de especificaciones eléctricas (por ejemplo, conexión a tensiones diferentes a las indicadas).</li>
          <li>Si presenta signos de manipulación, alteración del firmware o apertura del dispositivo.</li>
          <li>Si ha sufrido golpes, caídas, exposición al agua o agentes corrosivos.</li>
          <li>Si el número de serie ha sido removido, alterado o resulta ilegible.</li>
          <li>Si el mal funcionamiento se debe a errores en la red Wi-Fi o falta de conexión a internet, los cuales no constituyen defecto del producto.</li>
          <li>Si se presenta un uso distinto al indicado en el manual del usuario.</li>
        </ul>

        <h2 className="text-2xl font-bold mt-8 mb-4">4. Procedimiento para solicitar la garantía</h2>
        <p>
          El cliente deberá contactar al área de soporte técnico mediante el correo:
        </p>
        <p>
          📧{' '}
          <a href="mailto:soporte@cuentatron.mx" className="text-azul-confianza hover:underline">
            soporte@cuentatron.mx
          </a>
        </p>
        <p>En el correo deberá incluir:</p>
        <ul className="list-disc list-inside space-y-1 my-2 pl-4">
          <li>Nombre completo y datos de contacto.</li>
          <li>Comprobante de compra.</li>
          <li>Descripción del problema.</li>
          <li>Evidencia fotográfica o en video del defecto, si aplica.</li>
        </ul>
        <p>
          El equipo técnico evaluará el caso y emitirá una respuesta en un plazo máximo de 5 días hábiles.
        </p>
        <p>
          Si el producto requiere revisión física, se indicará la dirección de envío y el cliente deberá cubrir los gastos de envío hacia el centro de servicio.
        </p>
        <p>
          En caso de proceder la garantía, se realizará la reparación o sustitución sin costo y se devolverá el producto al cliente.
        </p>

        <h2 className="text-2xl font-bold mt-8 mb-4">5. Alcance de la reparación o sustitución</h2>
        <p>
          Si el dispositivo puede ser reparado, se realizará la corrección del defecto y pruebas de funcionamiento antes de su devolución.
        </p>
        <p>
          Si no puede repararse, se entregará un producto nuevo o equivalente funcionalmente.
        </p>
        <p>
          En ningún caso la reparación o sustitución extiende el periodo de garantía original.
        </p>
        <p>
          La garantía no cubre pérdidas de información o registros históricos almacenados en la nube o en el dispositivo.
        </p>

        <h2 className="text-2xl font-bold mt-8 mb-4">6. Limitación de responsabilidad</h2>
        <p>
          Ingeniería y Distribución de Aires Acondicionados S.A.S. de C.V. no será responsable por daños indirectos, incidentales o consecuenciales derivados del uso o imposibilidad de uso del dispositivo, incluyendo pérdida de datos, interrupciones del servicio o fallas en la red eléctrica o de internet.
        </p>

        <h2 className="text-2xl font-bold mt-8 mb-4">7. Vigencia y contacto</h2>
        <p>
          Esta política de garantía entra en vigor a partir del 1 de noviembre de 2025 y aplica únicamente para dispositivos Cuentatrón adquiridos en México a través de distribuidores autorizados o directamente en el sitio oficial cuentatron.mx.
        </p>
      </div>
    </main>
  )
}