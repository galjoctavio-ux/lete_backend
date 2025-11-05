import React, { useState, useEffect } from 'react';
import api from '../apiService';

// (Reutilizamos los mismos nombres de estilos)
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

function TecnicosList() {
  const [tecnicos, setTecnicos] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const fetchTecnicos = async () => {
      setIsLoading(true);
      setError(null);
      try {
        // Llama al endpoint de técnicos
        const response = await api.get('/usuarios/tecnicos');
        setTecnicos(response.data);
      } catch (err) {
        console.error('Error al obtener los técnicos:', err);
        setError('No se pudieron cargar los técnicos.');
      } finally {
        setIsLoading(false);
      }
    };
    fetchTecnicos();
  }, []); // Se ejecuta solo una vez al cargar

  if (isLoading) { return <div>Cargando lista de técnicos...</div>; }
  if (error) { return <div style={{ color: 'red' }}>{error}</div>; }

  return (
    <div style={{marginTop: '40px'}}>
      <h3>Gestión de Técnicos</h3>
      <table style={tableStyle}>
        <thead>
          <tr>
            <th style={thStyle}>ID</th>
            <th style={thStyle}>Nombre</th>
            <th style={thStyle}>Email</th>
            <th style={thStyle}>Acciones</th>
          </tr>
        </thead>
        <tbody>
          {tecnicos.length === 0 ? (
            <tr><td colSpan="4" style={tdStyle}>No hay técnicos registrados.</td></tr>
          ) : (
            tecnicos.map(tecnico => (
              <tr key={tecnico.id}>
                <td style={tdStyle}>{tecnico.id.substring(0, 8)}...</td>
                <td style={tdStyle}>{tecnico.nombre}</td>
                <td style={tdStyle}>{tecnico.email}</td>
                <td style={tdStyle}>
                  <button>Editar</button>
                  <button>Borrar</button>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

export default TecnicosList;
