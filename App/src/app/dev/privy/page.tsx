import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { env } from "@/lib/env";
import DevPrivy from "@/components/dev/DevPrivy";

export const metadata: Metadata = {
  title: "Laxu — Privy signer spike (dev)",
  robots: { index: false, follow: false },
};

/** Spec 05 spike 1.3. Exists only with NEXT_PUBLIC_DEV_TOOLS=1; everywhere else it is a 404. */
export default function DevPrivyPage() {
  if (!env.devTools) notFound();
  return <DevPrivy />;
}
