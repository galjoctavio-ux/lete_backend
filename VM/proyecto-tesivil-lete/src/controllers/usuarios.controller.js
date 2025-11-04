import { supabaseAdmin } from '../services/supabaseClient.js';

// GET /usuarios/tecnicos
export const getTecnicos = async (req, res) => {
  try {
    // 1. Obtenemos SÓLO id y nombre de los perfiles de técnicos
    const { data: profilesData, error: profilesError } = await supabaseAdmin
      .from('profiles')
      .select('id, nombre') // <-- CORREGIDO: quitamos 'email'
      .eq('rol', 'tecnico');

    if (profilesError) throw profilesError;

    // 2. Obtenemos la lista de TODOS los usuarios desde Auth
    const { data: usersData, error: usersError } = await supabaseAdmin.auth.admin.listUsers();
    if (usersError) throw usersError;

    // 3. Combinamos las listas en el backend
    // Mapeamos los perfiles de técnicos con sus emails correspondientes
    const tecnicos = profilesData.map(profile => {
      const authUser = usersData.users.find(u => u.id === profile.id);
      return {
        id: profile.id,
        nombre: profile.nombre,
        email: authUser ? authUser.email : 'Email no encontrado'
      };
    });

    res.status(200).json(tecnicos);

  } catch (error) {
    res.status(500).json({ error: 'Error al obtener técnicos', details: error.message });
  }
};

// POST /usuarios (Crear Técnico)
export const createTecnico = async (req, res) => {
  const { nombre, email, password } = req.body;

  if (!nombre || !email || !password) {
    return res.status(400).json({ error: 'Nombre, email y password son requeridos' });
  }

  try {
    // 1. Crear el usuario en Supabase Auth
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email: email,
      password: password,
      email_confirm: true, // Puedes ponerlo en 'false' si no quieres que confirmen
    });

    if (authError) throw authError;

    // 2. Crear el perfil en nuestra tabla 'profiles'
    const { data: profileData, error: profileError } = await supabaseAdmin
      .from('profiles')
      .insert({
        id: authData.user.id, // Vinculamos con el ID de Auth
        nombre: nombre,
        rol: 'tecnico'
      })
      .select()
      .single();

    if (profileError) throw profileError;

    res.status(201).json({
      message: 'Técnico creado exitosamente',
      tecnico: {
        id: profileData.id,
        nombre: profileData.nombre,
        rol: profileData.rol,
        email: authData.user.email
      }
    });

  } catch (error) {
    // Manejo de error (ej. email ya existe)
    if (error.code === '23505') { // Error de violación de unicidad
       return res.status(409).json({ error: 'El email ya está en uso' });
    }
    res.status(500).json({ error: 'Error al crear técnico', details: error.message });
  }
};
