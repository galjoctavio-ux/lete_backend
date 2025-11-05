import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import api from '../apiService';
// 1. Importar Link
import { Link } from 'react-router-dom';

// (Estilos ...)
const listStyle = { padding: '20px' };
const casoStyle = {
  background: '#fff',
  border: '1px solid #ddd',
  borderRadius: '8px',
  padding: '16px',
  marginBottom: '10px'
};

function CasosList() {
  const { user, logout } = useAuth();
  const [casos, setCasos] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const fetchCasos = async () => {
      setIsLoading(true);
      try {
        const response = await api.get('/casos');
        setCasos(response.data);
      } catch (err) {
        setError('Error al cargar casos asignados.');
      } finally {
        setIsLoading(false);
      }
    };
    fetchCasos();
  }, []);

  return (
    <div style={listStyle}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h3>Mis Casos Asignados</h3>
        <div>
          <span>Técnico: {user?.nombre}</span>
          <button onClick={logout} style={{ marginLeft: '10px' }}>Salir</button>
        </div>
      </header>
      <hr />
      {isLoading && <p>Cargando casos...</p>}
      {error && <p style={{ color: 'red' }}>{error}</p>}

      {!isLoading && !error && (
        <div>
          {casos.length === 0 ? (
            <p>No tienes casos asignados.</p>
          ) : (
            casos.map(caso => (
              <div key={caso.id} style={casoStyle}>
                <h4>Cliente: {caso.cliente_nombre}</h4>
                <p>Dirección: {caso.cliente_direccion}</p>
                <p>Estado: {caso.status}</p>

                {/* 2. Reemplazar el botón con un Link */}
                <Link to={`/revision/${caso.id}`}>
                  <button 
                    style={{ background: 'green', color: 'white', border: 'none', padding: '8px 12px' }}
                    disabled={caso.status === 'completado'}
                  >
                    {caso.status === 'completado' ? 'Revisión Completada' : 'Iniciar Revisión'}
                  </button>
                </Link>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

export default CasosList;
