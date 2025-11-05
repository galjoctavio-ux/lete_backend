
import { supabaseAdmin, supabaseKey } from '../services/supabaseClient.js'; // ¡Asegúrate que importe 'supabaseKey'!

// GET /usuarios/tecnicos
export const getTecnicos = async (req, res) => {
  try {
    console.log('Obteniendo lista de técnicos...');

    // 1. Obtenemos SÓLO id y nombre de los perfiles de técnicos
    const { data: profilesData, error: profilesError } = await supabaseAdmin
      .from('profiles')
      .select('id, nombre')
      .eq('rol', 'tecnico');

    if (profilesError) {
      console.error('Error al obtener perfiles:', profilesError.message);
      throw profilesError;
    }

supabaseAdmin.global.headers['Authorization'] = `Bearer ${supabaseKey}`;

    console.log(`Perfiles encontrados: ${profilesData.length}`);

    // 2. Obtenemos la lista de usuarios desde Auth usando el método correcto
    const { data: usersResponse, error: usersError } = await supabaseAdmin.auth.admin.listUsers();
    
    if (usersError) {
      console.error('Error al listar usuarios:', usersError.message);
      throw usersError;
    }

    console.log(`Usuarios en Auth: ${usersResponse.users.length}`);

    // 3. Combinamos las listas en el backend
    const tecnicos = profilesData.map(profile => {
      const authUser = usersResponse.users.find(u => u.id === profile.id);
      return {
        id: profile.id,
        nombre: profile.nombre,
        email: authUser ? authUser.email : 'Email no encontrado'
      };
    });

    console.log(`Técnicos procesados: ${tecnicos.length}`);
    res.status(200).json(tecnicos);

  } catch (error) {
    console.error('Error completo:', error);
    res.status(500).json({ 
      error: 'Error al obtener técnicos', 
      details: error.message 
    });
  }
};

// POST /usuarios (Crear Técnico)
export const createTecnico = async (req, res) => {
  const { nombre, email, password } = req.body;

  if (!nombre || !email || !password) {
    return res.status(400).json({ error: 'Nombre, email y password son requeridos' });
  }

  try {
    console.log('Creando nuevo técnico:', email);

    // 1. Crear el usuario en Supabase Auth
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email: email,
      password: password,
      email_confirm: true,
    });

    if (authError) {
      console.error('Error al crear usuario en Auth:', authError.message);
      throw authError;
    }


    console.log('Usuario creado en Auth:', authData.user.id);

    // 2. Crear el perfil en nuestra tabla 'profiles'
    const { data: profileData, error: profileError } = await supabaseAdmin
      .from('profiles')
      .insert({
        id: authData.user.id,
        nombre: nombre,
        rol: 'tecnico'
      })
      .select()
      .single();

    if (profileError) {
      console.error('Error al crear perfil:', profileError.message);
      // Si falla el perfil, intentamos eliminar el usuario de Auth
      await supabaseAdmin.auth.admin.deleteUser(authData.user.id);
      throw profileError;
    }

    console.log('Perfil creado exitosamente');

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
    console.error('Error completo al crear técnico:', error);
    
    // Manejo de error (ej. email ya existe)
    if (error.code === '23505') {
      return res.status(409).json({ error: 'El email ya está en uso' });
    }
    
    res.status(500).json({ 
      error: 'Error al crear técnico', 
      details: error.message 
    });
  }
};
