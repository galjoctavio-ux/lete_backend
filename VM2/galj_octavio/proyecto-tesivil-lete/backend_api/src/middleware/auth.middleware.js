// Importa sin 'supabaseKey'
import { supabaseAdmin, SUPABASE_JWT_SECRET } from '../services/supabaseClient.js';
import jwt from 'jsonwebtoken';

// Este middleware verifica que el token sea válido
export const requireAuth = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided. Authorization header required.' });
  }

  const token = authHeader.split(' ')[1];

  if (!SUPABASE_JWT_SECRET) {
    console.error('Error fatal: SUPABASE_JWT_SECRET no está configurado en .env');
    return res.status(500).json({ error: 'Error de configuración del servidor' });
  }

  try {
    // 1. Verificar el token manualmente usando el secreto
    const payload = jwt.verify(token, SUPABASE_JWT_SECRET);

    // El ID de usuario está en 'payload.sub'
    const userId = payload.sub;
    if (!userId) {
      return res.status(401).json({ error: 'Token inválido (sin "sub" - subject)' });
    }

    console.log('Usuario autenticado (JWT manual):', userId, payload.email);

    // 2. Obtener el perfil del usuario (para saber su rol)
    const { data: profile, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('rol')
      .eq('id', userId)
      .single();

    if (profileError) {
      console.error('Error al obtener perfil:', profileError.message);
      return res.status(403).json({ error: 'Usuario autenticado pero sin perfil de rol.', details: profileError.message });
    }

    if (!profile) {
      return res.status(403).json({ error: 'No se encontró perfil para este usuario.' });
    }

    console.log('Perfil encontrado - Rol:', profile.rol);

    // 3. Guardamos los datos del usuario en 'req' para usarlo después
    req.user = {
      id: userId,
      email: payload.email,
      rol: profile.rol
    };
    
    // LÍNEA ERRÓNEA ELIMINADA
    
    next(); // ¡Éxito! Pasa al siguiente controlador

  } catch (error) {
    // El token expiró o es inválido
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expirado' });
    }
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ error: 'Token inválido' });
    }
    console.error('Error en middleware de autenticación:', error);
    return res.status(500).json({ error: 'Error interno al validar token.', details: error.message });
  }
};

// =======================================================
// ESTOS MIDDLEWARES ESTÁN PERFECTOS. NO NECESITAN CAMBIOS
// =======================================================

// Este middleware se usa *después* de requireAuth
// y verifica que el rol sea 'admin'
export const isAdmin = (req, res, next) => {
  console.log('Verificando rol de admin. Usuario:', req.user?.email, 'Rol:', req.user?.rol);

  if (req.user && req.user.rol === 'admin') {
    next(); // Es admin, continuar
  } else {
    return res.status(403).json({
      error: 'Acceso denegado. Se requiere rol de Administrador.',
      userRole: req.user?.rol
    });
  }
};

// Este middleware se usa *después* de requireAuth
// y verifica que el rol sea 'tecnico'
export const isTecnico = (req, res, next) => {
  console.log('Verificando rol de tecnico. Usuario:', req.user?.email, 'Rol:', req.user?.rol);

  if (req.user && req.user.rol === 'tecnico') {
    next(); // Es tecnico, continuar
  } else {
    return res.status(403).json({
      error: 'Acceso denegado. Se requiere rol de Técnico.',
      userRole: req.user?.rol
    });
  }
};