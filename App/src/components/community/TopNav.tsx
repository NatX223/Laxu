import Link from "next/link";
import { SERIF } from "./shared";
import AccountMenu from "../auth/AccountMenu";
import FaucetButton from "../faucet/FaucetButton";

const LINK: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: "#a79bd0",
  padding: "7px 14px",
  borderRadius: 99,
};

/**
 * Wordmark, the four section tabs and the account menu.
 *
 * The Community pill stays lit on the position screen too — that screen sits
 * under the market — so it takes an href there and is inert here.
 */
export default function TopNav({ communityHref = "#" }: { communityHref?: string }) {
  return (
    <div
      className="laxu-topnav"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 18,
        padding: "0 20px",
        height: 58,
        background: "linear-gradient(90deg, #2f2459 0%, #261e49 62%, #221a42 100%)",
        borderBottom: "1px solid rgba(255,255,255,0.12)",
      }}
    >
      <div className="laxu-topnav-left" style={{ display: "flex", alignItems: "center", gap: 26 }}>
        <div
          style={{
            fontFamily: SERIF,
            fontStyle: "italic",
            fontSize: 27,
            lineHeight: 1,
            letterSpacing: "-0.02em",
            color: "#fdfbf7",
          }}
        >
          Laxu
        </div>
        <div className="laxu-topnav-links" style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <Link href="/trade" className="laxu-nav-link" style={LINK}>
            Trade
          </Link>
          <Link href="/trade" className="laxu-nav-link" style={LINK}>
            My tokens
          </Link>
          <Link href={communityHref} className="laxu-nav-current" style={{ ...LINK, color: "#fdfbf7", background: "#9670ff" }}>
            Community
          </Link>
          <Link href="/trade" className="laxu-nav-link" style={LINK}>
            Portfolio
          </Link>
        </div>
      </div>

      <div className="laxu-topnav-right" style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <FaucetButton />
        <AccountMenu />
      </div>
    </div>
  );
}
