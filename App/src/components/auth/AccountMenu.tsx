"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { getAddress } from "viem";
import { useSession } from "@/lib/session";

const MONO = "var(--font-ibm-plex-mono), monospace";

/**
 * The two header styles the designs use: the frosted one in the community and
 * position nav, and the solid amber one on the trade bar.
 */
const TONES = {
  frost: {
    button: {
      fontSize: 11.5,
      fontWeight: 600,
      color: "#fdfbf7",
      background: "rgba(255,255,255,0.06)",
      border: "1px solid rgba(255,255,255,0.12)",
      padding: "7px 12px",
    },
    signIn: { background: "#9670ff", border: "1px solid #9670ff" },
  },
  amber: {
    button: {
      fontSize: 12,
      fontWeight: 700,
      color: "#16130f",
      background: "#ffb765",
      border: "1px solid #ffb765",
      padding: "9px 15px",
    },
    signIn: {},
  },
} satisfies Record<string, { button: React.CSSProperties; signIn: React.CSSProperties }>;

/** Longer usernames get an ellipsis in the button on phones. */
const MOBILE_TAG_CHARS = 14;
const COPIED_MS = 1500;

/** `0x1a2B…9cDe` — 0x, first 4, last 4. */
const truncate = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 639px)");
    const update = () => setMobile(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return mobile;
}

/**
 * The header's account control on the trade, community and position pages:
 * Sign in when signed out; `@username ▾` once the backend user has loaded,
 * opening a menu with the stored wallet address (copyable) and Sign out.
 * Skeleton while Privy or `POST /users/me` is still answering, so the address
 * never stands in for the username.
 */
export default function AccountMenu({ tone = "frost" }: { tone?: keyof typeof TONES }) {
  const { ready, authenticated, user, userFailed, login, logout } = useSession();
  const t = TONES[tone];
  const mobile = useIsMobile();
  const pathname = usePathname();
  const menuId = useId();

  // The path it was opened on: navigating elsewhere closes it by itself.
  const [openOn, setOpenOn] = useState<string | null>(null);
  const open = openOn === pathname;
  const [copied, setCopied] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  /** Set when a close should hand focus back to the button (Esc, keyboard). */
  const refocus = useRef(false);
  /** Sign out swaps the button for Sign in; focus goes there once it renders. */
  const focusSignIn = useRef(false);

  const close = useCallback((returnFocus: boolean) => {
    refocus.current = returnFocus;
    setOpenOn(null);
  }, []);

  useEffect(() => {
    if (focusSignIn.current && !authenticated) {
      focusSignIn.current = false;
      buttonRef.current?.focus();
      return;
    }
    if (open || !refocus.current) return;
    refocus.current = false;
    buttonRef.current?.focus();
  });

  // Open: focus the first item so arrows work straight away.
  useEffect(() => {
    if (open) itemRefs.current[0]?.focus();
  }, [open]);

  // A click anywhere outside closes it, without stealing focus.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open, close]);

  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(id);
  }, [copied]);

  const base: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    fontFamily: "inherit",
    borderRadius: 99,
    whiteSpace: "nowrap",
    cursor: "pointer",
    ...t.button,
  };

  // Same box as the Sign in button, so nothing shifts when it resolves.
  if (!ready || (authenticated && !user && !userFailed)) {
    return (
      <div className="laxu-account-skeleton" style={{ ...base, cursor: "default" }} aria-busy="true" aria-label="Loading account">
        <span style={{ visibility: "hidden" }}>Sign in</span>
      </div>
    );
  }

  if (!authenticated) {
    return (
      <button ref={buttonRef} type="button" onClick={login} className="laxu-account-btn" style={{ ...base, ...t.signIn }}>
        Sign in
      </button>
    );
  }

  // Signed in, but the backend never answered: still let them leave.
  if (!user) {
    return (
      <button
        ref={buttonRef}
        type="button"
        onClick={() => void logout()}
        title="Couldn't load your account"
        className="laxu-account-btn"
        style={base}
      >
        Sign out
      </button>
    );
  }

  const address = getAddress(user.walletAddress);
  const tag = mobile && user.tag.length > MOBILE_TAG_CHARS ? `${user.tag.slice(0, MOBILE_TAG_CHARS - 1)}…` : user.tag;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
    } catch (error) {
      console.error("could not copy address", error);
    }
  };

  const signOut = async () => {
    focusSignIn.current = true;
    close(false);
    await logout();
  };

  const onMenuKeyDown = (event: React.KeyboardEvent) => {
    const items = itemRefs.current.filter((item): item is HTMLButtonElement => item !== null);
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const focusAt = (i: number) => items[(i + items.length) % items.length]?.focus();
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        focusAt(index + 1);
        break;
      case "ArrowUp":
        event.preventDefault();
        focusAt(index - 1);
        break;
      case "Home":
        event.preventDefault();
        focusAt(0);
        break;
      case "End":
        event.preventDefault();
        focusAt(items.length - 1);
        break;
      case "Escape":
        event.preventDefault();
        close(true);
        break;
      case "Tab":
        close(false);
        break;
    }
  };

  const itemBase: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    width: "100%",
    fontFamily: "inherit",
    background: "transparent",
    border: "none",
    borderRadius: 8,
    cursor: "pointer",
    textAlign: "left",
  };

  return (
    <div ref={rootRef} style={{ position: "relative" }}>
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpenOn(open ? null : pathname)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && open) close(true);
          if (event.key === "ArrowDown" && !open) {
            event.preventDefault();
            setOpenOn(pathname);
          }
        }}
        className="laxu-account-btn"
        style={base}
      >
        <span>@{tag}</span>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" style={{ transition: "transform .15s", transform: open ? "rotate(180deg)" : "none" }}>
          <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label="Account"
          onKeyDown={onMenuKeyDown}
          className="laxu-account-menu"
          style={{
            position: "absolute",
            top: "calc(100% + 8px)",
            right: 0,
            // Above the charts and the market menu (60), below modals (80).
            zIndex: 70,
            minWidth: 240,
            maxWidth: "calc(100vw - 32px)",
            padding: 6,
            background: "#261e49",
            border: "1px solid rgba(255,255,255,0.14)",
            borderRadius: 12,
            boxShadow: "0 14px 40px rgba(10, 6, 28, 0.55)",
            color: "#fdfbf7",
          }}
        >
          <button
            ref={(el) => {
              itemRefs.current[0] = el;
            }}
            type="button"
            role="menuitem"
            onClick={() => void copy()}
            title={copied ? "Copied" : address}
            aria-label={`Copy wallet address ${address}`}
            className="laxu-account-item"
            style={{ ...itemBase, justifyContent: "space-between", gap: 12, color: "#e3ddf4" }}
          >
            <span style={{ fontFamily: MONO, fontSize: 13 }}>{truncate(address)}</span>
            <span aria-hidden="true" style={{ display: "inline-flex", color: copied ? "#5fe3a8" : "#a79bd0" }}>
              {copied ? (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="9" width="12" height="12" rx="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
              )}
            </span>
          </button>

          <div role="separator" style={{ height: 1, margin: "6px 4px", background: "rgba(255,255,255,0.1)" }} />

          <button
            ref={(el) => {
              itemRefs.current[1] = el;
            }}
            type="button"
            role="menuitem"
            onClick={() => void signOut()}
            className="laxu-account-item"
            style={{ ...itemBase, fontSize: 13, fontWeight: 600, color: "#fdfbf7" }}
          >
            Sign out
          </button>

          <span aria-live="polite" className="laxu-sr-only">
            {copied ? "Address copied" : ""}
          </span>
        </div>
      )}
    </div>
  );
}
