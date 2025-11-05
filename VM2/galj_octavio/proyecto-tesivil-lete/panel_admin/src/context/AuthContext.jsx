import React, { createContext, useState, useContext, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../apiService'; // Nuestro cliente Axios

// 1. Crear el Contexto
const AuthContext = createContext(null);

// 2. Crear el "Proveedor" (el componente contenedor)
export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(null);
  const [isLoading, setIsLoading] = useState(true); // Para el arranque
  const navigate = useNavigate();

  // 3. Efecto de "Arranque"
  // Revisa localStorage al cargar la app
  useEffect(() => {
    const storedToken = localStorage.getItem('authToken');
    const storedUser = localStorage.getItem('user');

    if (storedToken && storedUser) {
      setUser(JSON.parse(storedUser));
      setToken(storedToken);
      // ¡Importante! Configura Axios para usar este token en TODAS las peticiones
      api.defaults.headers.common['Authorization'] = `Bearer ${storedToken}`;
    }
    setIsLoading(false); // Terminamos de cargar
  }, []);

  // 4. Función de Login
  const login = async (email, password) => {
    try {
      const response = await api.post('/auth/login', { email, password });
      const { user, session } = response.data;

      if (user && session && user.rol === 'admin') {
        // Establecer estado
        setUser(user);
        setToken(session.access_token);
        
        // Guardar en localStorage
        localStorage.setItem('authToken', session.access_token);
        localStorage.setItem('user', JSON.stringify(user));
        
        // Configurar Axios
        api.defaults.headers.common['Authorization'] = `Bearer ${session.access_token}`;
        
        navigate('/dashboard'); // Redirigir
        return true; // Éxito
      } else {
        throw new Error('Acceso denegado. Se requiere cuenta de Administrador.');
      }
    } catch (error) {
      console.error('Error en el login:', error);
      // Lanzamos el error para que el formulario de Login lo muestre
      throw error; 
    }
  };

  // 5. Función de Logout
  const logout = () => {
    // Limpiar estado
    setUser(null);
    setToken(null);
    
    // Limpiar localStorage
    localStorage.removeItem('authToken');
    localStorage.removeItem('user');
    
    // Limpiar Axios
    delete api.defaults.headers.common['Authorization'];
    
    navigate('/'); // Redirigir a Login
  };

  // 6. Valor que compartiremos
  const value = {
    user,
    token,
    isLoading,
    login,
    logout,
  };

  // No renderiza nada si está cargando el estado inicial
  if (isLoading) {
    return <div>Cargando...</div>;
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// 7. Hook personalizado para consumir el contexto fácilmente
export function useAuth() {
  return useContext(AuthContext);
}
