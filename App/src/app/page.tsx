import AssetsSection from "@/components/landing/AssetsSection";
import CtaFaq from "@/components/landing/CtaFaq";
import FlowSection from "@/components/landing/FlowSection";
import Hero from "@/components/landing/Hero";
import OrbitStage from "@/components/landing/OrbitStage";
import SiteFooter from "@/components/landing/SiteFooter";

export default function Home() {
  return (
    <main>
      <Hero />
      <OrbitStage />
      <FlowSection />
      <AssetsSection />
      <CtaFaq />
      <SiteFooter />
    </main>
  );
}
