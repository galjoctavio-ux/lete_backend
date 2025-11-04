import { supabaseAdmin } from '../services/supabaseClient.js';

export const loginUsuario = async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email y contraseña son requeridos' });
  }

  try {
    // 1. Autenticar al usuario con Supabase Auth
    const { data: authData, error: authError } = await supabaseAdmin.auth.signInWithPassword({
      email: email,
      password: password,
    });

    if (authError) {
      console.error('Error de autenticación:', authError.message);
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    if (!authData.user) {
      return res.status(401).json({ error: 'Usuario no encontrado' });
    }

    // 2. Obtener el perfil (rol y nombre) de nuestra tabla 'profiles'
    const { data: profileData, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('nombre, rol')
      .eq('id', authData.user.id)
      .single(); // .single() espera un solo resultado (o da error)

    if (profileError || !profileData) {
      console.error('Error al buscar perfil:', profileError?.message);
      // Importante: Si se autentica pero no tiene perfil, es un error de integridad
      return res.status(403).json({ error: 'Usuario autenticado pero sin perfil de rol asignado.' });
    }

    // 3. Enviar la respuesta exitosa
    res.status(200).json({
      message: 'Login exitoso',
      user: {
        id: authData.user.id,
        email: authData.user.email,
        nombre: profileData.nombre,
        rol: profileData.rol,
      },
      session: authData.session, // Contiene access_token y refresh_token
    });

  } catch (error) {
    console.error('Error en el controlador de login:', error.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};
