/* =========================================================
 * SECCIÓN 4.A: CÁLCULO DE CONSUMO (Ya implementada)
 * ========================================================= */

const getMultiplicador = (nombre_equipo, estado_equipo) => {
  let multiplicador = 1.0;
  const equiposSensibles = ['Refrigerador', 'Aire Acondicionado'];

  if (equiposSensibles.includes(nombre_equipo)) {
    if (estado_equipo === 'Regular') multiplicador = 1.25;
    else if (estado_equipo === 'Malo') multiplicador = 1.50;
  }
  return multiplicador;
};

const normalizarHorasBimestre = (tiempo_uso, unidad_tiempo) => {
  if (unidad_tiempo === 'Horas/Día') return tiempo_uso * 60;
  if (unidad_tiempo === 'Horas/Semana') return (tiempo_uso / 7) * 60;
  return 0;
};

export const calcularConsumoEquipos = (equiposData, voltaje) => {
  if (!equiposData || equiposData.length === 0 || !voltaje) {
    return [];
  }

  return equiposData.map(equipo => {
    const { nombre_equipo, estado_equipo, tiempo_uso, unidad_tiempo, amperaje_medido } = equipo;

    const multiplicador = getMultiplicador(nombre_equipo, estado_equipo);
    const horas_bimestre = normalizarHorasBimestre(tiempo_uso, unidad_tiempo);

    const Potencia_W = voltaje * amperaje_medido;
    const Consumo_Base_kWh = (Potencia_W * horas_bimestre) / 1000;
    const kwh_bimestre_calculado = Consumo_Base_kWh * multiplicador;

    return {
      ...equipo,
      kwh_bimestre_calculado: parseFloat(kwh_bimestre_calculado.toFixed(2))
    };
  });
};

/* =========================================================
 * SECCIÓN 4.B: DETECCIÓN DE FUGAS (¡NUEVO!)
 * ========================================================= */

export const detectarFugas = (revisionData) => {
  const { 
    se_puede_apagar_todo, 
    corriente_fuga_f1, corriente_fuga_f2, corriente_fuga_f3,
    corriente_red_f1, corriente_red_f2, corriente_red_f3, corriente_red_n 
  } = revisionData;

  // Método 1: Prueba Directa
  if (se_puede_apagar_todo === true) {
    const fuga_total = (corriente_fuga_f1 || 0) + (corriente_fuga_f2 || 0) + (corriente_fuga_f3 || 0);
    if (fuga_total > 0.05) { // 50mA
      return `FUGA DETECTADA: Se midió una fuga directa de ${fuga_total.toFixed(2)}A.`;
    }
  }

  // Método 2: Prueba Diferencial (si no se pudo apagar todo)
  const corriente_entrante = (corriente_red_f1 || 0) + (corriente_red_f2 || 0) + (corriente_red_f3 || 0);
  const diferencia = Math.abs(corriente_entrante - (corriente_red_n || 0));

  if (diferencia > 0.15) { // 150mA
    return `POSIBLE FUGA: Se detectó un desbalance de ${diferencia.toFixed(2)}A entre fases y neutro.`;
  }

  return null; // Sin fuga detectada
};

/* =========================================================
 * SECCIÓN 4.C: VERIFICACIÓN SOLAR (¡NUEVO!)
 * ========================================================= */

export const verificarSolar = (revisionData) => {
  const { 
    tipo_servicio, paneles_antiguedad_anos, cantidad_paneles, watts_por_panel, 
    corriente_paneles_f1, corriente_paneles_f2, corriente_paneles_f3, voltaje_medido 
  } = revisionData;

  // Si no hay paneles, no hacer nada
  if (!tipo_servicio?.includes('Paneles') || !paneles_antiguedad_anos || !cantidad_paneles || !watts_por_panel) {
    return null;
  }

  const A = paneles_antiguedad_anos;
  let factor_degradacion = 0;
  if (A === 0) factor_degradacion = 1.0;
  else if (A === 1) factor_degradacion = 0.975;
  else if (A > 1) factor_degradacion = 0.975 - ((A - 1) * 0.005);

  const potencia_instalada_W = cantidad_paneles * watts_por_panel;
  const potencia_esperada_W = (potencia_instalada_W * factor_degradacion) * 0.75; // 0.75 = Factor de Rendimiento

  const corriente_paneles_total = (corriente_paneles_f1 || 0) + (corriente_paneles_f2 || 0) + (corriente_paneles_f3 || 0);
  const potencia_medida_W = corriente_paneles_total * voltaje_medido;

  const eficiencia_relativa = potencia_medida_W / potencia_esperada_W;

  if (eficiencia_relativa < 0.8) {
    return `RENDIMIENTO BAJO: Sus paneles generan ${potencia_medida_W.toFixed(0)}W, cuando se esperarían al menos ${potencia_esperada_W.toFixed(0)}W. Considere limpieza o mantenimiento.`;
  }

  return null; // Rendimiento OK
};

/* =========================================================
 * SECCIÓN 4.D: DIAGNÓSTICO AUTOMÁTICO (¡NUEVO!)
 * ========================================================= */

export const generarDiagnosticosAutomaticos = (revisionData, equiposCalculados, diagnosticoFuga, diagnosticoSolar) => {
  const { tipo_medidor, edad_instalacion, capacidad_vs_calibre } = revisionData;
  const diagnosticos = [];

  // Añadir diagnósticos de Fuga y Solar (si existen)
  if (diagnosticoFuga) diagnosticos.push(diagnosticoFuga);
  if (diagnosticoSolar) diagnosticos.push(diagnosticoSolar);

  // Notas de Instalación
  if (tipo_medidor === 'Digital') {
    diagnosticos.push("Nota: El medidor digital es más preciso, por lo que podría notar un cambio en su cobro si antes era analógico.");
  }
  if (edad_instalacion === '30+ años') {
    diagnosticos.push("Nota: Su instalación tiene más de 30 años y es considerada obsoleta según las normativas actuales. Se recomienda una modernización.");
  }
  if (capacidad_vs_calibre === false) { // Asumiendo que 'No' se guarda como 'false'
    diagnosticos.push("¡PELIGRO! Se detectó que el calibre de uno o más cables es insuficiente para la capacidad del interruptor, presentando un riesgo de sobrecalentamiento e incendio.");
  }

  // Notas de Equipos
  equiposCalculados.forEach(equipo => {
    if (equipo.estado_equipo === 'Malo') {
      const nombre = equipo.nombre_personalizado || equipo.nombre_equipo;
      diagnosticos.push(`Nota: El equipo ${nombre} se encuentra en mal estado y consume más energía.`);
    }
  });

  return diagnosticos; // Este es el array de strings
};
