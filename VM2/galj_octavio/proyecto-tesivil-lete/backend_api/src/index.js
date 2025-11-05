import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import authRoutes from './routes/auth.routes.js';
import usuariosRoutes from './routes/usuarios.routes.js';
import casosRoutes from './routes/casos.routes.js';
import revisionesRoutes from './routes/revisiones.routes.js';

// Cargar variables de entorno
dotenv.config();

const app = express();
const port = process.env.PORT || 3001;

// --- Middlewares Esenciales ---
app.use(cors()); // Habilita CORS (lo afinaremos después)
app.use(express.json({ limit: '10mb' })); // Para parsear JSON (subimos la firma en base64)

// --- Router Principal ---
// Aquí definiremos todas nuestras rutas
const apiRouter = express.Router();

// Ruta de prueba de salud
// (Será accesible en www.tesivil.com/lete/api/health)
apiRouter.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    message: 'API de TESIVIL está viva y conectada.',
    timestamp: new Date().toISOString()
  });
});

// Rutas de Autenticación
apiRouter.use('/auth', authRoutes);

apiRouter.use('/usuarios', usuariosRoutes);
apiRouter.use('/casos', casosRoutes);
apiRouter.use('/revisiones', revisionesRoutes);

// ¡IMPORTANTE! Montamos nuestro router en el prefijo que definimos
app.use('/lete/api', apiRouter);

// --- Manejador de errores básico ---
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).send('Algo salió mal en el servidor');
});

// --- Iniciar Servidor ---
app.listen(port, () => {
  console.log(`Backend API Server corriendo en http://localhost:${port}`);
  console.log(`Ruta pública (via NGINX): /lete/api`);
});

// Exportamos 'apiRouter' para poder añadirle más rutas desde otros archivos
export { apiRouter };
