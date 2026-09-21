import type { Metadata } from "next";
import CommunityScreen from "@/components/community/CommunityScreen";

export const metadata: Metadata = {
  title: "Laxu — Community market",
  description:
    "Every token here is one live position — its own entry, size and leverage. Buy in, and you hold a slice of somebody else's conviction.",
};

export default function CommunityPage() {
  return <CommunityScreen />;
}
