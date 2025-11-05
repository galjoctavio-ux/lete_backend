import React from 'react';
import { useAuth } from '../context/AuthContext';
import { Navigate, useLocation } from 'react-router-dom';

function ProtectedRoute({ children }) {
  const { user, isLoading } = useAuth();
  const location = useLocation();

  if (isLoading) {
    // Muestra 'Cargando...' mientras el AuthProvider
    // revisa el localStorage
    return <div>Cargando sesión...</div>;
  }

  if (!user) {
    // Si no hay usuario, redirige al Login
    // 'replace' evita que pueda volver atrás con el botón del navegador
    return <Navigate to="/" state={{ from: location }} replace />;
  }

  // Si hay usuario, muestra el componente hijo (el Dashboard)
  return children;
}

export default ProtectedRoute;
