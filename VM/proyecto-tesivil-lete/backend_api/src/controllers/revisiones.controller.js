import { processRevision } from '../services/revision.service.js';
import { supabaseAdmin, supabaseKey } from '../services/supabaseClient.js';

export const submitRevision = async (req, res) => {
  try {
    // req.user viene del middleware
    const tecnico = req.user; 

    // El body es el JSON gigante
    const revisionPayload = req.body; 

    // 1. Delegamos TODA la lógica de negocio al servicio
    const result = await processRevision(revisionPayload, tecnico);

    res.status(201).json(result);

  } catch (error) {
    console.error('Error en el controlador de revisión:', error.message);

    // ¡Importante! Si el servicio falla, limpiamos el cliente
    // por si acaso quedó "contaminado"


    res.status(500).json({ error: 'Error fatal al procesar la revisión', details: error.message });
  }
};
