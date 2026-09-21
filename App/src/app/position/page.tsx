import type { Metadata } from "next";
import PositionScreen from "@/components/position/PositionScreen";

export const metadata: Metadata = {
  title: "Laxu — Lunar Ladder",
  description:
    "One token, one position. Entry, size, leverage and NAV, replayed from every oracle report the contract saw — buy in and you hold a slice of it.",
};

export default function PositionPage() {
  return <PositionScreen />;
}
