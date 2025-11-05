import puppeteer from 'puppeteer';

/**
 * Esta función contiene la plantilla HTML base.
 * En un proyecto más grande, esto estaría en su propio archivo .html
 */
const getHtmlPlantilla = () => {
  // Esta es una plantilla MUY básica.
  // Aquí es donde se invertiría tiempo de frontend para que se vea como el folleto.
  return `
    <style>
      body { font-family: Arial, sans-serif; margin: 40px; }
      h1 { color: #005a9c; } /* Color corporativo (ejemplo) */
      .seccion { margin-top: 20px; border-top: 1px solid #ccc; padding-top: 10px; }
      .diagnostico-peligro { color: red; font-weight: bold; }
      .firma { margin-top: 40px; }
    </style>
    <body>
      <h1>Luz en tu Espacio - Reporte de Diagnóstico Eléctrico</h1>
      <p><strong>Cliente:</strong> {{cliente_nombre}}</p>
      <p><strong>Email:</strong> {{cliente_email}}</p>
      <p><strong>Dirección:</strong> {{cliente_direccion}}</p>
      <p><strong>Fecha de Revisión:</strong> {{fecha_revision}}</p>
      <p><strong>Técnico:</strong> {{tecnico_nombre}}</p>

      <div class="seccion">
        <h2>Diagnóstico General</h2>
        <ul>
          {{diagnosticos_lista}}
        </ul>
      </div>

      <div class="seccion">
        <h2>🏆 Top 5 Consumidores (kWh/Bimestre)</h2>
        <ol>
          {{top_5_consumidores}}
        </ol>
      </div>

      <div class="seccion">
        <h2>Hallazgos de Instalación</h2>
        <p><strong>Tipo de Servicio:</strong> {{tipo_servicio}}</p>
        <p><strong>Edad de Instalación:</strong> {{edad_instalacion}}</p>
        <p><strong>Observaciones C.C.:</strong> {{observaciones_cc}}</p>
      </div>

      <div class="seccion">
        <h2>Firma del Cliente</h2>
        <img class="firma" src="{{firma_url}}" alt="Firma del Cliente" width="300" />
      </div>
    </body>
  `;
};

/**
 * Función principal que genera el buffer del PDF
 * @param {Object} datos - Un objeto con todos los datos de la revisión
 * @returns {Buffer} El buffer del archivo PDF
 */
export const generarPDF = async (datos) => {
  console.log('Iniciando generación de PDF...');

  let html = getHtmlPlantilla();

  // 1. Reemplazar datos básicos
  html = html.replace('{{cliente_nombre}}', datos.cliente_nombre || 'N/A');
  html = html.replace('{{cliente_email}}', datos.cliente_email || 'N/A');
  html = html.replace('{{cliente_direccion}}', datos.cliente_direccion || 'N/A');
  html = html.replace('{{fecha_revision}}', new Date(datos.fecha_revision).toLocaleDateString('es-MX'));
  html = html.replace('{{tecnico_nombre}}', datos.tecnico_nombre || 'N/A');
  html = html.replace('{{tipo_servicio}}', datos.revision.tipo_servicio || 'N/A');
  html = html.replace('{{edad_instalacion}}', datos.revision.edad_instalacion || 'N/A');
  html = html.replace('{{observaciones_cc}}', datos.revision.observaciones_cc || 'N/A');
  html = html.replace('{{firma_url}}', datos.revision.firma_url || '');

  // 2. Generar lista de diagnósticos
  let listaHtml = '';
  if (datos.revision.diagnosticos_automaticos && datos.revision.diagnosticos_automaticos.length > 0) {
    datos.revision.diagnosticos_automaticos.forEach(diag => {
      const clase = diag.startsWith('¡PELIGRO!') ? 'class="diagnostico-peligro"' : '';
      listaHtml += `<li ${clase}>${diag}</li>`;
    });
  } else {
    listaHtml = '<li>Sin diagnósticos automáticos.</li>';
  }
  html = html.replace('{{diagnosticos_lista}}', listaHtml);

  // 3. Generar Top 5 Consumidores
  let top5Html = '';
  if (datos.equipos && datos.equipos.length > 0) {
    // Ordenar por kWh (descendente) y tomar los 5 primeros
    const top5 = [...datos.equipos]
      .sort((a, b) => b.kwh_bimestre_calculado - a.kwh_bimestre_calculado)
      .slice(0, 5);

    top5.forEach(eq => {
      const nombre = eq.nombre_personalizado || eq.nombre_equipo;
      top5Html += `<li>${nombre} - ${eq.kwh_bimestre_calculado} kWh/bimestre</li>`;
    });
  } else {
    top5Html = '<li>No se registraron equipos.</li>';
  }
  html = html.replace('{{top_5_consumidores}}', top5Html);

  // 4. Lanzar Puppeteer y generar el PDF
  const browser = await puppeteer.launch({ 
    args: ['--no-sandbox', '--disable-setuid-sandbox'] // Requerido para correr en servidores Linux
  });
  const page = await browser.newPage();

  // Cargamos nuestro HTML
  await page.setContent(html, { waitUntil: 'networkidle0' });

  // "Imprimimos" a PDF
  const pdfBuffer = await page.pdf({
    format: 'Letter',
    printBackground: true
  });

  await browser.close();
  console.log('PDF generado exitosamente.');
  return pdfBuffer;
};
