"use client";

import { useEffect, useRef, useState } from "react";
import { Button, buttonClasses } from "./ui/button";
import { canonicalJson } from "../lib/canonical";
import {
  attestationFilename,
  verifyEd25519Signature,
  type SignatureCheckResult,
} from "../lib/strkey";
import { truncateMiddle } from "../lib/format";
import type { Attestation } from "../lib/types";

const README_VERIFY_ATTESTATION_URL =
  "https://github.com/DevQwinB/Verity/blob/main/README.md#verify-an-attestation";

interface CheckState {
  canonicalMatch: boolean;
  signature: SignatureCheckResult;
}

/**
 * Lets a visitor download the full signed attestation response as
 * `verity-attestation-<chain id>.json` and check it in the browser:
 *  1. `canonicalJson(payload) === canonical`
 *  2. WebCrypto `Ed25519` verification of `signature` over `canonical` for `signer`.
 */
export function AttestationCheck({
  attestation,
  chainSubmissionId,
}: {
  attestation: Attestation;
  chainSubmissionId?: string | null;
}) {
  const canonicalRef = useRef<HTMLPreElement | null>(null);
  const downloadLinkRef = useRef<HTMLAnchorElement | null>(null);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<CheckState | null>(null);

  const filename = attestationFilename(attestation.payload, chainSubmissionId);

  useEffect(() => {
    const link = downloadLinkRef.current;
    if (!link) return;
    const blob = new Blob([`${JSON.stringify(attestation, null, 2)}\n`], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    link.href = url;
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [attestation]);

  async function handleCheck() {
    setChecking(true);
    try {
      // Read the live text node from the rendered canonical block so editing
      // `canonical` in browser devtools (Elements or React props) is reflected.
      const liveCanonical = canonicalRef.current?.textContent ?? attestation.canonical;
      const canonicalMatch =
        typeof liveCanonical === "string" &&
        canonicalJson(attestation.payload) === liveCanonical;
      const signature = await verifyEd25519Signature({
        canonical: liveCanonical,
        signature: attestation.signature,
        signatureAlgorithm: attestation.signature_algorithm,
        signer: attestation.signer,
      });
      setResult({ canonicalMatch, signature });
    } finally {
      setChecking(false);
    }
  }

  function handleDownloadFallback(e: React.MouseEvent<HTMLAnchorElement>) {
    if (downloadLinkRef.current?.getAttribute("href")?.startsWith("blob:")) return;
    e.preventDefault();
    const blob = new Blob([`${JSON.stringify(attestation, null, 2)}\n`], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-3">
      <div>
        <p className="text-xs text-text-tertiary">Canonical JSON (exact signed bytes)</p>
        <pre
          ref={canonicalRef}
          className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-border-subtle bg-surface p-3 font-mono text-xs leading-relaxed text-text-secondary"
        >
          {attestation.canonical}
        </pre>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button variant="secondary" type="button" onClick={handleCheck} disabled={checking}>
          {checking ? "Checking..." : "Check in this browser"}
        </Button>
        <a
          ref={downloadLinkRef}
          href="#"
          download={filename}
          onClick={handleDownloadFallback}
          className={buttonClasses("secondary")}
        >
          Download JSON
        </a>
      </div>

      {result && (
        <ul
          role="status"
          aria-label="Attestation check results"
          className="divide-y divide-border-subtle rounded-lg border border-border-subtle bg-surface text-xs"
        >
          <li className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5">
            <span className="font-mono text-text-secondary">
              canonicalJson(payload) === canonical
            </span>
            <span
              className={
                result.canonicalMatch
                  ? "font-medium text-status-verified"
                  : "font-medium text-status-slashed"
              }
            >
              {result.canonicalMatch
                ? "Passed — payload canonicalizes to the signed string"
                : "Failed — payload does not match canonical string"}
            </span>
          </li>
          <li className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5">
            <span className="font-mono text-text-secondary">
              Ed25519 signature over canonical
            </span>
            {result.signature.status === "valid" ? (
              <span className="font-medium text-status-verified">
                Passed — valid for signer{" "}
                {attestation.signer ? truncateMiddle(attestation.signer, 6, 6) : ""}
              </span>
            ) : result.signature.status === "unsupported" ? (
              <span className="text-text-secondary">
                This browser does not support WebCrypto Ed25519. Download the JSON and run the{" "}
                <a
                  href={README_VERIFY_ATTESTATION_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="text-accent underline-offset-2 hover:underline"
                >
                  README verification script
                </a>
                .
              </span>
            ) : (
              <span className="font-medium text-status-slashed">
                Failed — {result.signature.reason}
              </span>
            )}
          </li>
        </ul>
      )}

      <p className="max-w-prose text-xs text-text-tertiary">
        This check only shows that the record is self-consistent and was signed by the key shown
        above — not that the work or verdict is correct. Trusting that key means comparing it with
        the operator&apos;s published key (see{" "}
        <a
          href={README_VERIFY_ATTESTATION_URL}
          target="_blank"
          rel="noreferrer"
          className="text-accent underline-offset-2 hover:underline"
        >
          Verify an attestation in the README
        </a>
        ).
      </p>
    </div>
  );
}
