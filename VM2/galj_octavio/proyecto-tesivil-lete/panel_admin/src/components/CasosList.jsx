import React, { useState, useEffect } from 'react';
import api from '../apiService';
import AsignarCasoModal from './AsignarCasoModal';

const tableStyle = {
  width: '100%',
  borderCollapse: 'collapse',
  marginTop: '20px',
};
const thStyle = {
  border: '1px solid #ddd',
  padding: '8px',
  backgroundColor: '#f2f2f2',
  textAlign: 'left',
};
const tdStyle = {
  border: '1px solid #ddd',
  padding: '8px',
};

function CasosList({ onDatosActualizados }) { // 1. Recibir 'onDatosActualizados'
  const [casos, setCasos] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  const [casoParaAsignar, setCasoParaAsignar] = useState(null);

  useEffect(() => {
    const fetchCasos = async () => {
      setIsLoading(true);
      setError(null);
      try {
        const response = await api.get('/casos');
        setCasos(response.data);
      } catch (err) {
        console.error('Error al obtener los casos:', err);
        setError('No se pudieron cargar los casos.');
      } finally {
        setIsLoading(false);
      }
    };
    fetchCasos();
  }, []); // 2. Array vacío, el 'key' en Dashboard refresca

  // 3. Esta función ahora llama a la prop correcta
  const handleCasoAsignado = () => {
    if (onDatosActualizados) {
      onDatosActualizados(); // Llama a la función del Dashboard
    }
  };

  if (isLoading) { return <div>Cargando lista de casos...</div>; }
  if (error) { return <div style={{ color: 'red' }}>{error}</div>; }

  return (
    <div>
      <h3>Lista de Casos</h3>
      <table style={tableStyle}>
        <thead>
          <tr>
            <th style={thStyle}>ID</th>
            <th style={thStyle}>Cliente</th>
            <th style={thStyle}>Dirección</th>
            <th style={thStyle}>Estado</th>
            <th style={thStyle}>Técnico Asignado</th>
            <th style={thStyle}>Acciones</th>
          </tr>
        </thead>
        <tbody>
          {casos.length === 0 ? (
            <tr><td colSpan="6" style={tdStyle}>No hay casos para mostrar.</td></tr>
          ) : (
            casos.map(caso => (
              <tr key={caso.id}>
                <td style={tdStyle}>{caso.id}</td>
                <td style={tdStyle}>{caso.cliente_nombre}</td>
                <td style={tdStyle}>{caso.cliente_direccion}</td>
                <td style={tdStyle}>{caso.status}</td>
                <td style={tdStyle}>{caso.tecnico?.nombre || 'Sin asignar'}</td>
                <td style={tdStyle}>
                  <button>Ver</button>
                  <button 
                    onClick={() => setCasoParaAsignar(caso)}
                    disabled={caso.status === 'completado'}
                  >
                    Asignar
                  </button>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>

      {casoParaAsignar && (
        <AsignarCasoModal
          caso={casoParaAsignar}
          onClose={() => setCasoParaAsignar(null)}
          onCasoAsignado={handleCasoAsignado} // 4. Pasar la función
        />
      )}
    </div>
  );
}

export default CasosList;
