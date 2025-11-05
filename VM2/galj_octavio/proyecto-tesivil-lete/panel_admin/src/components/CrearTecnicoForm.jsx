import React, { useState } from 'react';
import api from '../apiService';

const formStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: '10px',
};

function CrearTecnicoForm({ onClose, onTecnicoCreado }) {
  const [nombre, setNombre] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    try {
      // Llama al endpoint que crea técnicos
      await api.post('/usuarios', {
        nombre: nombre,
        email: email,
        password: password,
      });

      // ¡Éxito!
      onTecnicoCreado(); // Llama a la función para refrescar la lista
      onClose();          // Cierra el modal
    } catch (err) {
      if (err.response && err.response.status === 409) {
         setError('El email ya está en uso.');
      } else {
         setError('Error al crear el técnico.');
      }
      console.error(err);
    }
  };

  return (
    <form style={formStyle} onSubmit={handleSubmit}>
      <h3>Crear Nuevo Técnico</h3>
      <div>
        <label>Nombre del Técnico:</label>
        <input type="text" value={nombre} onChange={(e) => setNombre(e.target.value)} required />
      </div>
      <div>
        <label>Email:</label>
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
      </div>
      <div>
        <label>Contraseña Provisional:</label>
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
      </div>
      {error && <p style={{ color: 'red' }}>{error}</p>}
      <button type="submit">Guardar Técnico</button>
    </form>
  );
}

export default CrearTecnicoForm;

