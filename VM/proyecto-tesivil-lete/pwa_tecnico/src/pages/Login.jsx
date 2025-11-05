import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext';

// Estilos
const loginStyles = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  height: '100vh',
  gap: '10px',
  backgroundColor: '#f0f2f5'
};

const formStyles = {
  display: 'flex',
  flexDirection: 'column',
  padding: '20px',
  border: '1px solid #ccc',
  borderRadius: '8px',
  backgroundColor: '#fff',
  gap: '15px'
};

function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  
  // 1. Obtenemos la función 'login' del contexto
  const { login } = useAuth(); 

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    try {
      // 2. Solo llamamos a la función del contexto
      await login(email, password);
      // La redirección la maneja el contexto
      
    } catch (err) {
      // 3. Capturamos el error que nos lanza el contexto
      if (err.response && err.response.status === 401) {
        setError('Credenciales inválidas. Por favor, inténtelo de nuevo.');
      } else {
        // Muestra el error específico (ej. "Se requiere cuenta de Técnico")
        setError(err.message || 'Error de conexión. Inténtelo más tarde.');
      }
      console.error(err);
    }
  };

  return (
    <div style={loginStyles}>
      <h2>App de Técnico</h2>
      
      <form style={formStyles} onSubmit={handleSubmit}>
         <div>
          <label htmlFor="email">Email: </label>
          <input 
            type="email" 
            id="email" 
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required 
          />
        </div>
        <div>
          <label htmlFor="password">Contraseña: </label>
          <input 
            type="password" 
            id="password" 
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required 
          />
        </div>
        
        {error && <p style={{ color: 'red' }}>{error}</p>}
        
        <button type="submit">Entrar</button>
      </form>
    </div>
  );
}

export default Login;
