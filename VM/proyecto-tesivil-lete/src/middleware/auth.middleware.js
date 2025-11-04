import { supabaseAdmin } from '../services/supabaseClient.js';

// Este middleware verifica que el token sea válido
export const requireAuth = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided. Authorization header required.' });
  }

  const token = authHeader.split(' ')[1];

  // 1. Validar el token con Supabase
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);

  if (error || !user) {
    return res.status(401).json({ error: 'Token inválido o expirado.' });
  }

  // 2. Obtener el perfil del usuario (para saber su rol)
  const { data: profile, error: profileError } = await supabaseAdmin
    .from('profiles')
    .select('rol')
    .eq('id', user.id)
    .single();

  if (profileError || !profile) {
    return res.status(403).json({ error: 'Usuario autenticado pero sin perfil de rol.' });
  }

  // 3. Guardamos el usuario y su rol en el objeto 'req' para usarlo después
  req.user = user;
  req.user.rol = profile.rol;
await supabaseAdmin.auth.signOut();
  next(); // ¡Éxito! Pasa al siguiente controlador
};

// Este middleware se usa *después* de requireAuth
// y verifica que el rol sea 'admin'
export const isAdmin = (req, res, next) => {
  if (req.user && req.user.rol === 'admin') {
    next(); // Es admin, continuar
  } else {
    return res.status(403).json({ error: 'Acceso denegado. Se requiere rol de Administrador.' });
  }
};
