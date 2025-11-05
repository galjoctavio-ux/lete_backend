import { Router } from 'express';
import { loginUsuario } from '../controllers/auth.controller.js';

const router = Router();

// Define el endpoint de login
// Ruta final será: POST /lete/api/auth/login
router.post('/login', loginUsuario);

export default router;
