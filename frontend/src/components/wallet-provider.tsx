"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { WatchWalletChanges } from "@stellar/freighter-api";
import { connectWallet, signXdr, WalletError, type WalletErrorCode } from "../lib/wallet";
import {
  fetchChallenge,
  exchangeChallenge,
  getSession,
  logout as apiLogout,
  SESSION_EXPIRED_EVENT,
} from "../lib/client-api";
import { NETWORK_PASSPHRASE } from "../lib/config";

export interface WalletProblem {
  message: string;
  /** Set when the wallet itself is the problem, so the UI can offer the fix. */
  code: WalletErrorCode | null;
}

interface WalletState {
  account: string | null;
  connecting: boolean;
  problem: WalletProblem | null;
  login: () => Promise<void>;
  logout: () => Promise<void>;
  dismissProblem: () => void;
}

const WalletContext = createContext<WalletState | null>(null);

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [account, setAccount] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [problem, setProblem] = useState<WalletProblem | null>(null);

  useEffect(() => {
    getSession()
      .then((s) => setAccount(s.account))
      .catch(() => setAccount(null));
  }, []);

  // The session lives an hour. When the server stops recognising it, show
  // that here rather than leaving a connected-looking account that cannot act.
  useEffect(() => {
    const onExpired = () => {
      setAccount(null);
      setProblem({ message: "Your session has expired. Connect your wallet again to continue.", code: null });
    };
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
  }, []);

  // The session is for one account. If Freighter's active account changes,
  // anything signed next would be for somebody else, so sign out and say why.
  useEffect(() => {
    if (!account) return;
    const watcher = new WatchWalletChanges(3000);
    watcher.watch(({ address }) => {
      if (address && address !== account) {
        // The wallet is a different account now, so the UI must disconnect
        // either way; if deleting the cookie fails, the old session cookie
        // may simply remain until it expires. The "Freighter switched..."
        // message below stays the one the user sees.
        apiLogout().catch(() => {});
        setAccount(null);
        setProblem({
          message: "Freighter switched to a different account. Connect again to continue as that account.",
          code: null,
        });
      }
    });
    return () => watcher.stop();
  }, [account]);

  const login = useCallback(async () => {
    setConnecting(true);
    setProblem(null);
    try {
      const address = await connectWallet(NETWORK_PASSPHRASE);
      const { transaction, network_passphrase } = await fetchChallenge(address);
      const signed = await signXdr(transaction, {
        networkPassphrase: network_passphrase || NETWORK_PASSPHRASE,
        address,
      });
      const { account: authedAccount } = await exchangeChallenge(signed);
      setAccount(authedAccount);
    } catch (err) {
      setProblem({
        message: err instanceof Error ? err.message : "Wallet connection failed.",
        code: err instanceof WalletError ? err.code : null,
      });
    } finally {
      setConnecting(false);
    }
  }, []);

  const logout = useCallback(async () => {
    setProblem(null);
    try {
      await apiLogout();
    } catch {
      // The cookie is httpOnly, so the client cannot clear it itself: showing
      // the user as disconnected while it survives would sign them back in on
      // the next reload. Keep the session shown and say what happened.
      setProblem({
        message: "Could not sign you out. Check your connection and try again.",
        code: null,
      });
      return;
    }
    setAccount(null);
  }, []);

  const dismissProblem = useCallback(() => setProblem(null), []);

  return (
    <WalletContext.Provider value={{ account, connecting, problem, login, logout, dismissProblem }}>
      {children}
    </WalletContext.Provider>
  );
}

export function useWallet(): WalletState {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet must be used within WalletProvider");
  return ctx;
}
