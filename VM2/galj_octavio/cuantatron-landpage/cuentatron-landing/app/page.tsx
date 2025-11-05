// 1. Importamos TODOS los componentes de la página
import { Header } from '@/components/Header'
import { HeroSection } from '@/components/HeroSection'
import { ProblemSection } from '@/components/ProblemSection'
import { SolutionSection } from '@/components/SolutionSection'
import { HowItWorksSection } from '@/components/HowItWorksSection'
import { BenefitsSection } from '@/components/BenefitsSection'
import { TargetAudienceSection } from '@/components/TargetAudienceSection'
import { TrustSection } from '@/components/TrustSection'
import { PricingSection } from '@/components/PricingSection'
import { FAQSection } from '@/components/FAQSection'
import { Footer } from '@/components/Footer' // <-- AÑADIR ESTA LÍNEA

export default function Home() {
  return (
    <main className="bg-blanco">
      <Header />
      <HeroSection /> 
      <ProblemSection />
      <SolutionSection />
      <HowItWorksSection />
      <BenefitsSection />
      <TargetAudienceSection />
      <TrustSection />
      <PricingSection />
      <FAQSection />

      {/* AÑADIMOS EL FOOTER FINAL */}
      <Footer />

      {/* ¡YA NO NECESITAMOS EL DIV DE PRUEBA! 
        Hemos terminado el frontend.
      */}
    </main>
  )
}