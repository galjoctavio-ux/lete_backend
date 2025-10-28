// 1. Importamos los componentes
import { Header } from '@/components/Header'
import { HeroSection } from '@/components/HeroSection' // <-- AÑADIR ESTA LÍNEA

export default function Home() {
  return (
    <main className="bg-blanco">
      {/* Añadimos el Header */}
      <Header />

      {/* AÑADIMOS LA NUEVA SECCIÓN HERO */}
      <HeroSection /> 

      {/* Eliminamos el div de prueba y dejamos espacio para lo que sigue */}
      <div className="h-[2000px]">
        {/* ... aquí irán las otras secciones ... */}
      </div>
    </main>
  )
}