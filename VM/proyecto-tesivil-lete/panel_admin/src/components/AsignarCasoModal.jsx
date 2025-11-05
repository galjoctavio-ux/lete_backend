import React, { useState, useEffect } from 'react';
import api from '../apiService';
import Modal from './Modal'; // Reutilizamos nuestro modal genérico

function AsignarCasoModal({ caso, onClose, onCasoAsignado }) {
  // 1. Estado para la lista de técnicos y la selección
  const [tecnicos, setTecnicos] = useState([]);
  const [selectedTecnicoId, setSelectedTecnicoId] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);

  // 2. useEffect para buscar la lista de técnicos tan pronto como se abre el modal
  useEffect(() => {
    const fetchTecnicos = async () => {
      setIsLoading(true);
      try {
        const response = await api.get('/usuarios/tecnicos');
        setTecnicos(response.data);
        setIsLoading(false);
      } catch (err) {
        setError('Error al cargar técnicos.');
        console.error(err);
        setIsLoading(false);
      }
    };

    fetchTecnicos();
  }, []); // Se ejecuta solo una vez cuando el modal se monta

  // 3. Manejador para guardar la asignación
  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!selectedTecnicoId) {
      setError('Por favor, selecciona un técnico.');
      return;
    }
    setError(null);

    try {
      // 4. Llamar a la API para actualizar el caso
      await api.put(`/casos/${caso.id}`, {
        tecnico_id: selectedTecnicoId,
      });

      onCasoAsignado(); // Refresca la lista en el dashboard
      onClose();          // Cierra el modal
    } catch (err) {
      setError('Error al asignar el caso.');
      console.error(err);
    }
  };

  return (
    // Usamos el componente Modal que ya teníamos
    <Modal isOpen={true} onClose={onClose}>
      <h3>Asignar Técnico al Caso #{caso.id}</h3>
      <p><strong>Cliente:</strong> {caso.cliente_nombre}</p>

      {isLoading && <p>Cargando técnicos...</p>}

      {error && <p style={{ color: 'red' }}>{error}</p>}

      {!isLoading && !error && (
        <form onSubmit={handleSubmit}>
          <div>
            <label>Selecciona un técnico:</label>
            <select 
              value={selectedTecnicoId} 
              onChange={(e) => setSelectedTecnicoId(e.target.value)}
              required
            >
              <option value="">-- Elige un técnico --</option>
              {tecnicos.map(tecnico => (
                <option key={tecnico.id} value={tecnico.id}>
                  {tecnico.nombre} ({tecnico.email})
                </option>
              ))}
            </select>
          </div>
          <button type="submit" style={{ marginTop: '10px' }}>Asignar</button>
        </form>
      )}
    </Modal>
  );
}

export default AsignarCasoModal;
