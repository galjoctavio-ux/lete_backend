import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import CasosList from '../components/CasosList';
import Modal from '../components/Modal';
import CrearCasoForm from '../components/CrearCasoForm';

// ¡NUEVO! Importar componentes de técnico
import TecnicosList from '../components/TecnicosList';
import CrearTecnicoForm from '../components/CrearTecnicoForm';

function Dashboard() {
  const { user, logout } = useAuth();

  // Estado para los modales
  const [isCasoModalOpen, setIsCasoModalOpen] = useState(false);
  const [isTecnicoModalOpen, setIsTecnicoModalOpen] = useState(false);

  // Estado para refrescar las listas
  const [refreshCasosKey, setRefreshCasosKey] = useState(0);
  const [refreshTecnicosKey, setRefreshTecnicosKey] = useState(0); 

  // Funciones de refresco
  const handleCasoActualizado = () => {
    setRefreshCasosKey(oldKey => oldKey + 1);
  };
  const handleTecnicoActualizado = () => {
    setRefreshTecnicosKey(oldKey => oldKey + 1);
  };

  return (
    <div style={{ padding: '20px' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2>Dashboard de Admin</h2>
        <div>
          <span>¡Bienvenido, {user?.nombre || 'Admin'}!</span>
          <button onClick={logout} style={{ marginLeft: '15px' }}>Cerrar Sesión</button>
        </div>
      </header>

      <hr />

      {/* --- SECCIÓN CASOS --- */}
      <button onClick={() => setIsCasoModalOpen(true)}>
        + Crear Nuevo Caso
      </button>
      <CasosList key={refreshCasosKey} onDatosActualizados={handleCasoActualizado} />

      {/* --- SECCIÓN TÉCNICOS (¡NUEVO!) --- */}
      <div style={{marginTop: '20px'}}>
        <button onClick={() => setIsTecnicoModalOpen(true)}>
          + Crear Nuevo Técnico
        </button>
        <TecnicosList key={refreshTecnicosKey} />
      </div>

      {/* --- MODALES (Ocultos) --- */}
      <Modal isOpen={isCasoModalOpen} onClose={() => setIsCasoModalOpen(false)}>
        <CrearCasoForm 
          onClose={() => setIsCasoModalOpen(false)}
          onCasoCreado={handleCasoActualizado}
        />
      </Modal>

      <Modal isOpen={isTecnicoModalOpen} onClose={() => setIsTecnicoModalOpen(false)}>
        <CrearTecnicoForm
          onClose={() => setIsTecnicoModalOpen(false)}
          onTecnicoCreado={handleTecnicoActualizado}
        />
      </Modal>
    </div>
  );
}

export default Dashboard;
