import { Router } from 'express';
import { requireAuth, isAdmin } from '../middleware/auth.middleware.js';
import { getTecnicos, createTecnico } from '../controllers/usuarios.controller.js';

const router = Router();

// Aplicamos los middlewares:
// 1. Debe estar autenticado (requireAuth)
// 2. Debe ser admin (isAdmin)
router.use(requireAuth, isAdmin);

// GET /lete/api/usuarios/tecnicos
router.get('/tecnicos', getTecnicos);

// POST /lete/api/usuarios (para crear técnicos)
router.post('/', createTecnico);

// Aquí irían PUT y DELETE en el futuro

export default router;
