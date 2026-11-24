"use client";

import { requestAccess, signTransaction, isConnected, getNetwork } from "@stellar/freighter-api";
import {
  createWalletClient,
  evaluateWalletChange,
  WalletError,
  wrongNetworkMessage,
  type FreighterApi,
  type WalletErrorCode,
  type WalletTimeouts,
  type WatchedWalletChange,
  type WatchedWalletEffect,
} from "./wallet-core";

export {
  createWalletClient,
  evaluateWalletChange,
  WalletError,
  wrongNetworkMessage,
  type FreighterApi,
  type WalletErrorCode,
  type WalletTimeouts,
  type WatchedWalletChange,
  type WatchedWalletEffect,
};

const freighter = createWalletClient({
  isConnected,
  requestAccess,
  getNetwork,
  signTransaction,
});

export const assertWalletNetwork = freighter.assertWalletNetwork;
export const connectWallet = freighter.connectWallet;
export const signXdr = freighter.signXdr;
