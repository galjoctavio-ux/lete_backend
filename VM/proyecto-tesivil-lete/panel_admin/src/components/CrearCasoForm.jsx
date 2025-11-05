import React, { useState } from 'react';
import api from '../apiService';

const formStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: '10px',
};

function CrearCasoForm({ onClose, onCasoCreado }) {
  const [nombre, setNombre] = useState('');
  const [direccion, setDireccion] = useState('');
  const [telefono, setTelefono] = useState('');
  const [comentarios, setComentarios] = useState('');
  const [error, setError] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    try {
      await api.post('/casos', {
        cliente_nombre: nombre,
        cliente_direccion: direccion,
        cliente_telefono: telefono,
        comentarios_iniciales: comentarios,
      });

      // ¡Éxito!
      onCasoCreado(); // Llama a la función para refrescar la lista
      onClose();      // Cierra el modal
    } catch (err) {
      setError('Error al crear el caso.');
      console.error(err);
    }
  };

  return (
    <form style={formStyle} onSubmit={handleSubmit}>
      <h3>Crear Nuevo Caso</h3>
      <div>
        <label>Nombre del Cliente:</label>
        <input type="text" value={nombre} onChange={(e) => setNombre(e.target.value)} required />
      </div>
      <div>
        <label>Dirección:</label>
        <input type="text" value={direccion} onChange={(e) => setDireccion(e.target.value)} required />
      </div>
      <div>
        <label>Teléfono:</label>
        <input type="text" value={telefono} onChange={(e) => setTelefono(e.target.value)} />
      </div>
      <div>
        <label>Comentarios Iniciales:</label>
        <textarea value={comentarios} onChange={(e) => setComentarios(e.target.value)} />
      </div>
      {error && <p style={{ color: 'red' }}>{error}</p>}
      <button type="submit">Guardar Caso</button>
    </form>
  );
}

export default CrearCasoForm;
