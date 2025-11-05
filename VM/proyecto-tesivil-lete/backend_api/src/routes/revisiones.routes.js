import { Router } from 'express';
import { requireAuth, isTecnico } from '../middleware/auth.middleware.js';
import { submitRevision } from '../controllers/revisiones.controller.js';

const router = Router();

// POST /lete/api/revisiones
// Solo los técnicos autenticados pueden enviar revisiones
router.post('/', requireAuth, isTecnico, submitRevision);

export default router;
