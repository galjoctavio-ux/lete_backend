// src/app/api/perfil-diagnostico/route.js

import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

// Inicializamos el cliente de Supabase usando las variables de entorno
// Usamos la 'service_role' key para tener permisos de escritura
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Esta es la función POST que se activará cuando el formulario llame a /api/perfil-diagnostico
export async function POST(request) {
  try {
    // 1. Obtenemos los datos del formulario que vienen en el 'body' del request
    const formData = await request.json();

    // 2. Validamos o limpiamos datos si es necesario (ejemplo)
    // (Aunque la mayoría de la validación ya la hicimos en el frontend)
    if (!formData.calle || !formData.telefono_whatsapp) {
      return NextResponse.json({ error: 'Faltan datos requeridos.' }, { status: 400 });
    }

    // 3. Insertamos los datos en la tabla 'perfiles_diagnostico'
    const { data, error } = await supabase
      .from('perfiles_diagnostico')
      .insert([
        // Mapeamos los campos del formulario (formData) a las columnas de la BD
        {
          calle: formData.calle,
          numero_domicilio: formData.numero_domicilio,
          colonia: formData.colonia,
          municipio: formData.municipio,
          telefono_whatsapp: formData.telefono_whatsapp,

          refri_cantidad: formData.refri_cantidad,
          refri_antiguedad_anos: formData.refri_antiguedad_anos,
          ac_cantidad: formData.ac_cantidad,
          ac_tipo: formData.ac_tipo,
          lavadora_cantidad: formData.lavadora_cantidad,
          secadora_electrica_cantidad: formData.secadora_electrica_cantidad,
          secadora_gas_cantidad: formData.secadora_gas_cantidad,
          estufa_electrica_cantidad: formData.estufa_electrica_cantidad,
          calentador_electrico_cantidad: formData.calentador_electrico_cantidad,
          bomba_agua_cantidad: formData.bomba_agua_cantidad,
          bomba_alberca_cantidad: formData.bomba_alberca_cantidad,
          paneles_solares_cantidad: formData.paneles_solares_cantidad,
          horno_electrico_cantidad: formData.horno_electrico_cantidad,

          contexto_problema: formData.contexto_problema,
          confirmo_no_conectar_raros: formData.confirmo_no_conectar_raros,
        }
      ])
      .select(); // .select() hace que nos regrese el dato insertado

    // 4. Manejamos errores de Supabase
    if (error) {
      console.error('Error de Supabase:', error.message);
      return NextResponse.json({ error: 'Error al guardar en la base de datos.', details: error.message }, { status: 500 });
    }

    // 5. Si todo salió bien, regresamos el éxito
    return NextResponse.json({ success: true, data: data }, { status: 201 }); // 201 = Created

  } catch (err) {
    // Capturamos errores inesperados (ej. si el JSON está malformado)
    console.error('Error interno del servidor:', err);
    return NextResponse.json({ error: 'Error interno del servidor.' }, { status: 500 });
  }
}