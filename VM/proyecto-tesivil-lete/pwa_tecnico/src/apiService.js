import axios from 'axios';

// 1. Obtenemos la URL base de la API desde las variables de entorno
const VITE_API_BASE_URL = import.meta.env.VITE_API_BASE_URL;

// 2. Creamos una instancia de Axios
const api = axios.create({
  baseURL: VITE_API_BASE_URL,
});

// 3. El AuthContext se encargará de configurar el token
// de autorización en esta instancia.

export default api;
