"use client";

import { useState, type CSSProperties } from "react";
import { colorFromString } from "@/lib/markets";

/**
 * The one market icon, used everywhere a market appears: the Arcus logo when
 * there is one, otherwise a letter avatar whose colour is derived from the
 * symbol so it is the same every time. `onError` also catches logos that are
 * listed but broken, not just null ones.
 *
 * A plain <img>, not next/image — that would need `images.remotePatterns` for
 * both branding hosts.
 */
export default function MarketIcon({
  logoUrl,
  baseAsset,
  size = 24,
  font,
  style,
}: {
  logoUrl: string | null | undefined;
  baseAsset: string;
  size?: number;
  /** Letter size; defaults to ~45% of the disc. */
  font?: number;
  style?: CSSProperties;
}) {
  // Reset the failure flag when the logo changes, without an effect.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const disc: CSSProperties = { flex: "none", width: size, height: size, borderRadius: "50%", ...style };

  if (logoUrl && failedUrl !== logoUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- remote logos, see above
      <img
        src={logoUrl}
        alt={baseAsset}
        width={size}
        height={size}
        onError={() => setFailedUrl(logoUrl)}
        style={{ ...disc, objectFit: "cover", display: "block" }}
      />
    );
  }

  return (
    <div
      aria-label={baseAsset}
      style={{
        ...disc,
        display: "grid",
        placeItems: "center",
        fontSize: font ?? Math.round(size * 0.45),
        fontWeight: 700,
        color: "#16130f",
        background: colorFromString(baseAsset),
      }}
    >
      {baseAsset.slice(0, 1)}
    </div>
  );
}
