import React from 'react';
import { Routes, Route } from 'react-router-dom';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import ProtectedRoute from './components/ProtectedRoute'; // 1. Importar
import './App.css';

function App() {
  return (
    <Routes>
      {/* Ruta Pública: Login */}
      <Route path="/" element={<Login />} />

      {/* Ruta Protegida: Dashboard */}
      <Route 
        path="/dashboard" 
        element={
          // 2. Envolver el componente
          <ProtectedRoute>
            <Dashboard />
          </ProtectedRoute>
        } 
      />
    </Routes>
  );
}

export default App;
