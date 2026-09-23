import type { Metadata } from "next";
import PositionScreen from "@/components/position/PositionScreen";

export const metadata: Metadata = {
  title: "Laxu — Position",
  description:
    "One token, one position. Entry, size, leverage and NAV from every report the contract saw — buy in and you hold a slice of it.",
};

/** A minted position, by its token address: live charts and a real buy-in. */
export default async function LivePositionPage({ params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  return <PositionScreen positionTokenAddress={address.toLowerCase()} />;
}
