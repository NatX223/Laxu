"use client";

import Link from "next/link";
import type { ComponentProps } from "react";
import { useSession } from "@/lib/session";

/**
 * A link into the app that signs the visitor in (or up) first. Signed out, a
 * click opens Privy's login and follows the link once it completes; signed
 * in, it's an ordinary link. The href stays real, so middle-click and
 * no-JS still land on the page.
 */
export default function AuthLink({ href, onClick, ...rest }: ComponentProps<typeof Link> & { href: string }) {
  const { ready, authenticated, loginThen } = useSession();

  return (
    <Link
      href={href}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented || authenticated || !ready) return;
        // let modified clicks (new tab etc.) behave as links
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        loginThen(href);
      }}
      {...rest}
    />
  );
}
