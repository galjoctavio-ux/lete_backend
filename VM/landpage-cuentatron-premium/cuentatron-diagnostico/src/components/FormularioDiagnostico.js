// src/components/FormularioDiagnostico.js
'use client';

import { useState } from 'react';
import ItemInventario from './ItemInventario';

export default function FormularioDiagnostico() {
  // Estado para manejar TODO el formulario
  const [formData, setFormData] = useState({
    // Domicilio
    calle: '',
    numero_domicilio: '',
    colonia: '',
    municipio: 'guadalajara', // Valor por defecto
    telefono_whatsapp: '',

    // Inventario (con valores por defecto del brief)
    refri_cantidad: 1,
    refri_antiguedad_anos: 5, // Un valor de ejemplo
    ac_cantidad: 0,
    ac_tipo: 'no_se',
    lavadora_cantidad: 1,
    secadora_electrica_cantidad: 0,
    secadora_gas_cantidad: 0,
    estufa_electrica_cantidad: 0,
    calentador_electrico_cantidad: 0,
    bomba_agua_cantidad: 0,
    bomba_alberca_cantidad: 0,
    paneles_solares_cantidad: 0,
    horno_electrico_cantidad: 0,

    // Contexto y Confirmación
    contexto_problema: '',
    confirmo_no_conectar_raros: false,
  });

  // Estados para la UI (Loading, Éxito, Error)
  const [isLoading, setIsLoading] = useState(false);
  const [formSuccess, setFormSuccess] = useState(false);
  const [formError, setFormError] = useState('');

  // --- Manejadores de Estado ---

  // Manejador genérico para inputs de texto, select, etc.
  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;
    setFormData((prevData) => ({
      ...prevData,
      [name]: type === 'checkbox' ? checked : value,
    }));
  };

  // Manejador genérico para los contadores [+] [-]
  const handleInventarioChange = (name, delta) => {
    setFormData((prevData) => ({
      ...prevData,
      [name]: Math.max(0, prevData[name] + delta), // Math.max previene valores negativos
    }));
  };

  // --- Manejador de Envío (Submit) ---
  const handleSubmit = async (e) => {
    e.preventDefault(); // Previene recarga de página
    setIsLoading(true);
    setFormError('');
    setFormSuccess(false);

    // Validación simple (el brief pide campos de domicilio requeridos)
    if (!formData.calle || !formData.numero_domicilio || !formData.colonia || !formData.telefono_whatsapp) {
      setFormError('Por favor, completa todos los campos de Domicilio.');
      setIsLoading(false);
      return;
    }

    if (!formData.confirmo_no_conectar_raros) {
      setFormError('Debes marcar la casilla de confirmación obligatoria.');
      setIsLoading(false);
      return;
    }

    // --- Llamada a nuestra API (Paso 11) ---
    try {
      // Usamos 'basePath' implícito de Next.js. 
      // La ruta se resuelve a: /cuentatron/diagnostico-personalizado/api/perfil-diagnostico
      const response = await fetch('/cuentatron/diagnostico-personalizado/api/perfil-diagnostico', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(formData),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Ocurrió un error en el servidor.');
      }

      // ¡Éxito!
      setFormSuccess(true);

    } catch (error) {
      console.error('Error al enviar formulario:', error);
      setFormError(`Error: ${error.message}`);
    } finally {
      setIsLoading(false);
    }
  };

  // --- Renderizado ---

  // Si el formulario fue exitoso, no mostramos nada más, solo un mensaje.
  if (formSuccess) {
    return (
      <div className="p-10 text-center bg-green-50 border border-green-300 rounded-lg">
        <h3 className="text-2xl font-bold text-green-800">¡Perfil guardado con éxito!</h3>
        <p className="mt-2 text-green-700">
          Gracias por completar tu perfil. El ingeniero usará esta información para tu diagnóstico.
        </p>
      </div>
    );
  }

  // Si no ha sido exitoso, mostramos el formulario
  return (
    <form onSubmit={handleSubmit} className="space-y-8 p-4 md:p-8 border border-gray-200 rounded-lg bg-gray-50">

      {/* --- Campos de Domicilio (Requeridos) --- */}
      <fieldset className="space-y-4">
        <legend className="text-xl font-semibold text-gris-grafito pb-2 border-b border-gray-300 w-full">Datos de Domicilio</legend>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label htmlFor="calle" className="block text-sm font-medium text-gray-700">Calle</label>
            <input type="text" name="calle" id="calle" value={formData.calle} onChange={handleChange} required className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-azul-confianza focus:ring-azul-confianza" />
          </div>
          <div>
            <label htmlFor="numero_domicilio" className="block text-sm font-medium text-gray-700">Número (Ext/Int)</label>
            <input type="text" name="numero_domicilio" id="numero_domicilio" value={formData.numero_domicilio} onChange={handleChange} required className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-azul-confianza focus:ring-azul-confianza" />
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label htmlFor="colonia" className="block text-sm font-medium text-gray-700">Colonia</label>
            <input type="text" name="colonia" id="colonia" value={formData.colonia} onChange={handleChange} required className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-azul-confianza focus:ring-azul-confianza" />
          </div>
          <div>
            <label htmlFor="municipio" className="block text-sm font-medium text-gray-700">Municipio</label>
            <select name="municipio" id="municipio" value={formData.municipio} onChange={handleChange} className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-azul-confianza focus:ring-azul-confianza">
              <option value="guadalajara">Guadalajara</option>
              <option value="zapopan">Zapopan</option>
              <option value="tlaquepaque">Tlaquepaque</option>
              <option value="tonala">Tonalá</option>
              <option value="tlajomulco">Tlajomulco</option>
              <option value="otro">Otro</option>
            </select>
          </div>
          <div>
            <label htmlFor="telefono_whatsapp" className="block text-sm font-medium text-gray-700">Teléfono (WhatsApp)</label>
            <input type="tel" name="telefono_whatsapp" id="telefono_whatsapp" value={formData.telefono_whatsapp} onChange={handleChange} required className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-azul-confianza focus:ring-azul-confianza" />
          </div>
        </div>
      </fieldset>

      {/* --- Inventario Interactivo (Botones) --- */}
      <fieldset>
        <legend className="text-xl font-semibold text-gris-grafito pb-2 border-b border-gray-300 w-full">Inventario de Equipos</legend>

        {/* Refrigeradores (con campo extra) */}
        <div className="py-3 border-b border-gray-300">
          <ItemInventario
            label="Refrigeradores"
            value={formData.refri_cantidad}
            onIncrement={() => handleInventarioChange('refri_cantidad', 1)}
            onDecrement={() => handleInventarioChange('refri_cantidad', -1)}
          />
          {formData.refri_cantidad > 0 && (
            <div className="mt-2 pl-4">
              <label htmlFor="refri_antiguedad_anos" className="block text-sm font-medium text-gray-700">Antigüedad (Aprox. del más viejo)</label>
              <input type="number" name="refri_antiguedad_anos" id="refri_antiguedad_anos" value={formData.refri_antiguedad_anos} onChange={handleChange} className="mt-1 w-32 rounded-md border-gray-300 shadow-sm focus:border-azul-confianza focus:ring-azul-confianza" placeholder="Años" />
            </div>
          )}
        </div>

        {/* Aire Acondicionado (con campo extra) */}
        <div className="py-3 border-b border-gray-300">
          <ItemInventario
            label="Aire Acondicionado"
            value={formData.ac_cantidad}
            onIncrement={() => handleInventarioChange('ac_cantidad', 1)}
            onDecrement={() => handleInventarioChange('ac_cantidad', -1)}
          />
          {formData.ac_cantidad > 0 && (
            <div className="mt-2 pl-4 space-y-1">
              <span className="block text-sm font-medium text-gray-700">Tipo (del principal):</span>
              <div className="flex gap-4">
                <label><input type="radio" name="ac_tipo" value="estandar" checked={formData.ac_tipo === 'estandar'} onChange={handleChange} /> Estándar</label>
                <label><input type="radio" name="ac_tipo" value="inverter" checked={formData.ac_tipo === 'inverter'} onChange={handleChange} /> Inverter</label>
                <label><input type="radio" name="ac_tipo" value="no_se" checked={formData.ac_tipo === 'no_se'} onChange={handleChange} /> No sé</label>
              </div>
            </div>
          )}
        </div>

        {/* --- Resto del inventario (simple) --- */}
        <ItemInventario label="Lavadora" value={formData.lavadora_cantidad} onIncrement={() => handleInventarioChange('lavadora_cantidad', 1)} onDecrement={() => handleInventarioChange('lavadora_cantidad', -1)} />
        <ItemInventario label="Secadora Eléctrica" value={formData.secadora_electrica_cantidad} onIncrement={() => handleInventarioChange('secadora_electrica_cantidad', 1)} onDecrement={() => handleInventarioChange('secadora_electrica_cantidad', -1)} />
        <ItemInventario label="Secadora de Gas" value={formData.secadora_gas_cantidad} onIncrement={() => handleInventarioChange('secadora_gas_cantidad', 1)} onDecrement={() => handleInventarioChange('secadora_gas_cantidad', -1)} />
        <ItemInventario label="Estufa Eléctrica / Parrilla" value={formData.estufa_electrica_cantidad} onIncrement={() => handleInventarioChange('estufa_electrica_cantidad', 1)} onDecrement={() => handleInventarioChange('estufa_electrica_cantidad', -1)} />
        <ItemInventario label="Calentador Eléctrico (Boiler/Ducha)" value={formData.calentador_electrico_cantidad} onIncrement={() => handleInventarioChange('calentador_electrico_cantidad', 1)} onDecrement={() => handleInventarioChange('calentador_electrico_cantidad', -1)} />
        <ItemInventario label="Bomba de Agua / Hidroneumático" value={formData.bomba_agua_cantidad} onIncrement={() => handleInventarioChange('bomba_agua_cantidad', 1)} onDecrement={() => handleInventarioChange('bomba_agua_cantidad', -1)} />
        <ItemInventario label="Bomba de Alberca" value={formData.bomba_alberca_cantidad} onIncrement={() => handleInventarioChange('bomba_alberca_cantidad', 1)} onDecrement={() => handleInventarioChange('bomba_alberca_cantidad', -1)} />
        <ItemInventario label="Paneles Solares" value={formData.paneles_solares_cantidad} onIncrement={() => handleInventarioChange('paneles_solares_cantidad', 1)} onDecrement={() => handleInventarioChange('paneles_solares_cantidad', -1)} />
        <ItemInventario label="Horno Eléctrico" value={formData.horno_electrico_cantidad} onIncrement={() => handleInventarioChange('horno_electrico_cantidad', 1)} onDecrement={() => handleInventarioChange('horno_electrico_cantidad', -1)} />
      </fieldset>

      {/* --- Contexto del Problema y Confirmación --- */}
      <fieldset className="space-y-4">
        <legend className="text-xl font-semibold text-gris-grafito pb-2 border-b border-gray-300 w-full">Contexto y Confirmación</legend>

        <div>
          <label htmlFor="contexto_problema" className="block text-sm font-medium text-gray-700">
            En pocas palabras, ¿cuál es tu problema o principal sospechoso? (Opcional)
          </label>
          <textarea
            name="contexto_problema"
            id="contexto_problema"
            rows="4"
            value={formData.contexto_problema}
            onChange={handleChange}
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-azul-confianza focus:ring-azul-confianza"
            placeholder="Ej: El recibo subió mucho, sospecho del aire acondicionado o de la bomba de agua."
          />
        </div>

        <div className="relative flex items-start">
          <div className="flex h-5 items-center">
            <input
              id="confirmo_no_conectar_raros"
              name="confirmo_no_conectar_raros"
              type="checkbox"
              checked={formData.confirmo_no_conectar_raros}
              onChange={handleChange}
              required
              className="h-4 w-4 rounded border-gray-300 text-azul-confianza focus:ring-azul-confianza"
            />
          </div>
          <div className="ml-3 text-sm">
            <label htmlFor="confirmo_no_conectar_raros" className="font-medium text-gray-700">
              Confirmación Obligatoria (Requerido)
            </label>
            <p className="text-gray-500">
              Entiendo que para un diagnóstico preciso, NO debo conectar aparatos inusuales (soldadoras, etc.) durante los 7 días de monitoreo.
            </p>
          </div>
        </div>
      </fieldset>

      {/* --- Botón de Envío y Mensajes de Estado --- */}
      <div>
        {formError && (
          <div className="p-3 mb-4 bg-red-100 border border-red-300 text-red-800 rounded-md">
            {formError}
          </div>
        )}

        <button
          type="submit"
          disabled={isLoading}
          className="w-full flex justify-center py-3 px-4 border border-transparent rounded-md shadow-sm text-lg font-medium text-white bg-azul-confianza hover:bg-opacity-90 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-azul-confianza disabled:bg-gray-400"
        >
          {isLoading ? 'Guardando Perfil...' : 'Enviar Perfil Energético'}
        </button>
      </div>
    </form>
  );
}