import React from 'react';
import { Routes, Route } from 'react-router-dom';
import Login from './pages/Login';
import CasosList from './pages/CasosList';
import ProtectedRoute from './components/ProtectedRoute';
import './App.css';

// 1. Importar la nueva página
import RevisionForm from './pages/RevisionForm';

function App() {
  return (
    <Routes>
      {/* Ruta Pública: Login */}
      <Route path="/" element={<Login />} />

      {/* Ruta Protegida: Lista de Casos */}
      <Route 
        path="/casos" 
        element={
          <ProtectedRoute>
            <CasosList />
          </ProtectedRoute>
        } 
      />

      {/* 2. NUEVA Ruta Protegida: Formulario de Revisión */}
      <Route 
        path="/revision/:casoId" 
        element={
          <ProtectedRoute>
            <RevisionForm />
          </ProtectedRoute>
        } 
      />
    </Routes>
  );
}

export default App;
