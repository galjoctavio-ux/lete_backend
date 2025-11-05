import { Router } from 'express';
// IMPORTACIONES ACTUALIZADAS
import { requireAuth, isAdmin, isTecnico } from '../middleware/auth.middleware.js';
import { getCasos, createCaso, updateCaso } from '../controllers/casos.controller.js';

const router = Router();

// RUTAS ACTUALIZADAS (Middleware por ruta)

// GET /lete/api/casos (Admin: ver todos | Tecnico: ver los suyos)
// Primero requireAuth, y LUEGO el controlador decidirá
router.get('/', requireAuth, getCasos);

// POST /lete/api/casos (Admin: crear nuevo)
// Solo para Admins
router.post('/', requireAuth, isAdmin, createCaso);

// PUT /lete/api/casos/:id (Admin: asignar técnico, cambiar status)
// Solo para Admins
router.put('/:id', requireAuth, isAdmin, updateCaso);

export default router;
