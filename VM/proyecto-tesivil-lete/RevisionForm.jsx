import React, { useState, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import api from '../apiService';
import SignatureCanvas from 'react-signature-canvas';

// (Estilos)
const formContainerStyle = { padding: '20px', background: '#fff', margin: '20px', borderRadius: '8px' };
const inputGroupStyle = { marginBottom: '15px', display: 'flex', flexDirection: 'column' };
const labelStyle = { fontWeight: 'bold', marginBottom: '5px' };
const tabContainerStyle = { display: 'flex', gap: '5px', borderBottom: '1px solid #ccc', marginBottom: '20px', flexWrap: 'wrap' };
const tabStyle = { padding: '10px', cursor: 'pointer', border: '1px solid #ccc', borderBottom: 'none', background: '#f0f0f0' };
const activeTabStyle = { ...tabStyle, background: '#fff', borderBottom: '1px solid #fff', marginTop: '-1px' };
const equipoBoxStyle = { border: '1px solid #ccc', padding: '10px', marginTop: '10px', borderRadius: '5px', display: 'flex', flexWrap: 'wrap', gap: '10px' };
const sigCanvasStyle = { border: '1px solid black', width: '100%', minHeight: '150px', borderRadius: '5px' };

function RevisionForm() {
  const { casoId } = useParams();
  const navigate = useNavigate();
  const [currentStep, setCurrentStep] = useState(1);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);
  const sigPadRef = useRef(null); // Ref para el lienzo

  const [formData, setFormData] = useState({
    caso_id: parseInt(casoId),
    cliente_email: '',
    tipo_servicio: 'Monofásico',
    tipo_medidor: 'Digital',
    giro_medidor: 'Regular',
    sello_cfe: true,
    condicion_base_medidor: 'Bueno',
    edad_instalacion: '0-10 años',
    cantidad_circuitos: 1,
    condiciones_cc: 'Bueno',
    observaciones_cc: '',
    tornillos_flojos: false,
    capacidad_vs_calibre: true,
    voltaje_medido: 127.0,
    corriente_red_f1: 0,
    corriente_red_f2: 0,
    corriente_red_f3: 0,
    corriente_red_n: 0,
    corriente_paneles_f1: 0,
    corriente_paneles_f2: 0,
    corriente_paneles_f3: 0,
    cantidad_paneles: 0,
    watts_por_panel: 0,
    paneles_antiguedad_anos: 0,
    se_puede_apagar_todo: false,
    corriente_fuga_f1: 0,
    corriente_fuga_f2: 0,
    corriente_fuga_f3: 0,
    equiposData: [],
    causas_alto_consumo: [],
    recomendaciones_tecnico: '',
  });

  const handleChange = (e) => {
    const { name, value, type } = e.target;
    let val;
    if (type === 'checkbox') {
      val = e.target.checked;
    } else if (['sello_cfe', 'tornillos_flojos', 'capacidad_vs_calibre', 'se_puede_apagar_todo'].includes(name)) {
      val = (value === 'true');
    } else if (type === 'number') {
      val = parseFloat(value) || 0;
    } else {
      val = value;
    }
    setFormData(prev => ({ ...prev, [name]: val }));
  };

  const handleAddEquipo = () => {
    setFormData(prev => ({ ...prev, equiposData: [ ...prev.equiposData, { id: Date.now(), nombre_equipo: 'Refrigerador', nombre_personalizado: '', amperaje_medido: 1.0, tiempo_uso: 1, unidad_tiempo: 'Horas/Día', estado_equipo: 'Bueno' } ] }));
  };
  const handleEquipoChange = (id, e) => {
    const { name, value, type } = e.target;
    const val = (type === 'number') ? (parseFloat(value) || 0) : value;
    setFormData(prev => ({ ...prev, equiposData: prev.equiposData.map(eq => eq.id === id ? { ...eq, [name]: val } : eq) }));
  };
  const handleRemoveEquipo = (id) => {
    setFormData(prev => ({ ...prev, equiposData: prev.equiposData.filter(eq => eq.id !== id) }));
  };

  const clearSignature = () => {
    sigPadRef.current.clear();
  };

  const handleSubmit = async () => {
    setIsSubmitting(true);
    setSubmitError(null);

    if (!formData.cliente_email) {
      alert('Error: El Correo del Cliente en el Paso 1 es obligatorio.');
      setCurrentStep(1);
      setIsSubmitting(false);
      return;
    }

    const firmaData = sigPadRef.current.isEmpty()
      ? "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg=="
      : sigPadRef.current.toDataURL('image/png');

    const { equiposData, ...revisionData } = formData;
    const payload = { revisionData, equiposData, firmaBase64: firmaData };

    console.log("Enviando payload con firma real...");

    try {
      const response = await api.post('/revisiones', payload);
      console.log('Respuesta de la API:', response.data);
      alert(`¡Revisión ${response.data.revision_id} enviada exitosamente!`);
      navigate('/casos');
    } catch (err) {
      console.error('Error al enviar la revisión:', err);
      setSubmitError('Error al enviar la revisión. Revisa la consola (F12).');
      setIsSubmitting(false);
    }
  };

  const esBifasico = formData.tipo_servicio === '2F+Neutro';
  const esTrifasico = formData.tipo_servicio === 'Trifásico';
  const tienePaneles = formData.tipo_servicio.includes('Paneles');

  return (
    <div style={{ padding: '20px' }}>
      <h2>Iniciando Revisión para el Caso #{casoId}</h2>

      <div style={tabContainerStyle}>
        <div style={currentStep === 1 ? activeTabStyle : tabStyle} onClick={() => setCurrentStep(1)}>Paso 1: Generales</div>
        <div style={currentStep === 2 ? activeTabStyle : tabStyle} onClick={() => setCurrentStep(2)}>Paso 2: Medidor y C.C.</div>
        <div style={currentStep === 3 ? activeTabStyle : tabStyle} onClick={() => setCurrentStep(3)}>Paso 3: Mediciones</div>
        <div style={currentStep === 4 ? activeTabStyle : tabStyle} onClick={() => setCurrentStep(4)}>Paso 4: Fugas</div>
        <div style={currentStep === 5 ? activeTabStyle : tabStyle} onClick={() => setCurrentStep(5)}>Paso 5: Equipos</div>
        <div style={currentStep === 6 ? activeTabStyle : tabStyle} onClick={() => setCurrentStep(6)}>Paso 6: Cierre</div>
      </div>

      <div style={formContainerStyle}>

        {currentStep === 1 && (
          <div>
            <h3>Paso 1: Datos Generales</h3>
            <div style={inputGroupStyle}>
              <label style={labelStyle} htmlFor="cliente_email">Correo del Cliente (Obligatorio)</label>
              <input type="email" name="cliente_email" id="cliente_email" value={formData.cliente_email} onChange={handleChange} required />
            </div>
          </div>
        )}
{currentStep === 2 && (
          <div>
            <h3>Paso 2: Medidor y Centro de Carga</h3>
            <div style={inputGroupStyle}>
              <label style={labelStyle}>Tipo de Servicio</label>
              <select name="tipo_servicio" value={formData.tipo_servicio} onChange={handleChange}>
                <option>Monofásico</option><option>2F+Neutro</option><option>2F+N con Paneles</option><option>Trifásico</option><option>Trifásico con Paneles</option>
              </select>
            </div>
            <div style={inputGroupStyle}>
              <label style={labelStyle}>Cuenta con Sello CFE</label>
              <select name="sello_cfe" value={formData.sello_cfe.toString()} onChange={handleChange}>
                <option value="true">Sí</option><option value="false">No</option>
              </select>
            </div>
            {formData.sello_cfe === false && (
              <div style={{...inputGroupStyle, background: '#fff8e1', padding: '10px'}}>
                <label style={labelStyle}>Condición Base Medidor (Si NO hay sello)</label>
                <select name="condicion_base_medidor" value={formData.condicion_base_medidor} onChange={handleChange}>
                  <option>Bueno</option><option>Regular</option><option>Malo</option>
                </select>
              </div>
            )}
            <div style={inputGroupStyle}>
              <label style={labelStyle}>Tornillos Flojos</label>
              <select name="tornillos_flojos" value={formData.tornillos_flojos.toString()} onChange={handleChange}>
                <option value="false">No</option><option value="true">Sí</option>
              </select>
            </div>
            {formData.tornillos_flojos === true && (<p style={{ color: 'red', fontWeight: 'bold' }}>¡Atención! Aprieta los tornillos...</p>)}
            <div style={inputGroupStyle}>
              <label style={labelStyle}>Capacidad Interruptor vs Calibre</label>
              <select name="capacidad_vs_calibre" value={formData.capacidad_vs_calibre.toString()} onChange={handleChange}>
                <option value="true">Sí (Correcto)</option><option value="false">No (Incorrecto)</option>
              </select>
            </div>
            {formData.capacidad_vs_calibre === false && (<p style={{ color: 'red', fontWeight: 'bold' }}>¡PELIGRO! Riesgo de Incendio...</p>)}
            <div style={inputGroupStyle}>
              <label style={labelStyle} htmlFor="observaciones_cc">Observaciones C.C.</label>
              <textarea name="observaciones_cc" id="observaciones_cc" value={formData.observaciones_cc} onChange={handleChange} />
            </div>
          </div>
        )}

        {currentStep === 3 && (
          <div>
            <h3>Paso 3: Mediciones (UI Dinámica)</h3>
            <div style={{...inputGroupStyle, background: '#e3f2fd', padding: '10px'}}>
              <label style={labelStyle} htmlFor="voltaje_medido">Voltaje (Fase-Neutro)</label>
              <input type="number" name="voltaje_medido" id="voltaje_medido" value={formData.voltaje_medido} onChange={handleChange} step="0.1" />
            </div>
            <h4>Corriente de Red (Amperes)</h4>
            <div style={inputGroupStyle}>
              <label style={labelStyle} htmlFor="corriente_red_f1">Corriente Red F1</label>
              <input type="number" name="corriente_red_f1" id="corriente_red_f1" value={formData.corriente_red_f1} onChange={handleChange} step="0.1" />
            </div>
            {(esBifasico || esTrifasico || tienePaneles) && (
              <div style={inputGroupStyle}>
                <label style={labelStyle} htmlFor="corriente_red_f2">Corriente Red F2</label>
                <input type="number" name="corriente_red_f2" id="corriente_red_f2" value={formData.corriente_red_f2} onChange={handleChange} step="0.1" />
              </div>
            )}
            {(esTrifasico || tienePaneles) && (
              <div style={inputGroupStyle}>
                <label style={labelStyle} htmlFor="corriente_red_f3">Corriente Red F3</label>
                <input type="number" name="corriente_red_f3" id="corriente_red_f3" value={formData.corriente_red_f3} onChange={handleChange} step="0.1" />
              </div>
            )}
            <div style={inputGroupStyle}>
              <label style={labelStyle} htmlFor="corriente_red_n">Corriente Red Neutro</label>
              <input type="number" name="corriente_red_n" id="corriente_red_n" value={formData.corriente_red_n} onChange={handleChange} step="0.1" />
            </div>
            {tienePaneles && (
              <div style={{background: '#e8f5e9', padding: '10px', marginTop: '15px'}}>
                <h4>Mediciones de Paneles Solares</h4>
                <div style={inputGroupStyle}>
                  <label style={labelStyle} htmlFor="corriente_paneles_f1">Corriente Paneles F1</label>
                  <input type="number" name="corriente_paneles_f1" id="corriente_paneles_f1" value={formData.corriente_paneles_f1} onChange={handleChange} step="0.1" />
                </div>
                <div style={inputGroupStyle}>
                  <label style={labelStyle} htmlFor="cantidad_paneles">Cantidad de Paneles</label>
                  <input type="number" name="cantidad_paneles" id="cantidad_paneles" value={formData.cantidad_paneles} onChange={handleChange} step="1" />
                </div>
                <div style={inputGroupStyle}>
                  <label style={labelStyle} htmlFor="watts_por_panel">Watts por Panel</label>
                  <input type="number" name="watts_por_panel" id="watts_por_panel" value={formData.watts_por_panel} onChange={handleChange} step="1" />
                </div>
                <div style={inputGroupStyle}>
                  <label style={labelStyle} htmlFor="paneles_antiguedad_anos">Años de Antigüedad de Paneles</label>
                  <input type="number" name="paneles_antiguedad_anos" id="paneles_antiguedad_anos" value={formData.paneles_antiguedad_anos} onChange={handleChange} step="1" />
                </div>
              </div>
            )}
          </div>
        )}

        {currentStep === 4 && (
          <div>
            <h3>Paso 4: Prueba de Fuga</h3>
            <div style={inputGroupStyle}>
              <label style={labelStyle}>¿Se puede apagar todo?</label>
              <select name="se_puede_apagar_todo" value={formData.se_puede_apagar_todo.toString()} onChange={handleChange}>
                <option value="false">No</option><option value="true">Sí</option>
              </select>
            </div>
            {formData.se_puede_apagar_todo === true && (
              <div style={{...inputGroupStyle, background: '#fff8e1', padding: '10px'}}>
                <h4>Medición de Fuga Directa</h4>
                <p>Con todo apagado, mide la corriente de fuga en cada fase.</p>
                <div style={inputGroupStyle}>
                  <label style={labelStyle} htmlFor="corriente_fuga_f1">Corriente Fuga F1 (Amperes)</label>
                  <input type="number" name="corriente_fuga_f1" id="corriente_fuga_f1" value={formData.corriente_fuga_f1} onChange={handleChange} step="0.01" />
                </div>
                {(esBifasico || esTrifasico || tienePaneles) && (
                   <div style={inputGroupStyle}>
                    <label style={labelStyle} htmlFor="corriente_fuga_f2">Corriente Fuga F2 (Amperes)</label>
                    <input type="number" name="corriente_fuga_f2" id="corriente_fuga_f2" value={formData.corriente_fuga_f2} onChange={handleChange} step="0.01" />
                  </div>
                )}
                {(esTrifasico || tienePaneles) && (
                   <div style={inputGroupStyle}>
                    <label style={labelStyle} htmlFor="corriente_fuga_f3">Corriente Fuga F3 (Amperes)</label>
                    <input type="number" name="corriente_fuga_f3" id="corriente_fuga_f3" value={formData.corriente_fuga_f3} onChange={handleChange} step="0.01" />
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {currentStep === 5 && (
          <div>
            <h3>Paso 5: Electrodomésticos</h3>
            <button type="button" onClick={handleAddEquipo} style={{marginBottom: '10px'}}>+ Agregar Equipo</button>
            {formData.equiposData.map((equipo) => (
              <div key={equipo.id} style={equipoBoxStyle}>
                <select name="nombre_equipo" value={equipo.nombre_equipo} onChange={(e) => handleEquipoChange(equipo.id, e)}>
                  <option>Refrigerador</option><option>Lavadora</option><option>Aire Acondicionado</option><option>Bomba</option><option>TV</option><option>Ventilador</option><option>Otro</option>
                </select>
                <input type="text" name="nombre_personalizado" placeholder="Ubicación (Ej: Sala)" value={equipo.nombre_personalizado} onChange={(e) => handleEquipoChange(equipo.id, e)} />
                <div><label>Amps:</label><input type="number" name="amperaje_medido" value={equipo.amperaje_medido} onChange={(e) => handleEquipoChange(equipo.id, e)} step="0.1" style={{width: '60px'}} /></div>
                <div><label>T. Uso:</label><input type="number" name="tiempo_uso" value={equipo.tiempo_uso} onChange={(e) => handleEquipoChange(equipo.id, e)} style={{width: '60px'}} /></div>
                <select name="unidad_tiempo" value={equipo.unidad_tiempo} onChange={(e) => handleEquipoChange(equipo.id, e)}>
                  <option>Horas/Día</option><option>Horas/Semana</option>
                </select>
                <select name="estado_equipo" value={equipo.estado_equipo} onChange={(e) => handleEquipoChange(equipo.id, e)}>
                  <option>Bueno</option><option>Regular</option><option>Malo</option>
                </select>
                <button type="button" onClick={() => handleRemoveEquipo(equipo.id)} style={{color: 'red', background: 'transparent', border: 'none', cursor: 'pointer'}}>✖</button>
              </div>
            ))}
          </div>
        )}

{currentStep === 6 && (
          <div>
            <h3>Paso 6: Cierre y Firma</h3>
            <div style={inputGroupStyle}>
              <label style={labelStyle} htmlFor="recomendaciones_tecnico">Recomendaciones Clave</label>
              <textarea name="recomendaciones_tecnico" id="recomendaciones_tecnico" value={formData.recomendaciones_tecnico} onChange={handleChange} rows="4" />
            </div>
            <div style={inputGroupStyle}>
              <label style={labelStyle}>Firma del Cliente:</label>
              <SignatureCanvas
                ref={sigPadRef}
                penColor='black'
                canvasProps={{style: sigCanvasStyle}}
              />
              <button type="button" onClick={clearSignature} style={{marginTop: '5px', width: '100px', alignSelf: 'flex-start'}}>
                Limpiar
              </button>
            </div>
            {submitError && <p style={{ color: 'red' }}>{submitError}</p>}
            <button 
              onClick={handleSubmit} 
              style={{ marginTop: '20px', background: 'green', color: 'white', padding: '15px', fontSize: '1.2em', width: '100%' }}
              disabled={isSubmitting}
            >
              {isSubmitting ? 'Enviando...' : 'Generar y Enviar Reporte'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default RevisionForm;
