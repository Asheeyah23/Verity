"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { List, X } from "@phosphor-icons/react/dist/ssr";
import { cn } from "../../lib/utils";
import { ThemeToggle } from "../theme-toggle";
import { useWallet } from "../wallet-provider";
import { truncateMiddle } from "../../lib/format";
import { FREIGHTER_INSTALL_URL } from "../../lib/config";
import { Button } from "../ui/button";

const LINKS = [
  { href: "/submissions", label: "Submissions" },
  { href: "/reexecutors", label: "Re-executors" },
  { href: "/challenges", label: "Challenges" },
  { href: "/reports", label: "Reports" },
  { href: "/taxonomy", label: "Taxonomy" },
];

export function Nav() {
  const pathname = usePathname();
  const { account, connecting, networkOk, problem, login, logout, dismissProblem } = useWallet();
  const [menuOpen, setMenuOpen] = useState(false);
  const persistentProblem = problem?.code === "wrong-network" && !networkOk;

  return (
    <header className="sticky top-0 z-20 border-b border-border-subtle bg-surface/90 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
        <div className="flex items-center gap-6">
          <Link href="/" className="flex items-center gap-2 text-sm font-semibold tracking-tight text-text-primary">
            Verity
            {/* Every balance and transaction here is test-network: say so everywhere. */}
            <span className="rounded-full border border-border-strong px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-text-tertiary">
              Testnet
            </span>
          </Link>
          <nav aria-label="Main" className="hidden items-center gap-1 md:flex">
            {LINKS.map((link) => {
              const active = pathname?.startsWith(link.href);
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "rounded-md px-3 py-1.5 text-sm transition-colors",
                    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
                    active
                      ? "bg-surface-hover text-text-primary"
                      : "text-text-secondary hover:text-text-primary"
                  )}
                >
                  {link.label}
                </Link>
              );
            })}
          </nav>
        </div>
        <div className="flex items-center gap-2 sm:gap-3">
          <ThemeToggle />
          {account ? (
            <div className="flex items-center gap-2">
              <span className="hidden font-mono text-xs text-text-secondary sm:inline">
                {truncateMiddle(account, 4, 4)}
              </span>
              <Button variant="secondary" onClick={logout}>
                Disconnect
              </Button>
            </div>
          ) : (
            <Button variant="primary" onClick={login} disabled={connecting}>
              {connecting ? "Connecting..." : "Connect wallet"}
            </Button>
          )}
          <Button
            variant="ghost"
            className="px-2 md:hidden"
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            aria-expanded={menuOpen}
            aria-controls="mobile-nav"
            onClick={() => setMenuOpen((open) => !open)}
          >
            {menuOpen ? <X size={20} /> : <List size={20} />}
          </Button>
        </div>
      </div>

      {menuOpen && (
        <nav id="mobile-nav" aria-label="Main" className="border-t border-border-subtle px-4 py-3 md:hidden">
          <ul className="space-y-1">
            {LINKS.map((link) => {
              const active = pathname?.startsWith(link.href);
              return (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    aria-current={active ? "page" : undefined}
                    // Following a link should not leave the menu covering the new page.
                    onClick={() => setMenuOpen(false)}
                    className={cn(
                      "block rounded-md px-3 py-2.5 text-sm",
                      active ? "bg-surface-hover text-text-primary" : "text-text-secondary"
                    )}
                  >
                    {link.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      )}

      {problem && (
        <div
          role="alert"
          className={cn(
            "border-t",
            problem.code === "wrong-network"
              ? "border-status-pending/40 bg-status-pending/15"
              : "border-border-subtle bg-surface-raised"
          )}
        >
          <div className="mx-auto flex max-w-7xl items-start justify-between gap-4 px-4 py-3 text-sm sm:px-6 lg:px-8">
            <p className="text-text-primary">
              {problem.message}{" "}
              {problem.code === "not-installed" && (
                <a
                  href={FREIGHTER_INSTALL_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="text-accent underline-offset-2 hover:underline"
                >
                  Install Freighter
                </a>
              )}
            </p>
            {!persistentProblem && (
              <button
                type="button"
                onClick={dismissProblem}
                aria-label="Dismiss"
                className="shrink-0 rounded-md p-1 text-text-tertiary transition-colors hover:text-text-primary focus-visible:outline-2 focus-visible:outline-accent"
              >
                <X size={16} />
              </button>
            )}
          </div>
        </div>
      )}
    </header>
  );
}
