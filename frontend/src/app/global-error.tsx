"use client"; // Error boundaries must be Client Components

/** Replaces the root layout when the layout itself fails, so it carries its
 * own document and inline styles: the app's stylesheet and theme are not
 * available here. */
export default function GlobalError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100dvh",
          display: "grid",
          placeItems: "center",
          background: "#0a0a0b",
          color: "#f4f4f5",
          fontFamily: "ui-sans-serif, system-ui, sans-serif",
        }}
      >
        <title>Verity is not available</title>
        <div style={{ maxWidth: 480, padding: 24 }}>
          <h1 style={{ fontSize: 24, fontWeight: 600, margin: 0 }}>Verity is not available right now</h1>
          <p style={{ color: "#a1a1aa", fontSize: 14, lineHeight: 1.6 }}>
            The app could not start. Anything already on-chain is unaffected.
          </p>
          <button
            onClick={() => retry()}
            style={{
              marginTop: 8,
              padding: "8px 16px",
              borderRadius: 6,
              border: 0,
              background: "#047857",
              color: "#fff",
              fontSize: 14,
              fontWeight: 500,
              cursor: "pointer",
            }}
          >
            Try again
          </button>
          {error.digest && (
            <p style={{ color: "#6b6b74", fontSize: 12, fontFamily: "ui-monospace, monospace" }}>
              Reference {error.digest}
            </p>
          )}
        </div>
      </body>
    </html>
  );
}
