import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error('Faltan variables de entorno de Supabase (URL o SERVICE_KEY)');
}

// Creamos un cliente "Admin" que usa la SERVICE_KEY.
// Este cliente puede saltarse las políticas de RLS (Row Level Security).
// Lo usamos SÓLO en el backend para operaciones seguras (cálculos, reportes).
export const supabaseAdmin = createClient(supabaseUrl, supabaseKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
});
