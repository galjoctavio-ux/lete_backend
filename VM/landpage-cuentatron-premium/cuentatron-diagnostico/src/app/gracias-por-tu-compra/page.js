// src/app/gracias-por-tu-compra/page.js

'use client'; 

import Link from 'next/link';
import { InlineWidget } from 'react-calendly';
import FormularioDiagnostico from '@/components/FormularioDiagnostico';
import { useState, useEffect, useCallback } from 'react'; 

export default function GraciasPage() {
  const calendlyUrl = "https://calendly.com/tesivil/instalacion-monitoreo-especial-cuentatron-1";

  // --- ESTA ES LA ÚNICA FUNCIÓN QUE IMPORTA AHORA ---
  // (Hemos quitado toda la lógica de 'enviarCorreoDeConfirmacion' por ahora)
  useEffect(() => {

    const handleCalendlyEvent = (e) => {
      // Verificamos que el mensaje venga de Calendly
      if (e.origin === "https://calendly.com") {

        // Verificamos que sea el evento que nos interesa
        if (e.data.event === "calendly.event_scheduled") {

          // --- ¡EL CAMBIO MÁS IMPORTANTE! ---
          // En lugar de intentar procesar, solo mostramos el dato crudo
          console.log("--- ¡PAYLOAD DE CALENDLY RECIBIDO! ---");
          console.log("El objeto 'e.data.payload' contiene:");
          // Usamos JSON.stringify para ver la estructura exacta
          console.log(JSON.stringify(e.data.payload, null, 2));
          console.log("---------------------------------------");
        }
      }
    };

    // Añadimos el listener al 'window'
    window.addEventListener("message", handleCalendlyEvent);

    // Limpiamos el listener cuando el componente se desmonte
    return () => {
      window.removeEventListener("message", handleCalendlyEvent);
    };
  }, []); // Array de dependencias vacío, solo se ejecuta una vez.


  // --- Renderizado de la Página (Sin cambios) ---
  return (
    <>
      <main className="flex flex-col items-center justify-center min-h-screen bg-gray-50 py-12 px-6">
        <div className="max-w-4xl w-full mx-auto bg-white p-6 md:p-10 rounded-lg shadow-xl">

          <h1 className="text-3xl md:text-4xl font-bold text-gris-grafito text-center">
            ¡Pago Exitoso! Faltan 2 pasos para tu diagnóstico.
          </h1>

          {/* --- SECCIÓN 1: Agendamiento --- */}
          <div className="mt-10">
            <h2 className="text-2xl font-bold text-azul-confianza">
              Paso 1: Agenda tu Cita de Instalación
            </h2>
            <p className="mt-2 text-gray-600">
              Selecciona el día y la hora que mejor te convenga. Nuestro calendario muestra la disponibilidad real de nuestros ingenieros.
            </p>
            <div className="mt-6 border border-gray-200 rounded-lg overflow-hidden">
              <div className="min-h-[1000px]">
                <InlineWidget
                  url={calendlyUrl}
                  styles={{ height: '1000px', width: '100%' }}
                  pageSettings={{
                    backgroundColor: 'ffffff',
                    primaryColor: '007aff',
                    textColor: '333333',
                    hideLandingPageDetails: true,
                    hideGdprBanner: true,
                  }}
                />
              </div>
            </div>
          </div>

          {/* --- SECCIÓN 2: Formulario --- */}
          <div className="mt-16">
            <h2 className="text-2xl font-bold text-azul-confianza">
              Paso 2: Completa tu Perfil Energético
            </h2>
            <p className="mt-2 text-gray-600">
              Ayúdanos a preparar tu diagnóstico. Esta información es vital para que el ingeniero sepa qué buscar.
            </p>
            <div className="mt-6">
              <FormularioDiagnostico />
            </div>
          </div>
        </div>
      </main>

      {/* Footer Sencillo */}
      <footer className="w-full bg-gris-grafito text-gray-400 py-8 px-6">
        <div className="max-w-5xl mx-auto text-center">
          <p className="text-sm">
            © 2025 Cuentatrón - Un servicio de TESIVIL.
          </p>
        </div>
      </footer>
    </>
  );
}