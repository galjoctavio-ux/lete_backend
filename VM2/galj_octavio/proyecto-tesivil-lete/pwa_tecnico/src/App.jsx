import React from 'react';
import { Routes, Route } from 'react-router-dom';
import Login from './pages/Login';
import CasosList from './pages/CasosList';
import ProtectedRoute from './components/ProtectedRoute';
import RevisionForm from './pages/RevisionForm';
import './App.css';

// 1. Importar el nuevo componente
import ReloadPrompt from './components/ReloadPrompt';

function App() {
  return (
    <>
      {/* 2. Añadir el componente (él mismo se gestiona) */}
      <ReloadPrompt />

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

        {/* Ruta Protegida: Formulario de Revisión */}
        <Route 
          path="/revision/:casoId" 
          element={
            <ProtectedRoute>
              <RevisionForm />
            </ProtectedRoute>
          } 
        />
      </Routes>
    </>
  );
}

export default App;
