// Usamos 'use client' para el CTA (Paso 7 - UX (Botones)) aunque aún no lo implementemos,
// pero el video de fondo funciona mejor en un Client Component.
'use client'; 

import { useState } from 'react';
import Link from 'next/link';
import { Zap, Search, ShieldOff, BrainCircuit } from 'lucide-react';
import { CreditCard, CalendarDays, HardHat, Smartphone, FileText } from 'lucide-react';
import { CheckCircle } from 'lucide-react';
import { ShieldCheck, MessageSquare } from 'lucide-react';
import FaqItem from '@/components/FaqItem';
import Cookies from 'js-cookie';

export default function HomePage() {
  // Estado para el botón (Paso 7 - UX)
  const [isProcessing, setIsProcessing] = useState(false);

  // --- NUEVO: Estados para la Calculadora (Sección 5) ---
  const [recibo, setRecibo] = useState(''); // Almacena el valor del input
  const [perdida, setPerdida] = useState(0); // Almacena el cálculo (input * 0.25)

  const [plazasSemanales, setPlazasSemanales] = useState(4);

  const handleReciboChange = (e) => {
  const valor = e.target.value;
  // Validamos que solo sean números y no esté vacío
  if (valor === '' || /^[0-9\b]+$/.test(valor)) {
    setRecibo(valor);

    // Calculamos la pérdida (25% como dice el brief)
    const valorNumerico = parseFloat(valor) || 0;
    const calculoPerdida = (valorNumerico * 0.25).toFixed(2); // a 2 decimales
    setPerdida(calculoPerdida);
  }
  };

  // --- ¡FUNCIÓN ACTUALIZADA! ---
  const handleCtaClick = async (e) => {
    e.preventDefault(); // Prevenimos que el <Link href="#"> navegue
    setIsProcessing(true); // Mostramos "Procesando..."

    try {
      // 1. Llamamos a nuestra propia API
      const response = await fetch('/cuentatron/diagnostico-personalizado/api/checkout-session', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        // Enviamos el origin para que la API construya bien las URLs
        body: JSON.stringify({ origin: window.location.origin }), 
      });

      if (!response.ok) {
        // Si el backend falla (ej. clave de Stripe mal), mostramos un error
        throw new Error('Error al crear la sesión de pago.');
      }

      const { url, id } = await response.json();

      if (!url) {
        throw new Error('No se recibió la URL de pago.');
      }

      // 2. Guardamos el ID de la sesión en una cookie
      // Esto nos permitirá recuperar los datos del cliente en la página de /gracias
      Cookies.set('stripe_checkout_session_id', id, { expires: 1 }); // Expira en 1 día

      // 3. Redirigimos al usuario a la página de pago de Stripe
      window.location.href = url;

    } catch (error) {
      console.error('Error en el Clic del CTA:', error);
      alert('Error al procesar el pago. Intenta de nuevo.');
      setIsProcessing(false); // Reactivamos el botón si hay error
    }
    // No ponemos setIsProcessing(false) al final, porque la redirección debe ocurrir
  };

  return (
    <main className="flex flex-col items-center justify-center min-h-screen overflow-x-hidden">
      {/* --- Sección 1: Hero --- */}
      {/* Contenedor principal del Hero con altura de pantalla completa y relativo */}
      <section className="relative w-full h-screen flex items-center justify-center text-center text-white overflow-hidden">

        {/* Contenedor del Video de Fondo */}
        <div className="absolute top-0 left-0 w-full h-full z-0">
          {/* Overlay oscuro (como pide el brief) */}
          <div className="absolute top-0 left-0 w-full h-full bg-black opacity-60 z-10"></div>

          {/* Video de Fondo */}
          <video
            // Usamos basePath para la ruta correcta
            src="/cuentatron/diagnostico-personalizado/assets/video-loop-medidor.mp4"
            autoPlay
            muted
            loop
            playsInline // Clave para que funcione en iOS
            className="w-full h-full object-cover"
          >
            Tu navegador no soporta el video.
          </video>
        </div>

        {/* Contenido del Hero (Centrado y sobre el video) */}
        <div className="relative z-20 flex flex-col items-center px-6 max-w-3xl">
          {/* H1 (Inter Bold) */}
          <h1 className="text-4xl md:text-6xl font-bold leading-tight">
            ¿Tu recibo de luz es una pesadilla?
          </h1>

          {/* H2 (Inter Regular) */}
          <h2 className="mt-4 text-xl md:text-2xl font-light max-w-2xl">
            Identifica y elimina el "consumo fantasma". Te entregamos un diagnóstico de 7 días analizado por un Ingeniero.
          </h2>

          {/* Prueba Social (Inter Medium) */}
          <p className="mt-6 text-lg font-medium">
            ✅ +50 hogares en ZMG ya encontraron sus fugas de energía.
          </p>

          {/* CTA Principal (Pide Link directo a Stripe) */}
          <Link
            href="#" // Reemplazaremos esto con el link de Stripe
            onClick={handleCtaClick}
            className={`
              mt-8 px-8 py-4 rounded-lg
              bg-verde-ahorro text-gris-grafito 
              font-bold text-xl
              transition-transform duration-300 ease-in-out
              hover:scale-105 hover:shadow-lg
              ${isProcessing ? 'opacity-50 cursor-not-allowed' : ''}
            `}
            disabled={isProcessing}
          >
            {isProcessing ? 'Procesando...' : 'Quiero mi Diagnóstico esta Semana →'}
          </Link>

          {/* Aclaración (Inter Medium) */}
          <p className="mt-4 text-sm font-medium text-gray-300">
            ⚠️ Servicio premium exclusivo para la Zona Metropolitana de Guadalajara.
          </p>
        </div>
      </section>

      {/* --- Sección 2: Problema --- */}
<section className="w-full bg-white py-16 md:py-24 px-6">
  <div className="max-w-5xl mx-auto text-center">
    {/* Título */}
    <h2 className="text-3xl md:text-4xl font-bold text-gris-grafito">
      ¿Por qué es tan difícil encontrar al culpable?
    </h2>

    {/* Subtítulo */}
    <p className="mt-4 text-lg md:text-xl text-gray-600 max-w-3xl mx-auto">
      Los consumos "fantasma" se esconden. Una revisión de 1 hora no puede detectar...
    </p>

    {/* Contenedor de 3 Columnas */}
    <div className="mt-12 grid grid-cols-1 md:grid-cols-3 gap-8 text-left">

      {/* Columna 1: Problemas Intermitentes */}
      <div className="flex flex-col items-center md:items-start text-center md:text-left">
        <div className="flex-shrink-0">
          {/* Icono Azul Confianza */}
          <Zap className="h-10 w-10 text-azul-confianza" strokeWidth={2} />
        </div>
        <h3 className="mt-4 text-xl font-bold">Problemas Intermitentes</h3>
        <p className="mt-2 text-gray-600">
          Una bomba que falla solo de noche o un equipo que se activa erráticamente.
        </p>
      </div>

      {/* Columna 2: Culpables Invisibles */}
      <div className="flex flex-col items-center md:items-start text-center md:text-left">
        <div className="flex-shrink-0">
          {/* Icono Azul Confianza */}
          <ShieldOff className="h-10 w-10 text-azul-confianza" strokeWidth={2} />
        </div>
        <h3 className="mt-4 text-xl font-bold">Culpables Invisibles</h3>
        <p className="mt-2 text-gray-600">
          Fugas a tierra que no botan la pastilla o equipos defectuosos consumiendo en silencio.
        </p>
      </div>

      {/* Columna 3: Patrones Ocultos */}
      <div className="flex flex-col items-center md:items-start text-center md:text-left">
        <div className="flex-shrink-0">
          {/* Icono Azul Confianza */}
          <Search className="h-10 w-10 text-azul-confianza" strokeWidth={2} />
        </div>
        <h3 className="mt-4 text-xl font-bold">Patrones Ocultos</h3>
        <p className="mt-2 text-gray-600">
          El aire acondicionado en un ciclo anómalo o el refrigerador que nunca descansa.
        </p>
      </div>
    </div>
  </div>
</section>

{/* --- Sección 3: Solución --- */}
{/* Fondo gris claro para alternar secciones */}
<section className="w-full bg-gray-50 py-16 md:py-24 px-6">
  <div className="max-w-5xl mx-auto grid grid-cols-1 md:grid-cols-2 gap-12 items-center">

    {/* Columna de Texto */}
    <div>
      <h2 className="text-3xl md:text-4xl font-bold text-gris-grafito">
        El Monitoreo Especial de 7 Días
      </h2>
      <p className="mt-4 text-lg md:text-xl text-azul-confianza font-medium">
        (El Diferenciador)
      </p>
      <p className="mt-2 text-lg text-gray-700">
        Instalamos un dispositivo de grado ingeniería que vigila tu consumo 24/7. Después, <strong>un Ingeniero (no un robot)</strong> analiza los datos y te da la solución.
      </p>
      {/* Pequeño icono para reforzar la idea de "Ingeniero" */}
      <div className="mt-6 flex items-center text-azul-confianza">
        <BrainCircuit className="h-8 w-8 mr-3" />
        <span className="text-lg font-medium">Análisis 100% humano y profesional.</span>
      </div>
    </div>

    {/* Columna de Imagen */}
    <div>
      {/* El componente Image de Next.js optimiza la carga (WebP, etc.) */}
      {/* Recuerda que 'Image' debe importarse de 'next/image' */}
      <img
        // Usamos basePath para la ruta correcta
        src="/cuentatron/diagnostico-personalizado/assets/foto-ingeniero-analizando.jpg"
        alt="Ingeniero analizando datos de Cuentatrón"
        className="rounded-lg shadow-xl w-full h-auto object-cover"
        // No necesitas 'width' y 'height' si no usas 'next/image'
      />
    </div>
  </div>
</section>

{/* --- Sección 4: Prueba Real (Caso de Éxito) --- */}
<section className="w-full bg-white py-16 md:py-24 px-6">
  <div className="max-w-5xl mx-auto text-center">
    {/* Título */}
    <h2 className="text-3xl md:text-4xl font-bold text-gris-grafito">
      Caso Real: El Ahorro de Roberto en Zapopan
    </h2>

    {/* Contexto */}
    <p className="mt-4 text-lg md:text-xl text-gray-600 max-w-3xl mx-auto">
      Roberto pagaba $4,200 MXN... Nuestro monitoreo reveló una bomba de agua atorada...
    </p>

    {/* Visual (Crítico): Gráfica */}
    <div className="mt-12 max-w-3xl mx-auto">
      <img
        // Usamos basePath para la ruta correcta
        src="/cuentatron/diagnostico-personalizado/assets/grafico-antes-despues.png"
        alt="Gráfica de consumo antes y después del diagnóstico Cuentatrón"
        className="rounded-lg shadow-xl w-full h-auto object-contain border border-gray-200"
      />
    </div>

    {/* Resultado */}
    <div className="mt-8 bg-azul-confianza text-white p-6 rounded-lg max-w-xl mx-auto shadow-lg">
      <p className="text-lg">
        <strong>Solución:</strong> Reparación de la bomba de agua.
      </p>
      <p className="mt-2 text-2xl font-bold">
        Ahorro bimestral: $750 MXN
      </p>
    </div>
  </div>
</section>

{/* --- Sección 5: Calculadora ("Consumo Fantasma") --- */}
<section className="w-full bg-gray-50 py-16 md:py-24 px-6">
  <div className="max-w-3xl mx-auto text-center">

    <h2 className="text-3xl md:text-4xl font-bold text-gris-grafito">
      ¿Cuánto te está costando ese "fantasma"?
    </h2>

    {/* Input (type="number") */}
    <div className="mt-10 max-w-md mx-auto">
      <label htmlFor="recibo" className="block text-lg font-medium text-gray-700">
        ¿Cuánto pagaste en tu último recibo?
      </label>
      <div className="mt-2 relative">
        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-2xl text-gray-500">
          $
        </span>
        <input
          type="number" // El brief pide type="number"
          id="recibo"
          name="recibo"
          value={recibo}
          onChange={handleReciboChange}
          placeholder="4200"
          className="w-full pl-10 pr-4 py-4 text-2xl text-center font-bold border-2 border-gray-300 rounded-lg focus:ring-azul-confianza focus:border-azul-confianza"
          inputMode="numeric" // Mejora la experiencia en móvil
          pattern="[0-9]*"
        />
      </div>
    </div>

    {/* Output (Texto dinámico JS) */}
    {/* Mostramos el resultado solo si el usuario ha escrito algo */}
    <div className={`mt-6 mb-4 transition-opacity duration-500 ${recibo ? 'opacity-100' : 'opacity-0'}`}>
      <p className="text-lg text-gray-700 max-w-lg mx-auto">
        Un "consumo fantasma" (fuga o falla) representa entre el 15% y 30% de un recibo elevado.
      </p>
      <p className="mt-2 text-xl font-bold text-gris-grafito">
        En tu caso, podrías estar perdiendo hasta
        <span className="text-3xl text-azul-confianza mx-2">
          ${perdida} MXN
        </span>
        cada bimestre.
      </p>
    </div>

    {/* CTA Secundario (Botón Azul Confianza) */}
    <Link
      href="#" // Reemplazaremos esto con el link de Stripe
      onClick={handleCtaClick}
      className={`
        mt-12 px-10 py-4 rounded-lg
        bg-azul-confianza text-white 
        font-bold text-lg
        transition-transform duration-300 ease-in-out
        hover:scale-105 hover:shadow-lg
        ${isProcessing ? 'opacity-50 cursor-not-allowed' : ''}
      `}
      disabled={isProcessing}
    >
      {isProcessing ? 'Procesando...' : 'No pierdas más dinero. ¡Encuéntralo!'}
    </Link>
  </div>
</section>

{/* --- Sección 6: Cómo Funciona (Flujo V5.2) --- */}
<section className="w-full bg-white py-16 md:py-24 px-6">
  <div className="max-w-5xl mx-auto">
    {/* Título */}
    <h2 className="text-3xl md:text-4xl font-bold text-gris-grafito text-center">
      Tu camino hacia la certeza energética
    </h2>

    {/* Contenedor del Diagrama Visual de 5 Pasos */}
    {/* Usamos 'space-y-8' para separar los pasos verticalmente en móvil */}
    {/* En pantallas 'md' y superiores, 'space-y-0' anula eso y 'gap-4' toma el control */}
    <div className="mt-16 flex flex-col md:flex-row md:justify-between space-y-8 md:space-y-0 md:space-x-4">

      {/* Paso 1: Reserva */}
      <div className="flex flex-col items-center text-center max-w-[200px] mx-auto">
        <div className="flex items-center justify-center w-16 h-16 rounded-full bg-azul-confianza text-white">
          <CreditCard className="w-8 h-8" />
        </div>
        <h3 className="mt-4 text-lg font-bold">1. Reserva tu lugar</h3>
        <p className="mt-1 text-sm text-gray-600">
          Pagas tu 50% de anticipo seguro con Stripe.
        </p>
      </div>

      {/* Paso 2: Agenda y Perfila */}
      <div className="flex flex-col items-center text-center max-w-[200px] mx-auto">
        <div className="flex items-center justify-center w-16 h-16 rounded-full bg-azul-confianza text-white">
          <CalendarDays className="w-8 h-8" />
        </div>
        <h3 className="mt-4 text-lg font-bold">2. Agenda y Perfila</h3>
        <p className="mt-1 text-sm text-gray-600">
          Agendas tu visita en Calendly y llenas tu perfil energético.
        </p>
      </div>

      {/* Paso 3: Instalamos */}
      <div className="flex flex-col items-center text-center max-w-[200px] mx-auto">
        <div className="flex items-center justify-center w-16 h-16 rounded-full bg-azul-confianza text-white">
          <HardHat className="w-8 h-8" />
        </div>
        <h3 className="mt-4 text-lg font-bold">3. Instalamos</h3>
        <p className="mt-1 text-sm text-gray-600">
          Nuestro ingeniero instala el Cuentatrón en &lt; 30 min.
        </p>
      </div>

      {/* Paso 4: Monitoreo */}
      <div className="flex flex-col items-center text-center max-w-[200px] mx-auto">
        <div className="flex items-center justify-center w-16 h-16 rounded-full bg-azul-confianza text-white">
          <Smartphone className="w-8 h-8" />
        </div>
        <h3 className="mt-4 text-lg font-bold">4. Monitoreo Interactivo</h3>
        <p className="mt-1 text-sm text-gray-600">
          Vigilamos 7 días y te contactamos por WhatsApp para pruebas.
        </p>
      </div>

      {/* Paso 5: Reporte y Liquidación */}
      <div className="flex flex-col items-center text-center max-w-[200px] mx-auto">
        <div className="flex items-center justify-center w-16 h-16 rounded-full bg-azul-confianza text-white">
          <FileText className="w-8 h-8" />
        </div>
        <h3 className="mt-4 text-lg font-bold">5. Reporte y Liquidación</h3>
        <p className="mt-1 text-sm text-gray-600">
          Recibes tu Reporte PDF y liquidas el 50% restante.
        </p>
      </div>

    </div>
  </div>
</section>

{/* --- Sección 7: El Entregable (El Valor) --- */}
<section className="w-full bg-gray-50 py-16 md:py-24 px-6">
  <div className="max-w-5xl mx-auto">
    {/* Título */}
    <h2 className="text-3xl md:text-4xl font-bold text-gris-grafito text-center">
      Recibes un Plan de Acción, no solo gráficas.
    </h2>

    <div className="mt-12 grid grid-cols-1 md:grid-cols-2 gap-12 items-center">

      {/* Columna de Texto (Checklist) */}
      <div>
        <ul className="space-y-4">

          <li className="flex items-start">
            {/* Asegúrate de haber importado CheckCircle de lucide-react */}
            <CheckCircle className="flex-shrink-0 w-6 h-6 text-verde-ahorro mr-3" />
            <span className="text-lg text-gray-700">
              Gráficas de consumo Día vs. Noche.
            </span>
          </li>

          <li className="flex items-start">
            <CheckCircle className="flex-shrink-0 w-6 h-6 text-verde-ahorro mr-3" />
            <span className="text-lg text-gray-700">
              Detección de "Firmas" (Refrigerador, Bomba, A/C).
            </span>
          </li>

          <li className="flex items-start">
            <CheckCircle className="flex-shrink-0 w-6 h-6 text-verde-ahorro mr-3" />
            <span className="text-lg text-gray-700">
              Análisis de Consumo "Fantasma" (en $ y kWh).
            </span>
          </li>

          {/* El Plan de Acción (Destacado) */}
          <li className="flex items-start mt-6 pt-6 border-t border-gray-200">
            <CheckCircle className="flex-shrink-0 w-6 h-6 text-azul-confianza mr-3" />
            <span className="text-lg text-gray-700">
              <strong className="block text-xl text-azul-confianza font-bold">
                EL PLAN DE ÁCCIÓN:
              </strong>
              2-4 puntos accionables priorizados por un ingeniero.
            </span>
          </li>

        </ul>
      </div>

      {/* Columna de Imagen (Mockup) */}
      <div>
        <img
          src="/cuentatron/diagnostico-personalizado/assets/mockup-pdf-reporte.png"
          alt="Mockup del Reporte PDF de Diagnóstico Cuentatrón"
          className="rounded-lg shadow-xl w-full h-auto object-contain"
        />
      </div>

    </div>
  </div>
</section>

{/* --- Sección 8: Precio, Urgencia y Garantía (Bloque de Cierre) --- */}
<section className="w-full bg-white py-16 md:py-24 px-6">
  <div className="max-w-3xl mx-auto text-center">

    {/* Título */}
    <h2 className="text-3xl md:text-4xl font-bold text-gris-grafito">
      Una inversión, no un gasto.
    </h2>

    {/* Tarjeta de Precio (Centrada) */}
    <div className="mt-8 bg-white border-2 border-gray-200 rounded-lg shadow-xl p-8 max-w-lg mx-auto">
      <h3 className="text-2xl font-bold text-gris-grafito">
        Inversión Total (IVA Incluido)
      </h3>
      <p className="text-5xl font-bold text-azul-confianza my-4">
        $999 MXN
      </p>
      <p className="text-lg text-gray-700">
        <strong>Modelo 50/50:</strong>
      </p>
      <p className="text-xl text-gris-grafito mt-2">
        <span className="font-bold text-gray-900">$499.50</span> Hoy para reservar (vía Stripe)
      </p>
      <p className="text-xl text-gris-grafito mt-1">
        <span className="font-bold text-gray-900">$499.50</span> al recibir tu Reporte Final
      </p>
    </div>

    {/* Urgencia (Bloque Amarillo) */}
    <div className="mt-8 bg-yellow-50 border border-yellow-300 text-yellow-800 p-4 rounded-lg max-w-lg mx-auto">
      <p className="font-medium">
        <strong>¡Atención!</strong> Debido a la alta demanda, solo podemos aceptar 
        <span className="font-bold text-xl mx-1">{plazasSemanales}</span> 
        nuevos diagnósticos esta semana.
      </p>
    </div>

    {/* Badges de Confianza (Iconos) */}
<div className="mt-8 flex flex-col md:flex-row justify-center items-center space-y-4 md:space-y-0 md:space-x-8 text-gray-600">
  <div className="flex items-center">
    <span className="font-medium">🛡️ Garantía de Certeza</span>
  </div>
  <div className="flex items-center">
    <span className="font-medium">💳 Pago Seguro con Stripe</span>
  </div>
  <div className="flex items-center">
    <span className="font-medium">💬 Soporte por WhatsApp</span>
  </div>
</div>

    {/* CTA Principal (Verde Ahorro) */}
    <Link
      href="#" // Reemplazaremos esto con el link de Stripe
      onClick={handleCtaClick}
      className={`
        mt-10 rounded-lg
    px-6 py-4 text-lg 
    md:px-10 md:py-5 md:text-2xl
    bg-verde-ahorro text-gris-grafito 
    font-bold
    transition-transform duration-300 ease-in-out
    hover:scale-105 hover:shadow-lg
        ${isProcessing ? 'opacity-50 cursor-not-allowed' : ''}
      `}
      disabled={isProcessing}
    >
      {isProcessing ? 'Procesando...' : 'Reservar mi Diagnóstico con $499.50 →'}
    </Link>

    {/* Bloque de Garantía (Resaltado Visual) */}
    <div className="mt-12 bg-gray-50 border border-gray-200 rounded-lg p-6 text-left max-w-2xl mx-auto">
      <h4 className="text-xl font-bold text-azul-confianza flex items-center">
        <ShieldCheck className="w-6 h-6 mr-2" />
        Nuestra Garantía de Certeza Cuentatrón
      </h4>
      <p className="mt-4 text-gray-700">
        Estamos tan seguros de nuestro método que, si tras los 7 días de monitoreo nuestro análisis concluye que tu instalación está perfecta y no encontramos anomalías significativas, nuestro ingeniero se comunicará contigo y <strong>te regresamos tu anticipo íntegro</strong>. Sin letras chiquitas.
      </p>
    </div>

  </div>
</section>

{/* --- Sección 9: FAQs (Acordeón) --- */}
<section className="w-full bg-gray-50 py-16 md:py-24 px-6">
  <div className="max-w-3xl mx-auto">

    <h2 className="text-3xl md:text-4xl font-bold text-gris-grafito text-center">
      Preguntas Frecuentes
    </h2>

    <div className="mt-12">
      <FaqItem
        question="¿Qué pasa si no encuentran nada?"
        answer="Se aplica la Garantía de Certeza. Si tras los 7 días de monitoreo nuestro análisis concluye que tu instalación está perfecta y no encontramos anomalías significativas, te regresamos tu anticipo íntegro."
      />
      <FaqItem
        question="¿Tengo que estar en casa los 7 días?"
        answer="No. Solo necesitamos que estés presente (o un adulto responsable) para la instalación y la desinstalación, que toman menos de 30 minutos cada una."
      />
      <FaqItem
        question="¿Funciona si tengo Paneles Solares?"
        answer="Sí. Para realizar el diagnóstico de tu consumo real (lo que gastas de CFE), te pediremos que los paneles permanezcan apagados (bajar el interruptor o 'breaker' de los inversores) durante la semana de monitoreo."
      />
      <FaqItem
        question="¿Es seguro? ¿Ven mis datos privados?"
        answer="Es 100% seguro. Nuestro dispositivo solo mide el flujo eléctrico general (amperaje) de tu acometida. No se conecta a tu WiFi ni monitorea dispositivos individuales. Respetamos tu privacidad (LPD)."
      />
      <FaqItem
        question="¿El pago es seguro?"
        answer="Sí. Todos los pagos se procesan directamente a través de Stripe, una de las plataformas más seguras del mundo. Nosotros no almacenamos los datos de tu tarjeta."
      />
    </div>

  </div>
</section>

{/* --- Footer --- */}
<footer className="w-full bg-gris-grafito text-gray-400 py-12 px-6">
  <div className="max-w-5xl mx-auto text-center">
    <p className="text-lg font-bold text-white">Cuentatrón</p>
    <p className="text-sm">
      Un servicio de diagnóstico energético de <strong>TESIVIL</strong>.
    </p>
    <p className="mt-4 text-xs">
      © 2025 Cuentatrón. Todos los derechos reservados. | 
      <Link href="#" className="underline hover:text-white">Aviso de Privacidad</Link>
    </p>
  </div>
</footer>

      {/* Aquí irán las siguientes 8 secciones */}

    </main>
  );
}