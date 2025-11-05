import axios from 'axios';

// 1. Obtenemos la URL base de la API desde las variables de entorno
const VITE_API_BASE_URL = import.meta.env.VITE_API_BASE_URL;

// 2. Creamos una instancia de Axios
const api = axios.create({
  baseURL: VITE_API_BASE_URL,
});

// 3. (Futuro) Aquí añadiremos un interceptor para adjuntar
// automáticamente el token a todas las peticiones

export default api;
