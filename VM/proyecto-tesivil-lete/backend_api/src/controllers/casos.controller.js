import { supabaseAdmin } from '../services/supabaseClient.js';

// POST /casos (Crear nuevo caso)
export const createCaso = async (req, res) => {
  const { cliente_nombre, cliente_direccion, cliente_telefono, comentarios_iniciales } = req.body;

  if (!cliente_nombre || !cliente_direccion) {
    return res.status(400).json({ error: 'Nombre y dirección del cliente son requeridos' });
  }

  try {
    // Como el middleware limpió el cliente, esto usa la SERVICE_KEY
    // y se salta el RLS
    const { data, error } = await supabaseAdmin
      .from('casos')
      .insert({
        cliente_nombre,
        cliente_direccion,
        cliente_telefono,
        comentarios_iniciales,
        status: 'pendiente' // Status inicial
      })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json(data);
  } catch (error) {
    console.error('Error al crear caso:', error);
    res.status(500).json({ error: 'Error al crear el caso', details: error.message });
  }
};

// GET /casos (Listar todos los casos)
// GET /casos (Listar casos por rol)
export const getCasos = async (req, res) => {
  // req.user fue añadido por el middleware requireAuth
  const { id: userId, rol } = req.user;

  try {
    // Construimos la query base
    let query = supabaseAdmin
      .from('casos')
      .select(`
        id,
        cliente_nombre,
        cliente_direccion,
        status,
        fecha_creacion,
        tecnico:profiles ( nombre )
      `)
      .order('fecha_creacion', { ascending: false });

    // ¡Lógica de Roles!
    if (rol === 'admin') {
      // El admin ve todo (no añade filtros)
      console.log('Listando casos para ADMIN');
    } else if (rol === 'tecnico') {
      // El técnico solo ve sus casos asignados
      console.log(`Listando casos para TECNICO: ${userId}`);
      query = query.eq('tecnico_id', userId);
    } else {
      return res.status(403).json({ error: 'Rol no autorizado para ver casos' });
    }

    // Ejecutamos la query
    const { data, error } = await query;

    if (error) throw error;
    res.status(200).json(data);

  } catch (error) {
    console.error('Error al listar casos:', error);
    res.status(500).json({ error: 'Error al listar los casos', details: error.message });
  }
};

// PUT /casos/:id (Asignar/Actualizar caso)
export const updateCaso = async (req, res) => {
  const { id } = req.params;
  const { tecnico_id, status } = req.body; // El admin enviará esto

  if (!tecnico_id && !status) {
    return res.status(400).json({ error: 'Se requiere "tecnico_id" o "status" para actualizar' });
  }

  // Creamos el objeto de actualización dinámicamente
  const updates = {};
  if (tecnico_id) updates.tecnico_id = tecnico_id;
  if (status) updates.status = status;

  // Si asignamos un técnico, cambiamos el status automáticamente
  if (tecnico_id) updates.status = 'asignado';

  try {
    const { data, error } = await supabaseAdmin
      .from('casos')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    res.status(200).json(data);
  } catch (error) {
    console.error('Error al actualizar caso:', error);
    res.status(500).json({ error: 'Error al actualizar el caso', details: error.message });
  }
};
