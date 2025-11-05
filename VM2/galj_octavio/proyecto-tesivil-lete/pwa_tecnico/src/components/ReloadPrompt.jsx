import React from 'react';
// ¡AQUÍ ESTÁ LA CORRECCIÓN!
// Importamos directamente desde el módulo virtual de vite-plugin-pwa
import { useRegisterSW } from 'virtual:pwa-register/react';

// (Estilos - sin cambios)
const promptStyle = {
  position: 'fixed',
  bottom: '20px',
  right: '20px',
  padding: '12px',
  border: '1px solid #888',
  borderRadius: '5px',
  backgroundColor: '#fff',
  boxShadow: '0 4px 8px rgba(0,0,0,0.1)',
  zIndex: 2000,
};
const buttonStyle = {
  marginLeft: '10px',
  border: '1px solid #333',
  padding: '5px 10px',
  cursor: 'pointer',
};

function ReloadPrompt() {
  const {
    offlineReady: [offlineReady, setOfflineReady],
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegistered(r) {
      console.log('Service Worker registrado:', r);
    },
    onRegisterError(error) {
      console.log('Error al registrar Service Worker:', error);
    },
  });

  const close = () => {
    setOfflineReady(false);
    setNeedRefresh(false);
  };

  if (needRefresh) {
    return (
      <div style={promptStyle}>
        <span>¡Nueva versión disponible!</span>
        <button style={buttonStyle} onClick={() => updateServiceWorker(true)}>
          Recargar
        </button>
        <button style={buttonStyle} onClick={() => close()}>
          Cerrar
        </button>
      </div>
    );
  }

  if (offlineReady) {
    return (
      <div style={promptStyle}>
        <span>¡Aplicación lista para usarse sin conexión!</span>
        <button style={buttonStyle} onClick={() => close()}>
          OK
        </button>
      </div>
    );
  }

  return null;
}

export default ReloadPrompt;

