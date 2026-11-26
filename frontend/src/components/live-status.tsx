interface LiveStatusProps {
  message?: string | null;
}

/**
 * Polite live region for screen reader progress announcements.
 * Rendered from initial mount with empty text so screen readers register the
 * live region and announce subsequent message updates.
 */
export function LiveStatus({ message }: LiveStatusProps) {
  return (
    <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
      {message ?? ""}
    </p>
  );
}
