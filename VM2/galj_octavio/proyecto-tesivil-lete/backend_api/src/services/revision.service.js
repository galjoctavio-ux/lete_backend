import { supabaseAdmin, supabaseKey } from './supabaseClient.js';
import { Buffer } from 'buffer';
import { 
  calcularConsumoEquipos,
  detectarFugas,
  verificarSolar,
  generarDiagnosticosAutomaticos 
} from './calculos.service.js';
import { generarPDF } from './pdf.service.js';
// ¡NUEVO! Importamos nuestro servicio de email
import { enviarReportePorEmail } from './email.service.js';

export const processRevision = async (payload, tecnico) => {
  const { revisionData, equiposData, firmaBase64 } = payload;

  if (!revisionData || !equiposData) {
    throw new Error('Faltan "revisionData" o "equiposData"');
  }

  console.log(`Procesando revisión para el caso ${revisionData.caso_id} por el técnico ${tecnico.email}`);

  let casoData; // (¡NUEVO!) La necesitamos en 2 sitios, la declaramos aquí
  let pdfUrl = null; // (¡NUEVO!) Declarada aquí

  try {
    // --- PASO 1: Ejecutar TODOS los cálculos ---
    const voltajeMedido = revisionData.voltaje_medido;
    const equiposCalculados = calcularConsumoEquipos(equiposData, voltajeMedido);
    const diagnosticoFuga = detectarFugas(revisionData);
    const diagnosticoSolar = verificarSolar(revisionData);
    const diagnosticos = generarDiagnosticosAutomaticos(
      revisionData, 
      equiposCalculados, 
      diagnosticoFuga, 
      diagnosticoSolar
    );
    console.log('Diagnósticos generados:', diagnosticos);

    // --- PASO 2: Guardar la Revisión Principal ---
    const { data: revisionResult, error: revisionError } = await supabaseAdmin
      .from('revisiones')
      .insert({ 
          ...revisionData,
          diagnosticos_automaticos: diagnosticos
      })
      .select()
      .single();

    if (revisionError) throw revisionError;

    const newRevisionId = revisionResult.id;

    // --- PASO 3: Guardar Equipos ---
    let equiposProcesados = 0;
    if (equiposCalculados.length > 0) {
        const equiposParaInsertar = equiposCalculados.map(equipo => ({
          ...equipo,
          revision_id: newRevisionId
        }));
        const { error: equiposError } = await supabaseAdmin
          .from('equipos_revisados')
          .insert(equiposParaInsertar);
        if (equiposError) throw equiposError;
        equiposProcesados = equiposParaInsertar.length;
        console.log(`Guardados ${equiposProcesados} equipos para la revisión ${newRevisionId}`);
    }

    // --- PASO 4: Actualizar el Status del Caso ---
    const { data: casoUpdated, error: casoError } = await supabaseAdmin
      .from('casos')
      .update({ status: 'completado' })
      .eq('id', revisionData.caso_id)
      .select('cliente_nombre') // (¡NUEVO!) Obtenemos el nombre del cliente
      .single();

    if (casoError) console.warn(`Error al actualizar caso ${revisionData.caso_id}:`, casoError.message);
    casoData = casoUpdated; // Guardamos los datos del caso

    // --- PASO 5: Procesar Firma ---
    let firmaUrl = null;
    if (firmaBase64) {
        console.log('Procesando firma...');
        const matches = firmaBase64.match(/^data:(.+);base64,(.+)$/);
        if (!matches || matches.length !== 3) throw new Error('Formato de firmaBase64 inválido');

        const contentType = matches[1];
        const data = Buffer.from(matches[2], 'base64');
        const filePath = `firmas/revision-${newRevisionId}.png`;

        const { error: uploadError } = await supabaseAdmin.storage
          .from('reportes')
          .upload(filePath, data, { contentType });
        if (uploadError) throw uploadError;

        const { data: urlData } = supabaseAdmin.storage.from('reportes').getPublicUrl(filePath);
        firmaUrl = urlData.publicUrl;
        console.log('Firma subida a:', firmaUrl);

        await supabaseAdmin
          .from('revisiones')
          .update({ firma_url: firmaUrl })
          .eq('id', newRevisionId);
    }

    // --- PASO 6: Generar y Subir PDF ---
    console.log('Iniciando recopilación de datos para PDF...');
    const { data: tecnicoData } = await supabaseAdmin
      .from('profiles')
      .select('nombre')
      .eq('id', tecnico.id)
      .single();

    const datosParaPDF = {
      cliente_nombre: casoData?.cliente_nombre,
      cliente_direccion: revisionData.cliente_direccion, // Asumimos que viene en revisionData
      cliente_email: revisionResult.cliente_email,
      fecha_revision: revisionResult.fecha_revision,
      tecnico_nombre: tecnicoData?.nombre,
      revision: { ...revisionResult, firma_url: firmaUrl },
      equipos: equiposCalculados
    };

    const pdfBuffer = await generarPDF(datosParaPDF);
    console.log('Buffer de PDF generado.');

    const pdfFilePath = `pdfs/reporte-revision-${newRevisionId}.pdf`;
    const { error: pdfUploadError } = await supabaseAdmin.storage
      .from('reportes')
      .upload(pdfFilePath, pdfBuffer, { contentType: 'application/pdf' });

    if (pdfUploadError) throw pdfUploadError;

    const { data: pdfUrlData } = supabaseAdmin.storage.from('reportes').getPublicUrl(pdfFilePath);
    pdfUrl = pdfUrlData.publicUrl;
    console.log('PDF subido a:', pdfUrl);

    await supabaseAdmin
      .from('revisiones')
      .update({ pdf_url: pdfUrl })
      .eq('id', newRevisionId);

    // --- PASO 7: Enviar Email (¡NUEVO!) ---
    if (pdfUrl && revisionResult.cliente_email && casoData?.cliente_nombre) {
      await enviarReportePorEmail(
        revisionResult.cliente_email,
        casoData.cliente_nombre,
        pdfUrl
      );
    } else {
      console.warn('Faltan datos (pdfUrl, email o nombre) para enviar el correo.');
    }

    console.log(`Revisión ${newRevisionId} guardada. Caso ${revisionData.caso_id} completado.`);

    return {
      message: `Revisión guardada. ${equiposProcesados} equipos. ${diagnosticos.length} diagnósticos.`,
      revision_id: newRevisionId,
      diagnosticos_generados: diagnosticos,
      firma_url: firmaUrl,
      pdf_url: pdfUrl
    };

  } catch (error) {
      console.error('Error fatal durante el procesamiento de la revisión:', error.message);
      // Devolvemos el error
      throw error;
  }
};
