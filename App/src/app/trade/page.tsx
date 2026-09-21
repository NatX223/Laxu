import type { Metadata } from "next";
import TradeScreen from "@/components/trade/TradeScreen";

export const metadata: Metadata = {
  title: "Laxu — Trade",
  description:
    "Trade perpetuals on Arcus and mint any open position as an ERC-20 you actually own.",
};

export default function TradePage() {
  return <TradeScreen />;
}
