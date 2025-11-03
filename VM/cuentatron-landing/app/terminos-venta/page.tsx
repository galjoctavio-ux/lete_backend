export default function TerminosPage() {
  return (
    <main className="container mx-auto max-w-3xl py-20 px-4">
      <h1 className="text-3xl font-bold mb-6">Términos y Condiciones de Venta</h1>
      
      {/* Usamos 'prose' de Tailwind para formatear automáticamente el texto legal */}
      <div className="prose prose-lg max-w-none">
        <p>
          <strong>Última actualización: 26 de octubre de 2025</strong>
        </p>
        <p>
          <strong>Razón social:</strong> Tecnología y Software en la Ingeniería Civil S.A. de C.V. - TESIVIL
        </p>
        <p>
          <strong>Correo de contacto:</strong>{' '}
          <a href="mailto:contacto-cuentatron@tesivil.com" className="text-azul-confianza hover:underline">
            contacto-cuentatron@tesivil.com
          </a>
        </p>
        <p>
          <strong>Domicilio fiscal:</strong> Av. Sebastián Bach 4978, Prados Guadalupe, Zapopan, Jalisco, México.
        </p>

        <h2 className="text-2xl font-bold mt-8 mb-4">1. Objeto</h2>
        <p>
          El presente documento establece los términos que regulan la compra y uso inicial del dispositivo Cuentatrón (en adelante, el “Dispositivo”) adquirido por el cliente (en adelante, el “Usuario”) a través del sitio web www.tesivil.com/cuentatron o de canales oficiales autorizados.
        </p>

        <h2 className="text-2xl font-bold mt-8 mb-4">2. Naturaleza del producto</h2>
        <p>
          Cuentatrón es un dispositivo electrónico de medición y monitoreo de parámetros eléctricos (voltaje, corriente, potencia y frecuencia) diseñado para uso doméstico y comercial ligero.
        </p>
        <p>
          No es un instrumento de precisión metrológica ni cuenta con certificaciones para fines fiscales, periciales o industriales.
        </p>
        <p>
          Las lecturas son estimadas y sirven únicamente como referencia orientativa.
        </p>

        <h2 className="text-2xl font-bold mt-8 mb-4">3. Alcance de la venta</h2>
        <p>
          La compra incluye exclusivamente el Dispositivo y su empaque original, así como su manual de instalación impreso y en formato digital (PDF).
        </p>
        <p>
          El precio de venta no incluye instalación, configuración ni servicios de suscripción remota, salvo que se especifique lo contrario en la oferta.
        </p>

        <h2 className="text-2xl font-bold mt-8 mb-4">4. Propiedad del Dispositivo</h2>
        <p>
          La propiedad del Dispositivo se transfiere al Usuario una vez que el pago haya sido recibido y confirmado por el sistema de cobro.
        </p>
        <p>
          Hasta ese momento, el Dispositivo seguirá siendo propiedad de la empresa.
        </p>

        <h2 className="text-2xl font-bold mt-8 mb-4">5. Funcionalidad al recibir el Dispositivo</h2>
        <p>
          Al recibirlo, el Usuario podrá visualizar las mediciones eléctricas en la pantalla del Dispositivo en tiempo real.
        </p>
        <p>
          El Dispositivo no emitirá alertas ni permitirá acceso remoto hasta que se active una suscripción mediante el escaneo del código QR incluido.
        </p>
        <p>
          Esa suscripción es opcional y está sujeta a sus propios términos de servicio.
        </p>
        <blockquote className="border-l-4 border-gris-perla/80 pl-4 italic my-4 bg-gris-perla/50 p-4 rounded-md">
          Nota: el Dispositivo se entrega “activo localmente”, por lo que puede medir y mostrar información directamente, sin conexión a Internet ni registro en línea.
        </blockquote>

        <h2 className="text-2xl font-bold mt-8 mb-4">6. Instalación</h2>
        <p>
          La instalación corre por cuenta del Usuario o del técnico que este designe.
        </p>
        <p>
          Se recomienda que sea realizada por personal calificado conforme a las normas eléctricas aplicables (p. ej., NOM-001-SEDE-2012 o posteriores).
        </p>
        <p>
          La empresa no será responsable de daños ocasionados por instalaciones incorrectas, cortocircuitos, errores de cableado, mala conexión a tierra o uso indebido.
        </p>

        <h2 className="text-2xl font-bold mt-8 mb-4">7. Garantía</h2>
        <p>
          El Dispositivo cuenta con una garantía limitada de 6 (seis) meses contra defectos de fabricación, contados a partir de la fecha de compra.
        </p>
        <p>La garantía no cubre:</p>
        <ul className="list-disc list-inside space-y-1 my-2 pl-4">
          <li>daños derivados de instalación incorrecta, humedad o sobretensión,</li>
          <li>manipulación interna, alteración del firmware o mal uso,</li>
          <li>golpes, caídas o exposición a condiciones ambientales extremas.</li>
        </ul>
        <p>
          Para hacer válida la garantía, el Usuario deberá contactar a{' '}
          <a href="mailto:garantias-cuentatron@tesivil.com" className="text-azul-confianza hover:underline">
            garantias-cuentatron@tesivil.com
          </a>, adjuntando:
        </p>
        <ul className="list-disc list-inside space-y-1 my-2 pl-4">
          <li>comprobante de compra,</li>
          <li>número de serie del Dispositivo,</li>
          <li>descripción del defecto,</li>
          <li>fotografías o video del problema.</li>
        </ul>
        <p>
          El equipo de soporte determinará el procedimiento correspondiente (revisión, reparación o reemplazo).
        </p>

        <h2 className="text-2xl font-bold mt-8 mb-4">8. Devoluciones y reembolsos</h2>
        <p>
          Las devoluciones y reembolsos se regirán conforme a la legislación mexicana aplicable al comercio electrónico y la Política de Devolución y Reembolso publicada en el sitio web.
        </p>
        <p>
          Solo se aceptarán solicitudes dentro de los plazos establecidos por la PROFECO para compras en línea, siempre que el Dispositivo se encuentre en condiciones nuevas y con todos sus accesorios.
        </p>

        <h2 className="text-2xl font-bold mt-8 mb-4">9. Limitación de responsabilidad</h2>
        <p>La empresa no será responsable por:</p>
        <ul className="list-disc list-inside space-y-1 my-2 pl-4">
          <li>daños indirectos o consecuenciales,</li>
          <li>pérdidas económicas o de datos,</li>
          <li>interrupciones eléctricas o problemas derivados de la instalación.</li>
        </ul>
        <p>
          El Usuario reconoce que Cuentatrón no sustituye un medidor oficial de la CFE ni equipos certificados para facturación o diagnóstico industrial.
        </p>

        <h2 className="text-2xl font-bold mt-8 mb-4">10. Modificaciones al producto o documentación</h2>
        <p>
          La empresa podrá actualizar o modificar las características del producto, su empaque o manual, siempre que no afecten la funcionalidad principal del Dispositivo.
        </p>
        <p>
          Las versiones anteriores seguirán siendo válidas dentro de su periodo de garantía.
        </p>

        <h2 className="text-2xl font-bold mt-8 mb-4">11. Ley aplicable y jurisdicción</h2>
        <p>
          Estos Términos se rigen por las leyes de los Estados Unidos Mexicanos.
        </p>
        <p>
          Para la interpretación y cumplimiento, ambas partes se someten expresamente a los tribunales competentes de Zapopan, Jalisco, renunciando a cualquier otro fuero.
        </p>

        <h2 className="text-2xl font-bold mt-8 mb-4">12. Aceptación</h2>
        <p>
          Al completar el proceso de compra en línea, el Usuario declara haber leído, comprendido y aceptado íntegramente los presentes Términos y Condiciones de Venta.
        </p>
        <p>
          Su aceptación constituye consentimiento expreso conforme al Artículo 76 bis de la Ley Federal de Protección al Consumidor.
        </p>

        <h2 className="text-2xl font-bold mt-8 mb-4">Contacto</h2>
        <p>
          Para cualquier duda, aclaración o reclamación relacionada con la compra del Dispositivo Cuentatrón, el Usuario puede comunicarse a:
        </p>
        <p>
          📩{' '}
          <a href="mailto:contacto-cuentatron@tesivil.com" className="text-azul-confianza hover:underline">
            contacto-cuentatron@tesivil.com
          </a>
        </p>
        <p>
          📍 Av. Sebastián Bach 4978, Prados Guadalupe, Zapopan, Jalisco, México.
        </p>
      </div>
    </main>
  )
}