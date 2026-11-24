import Link from "next/link";
import { buttonClasses } from "./ui/button";
import { PAGE_SIZE, MAX_PAGE, parsePage } from "../lib/paging";

export { PAGE_SIZE, MAX_PAGE, parsePage };

/** Previous / next links for a list read one page at a time. `hasNext` comes
 * from asking the backend for one row more than a page holds. */
export function Pager({
  page,
  hasNext,
  hrefFor,
}: {
  page: number;
  hasNext: boolean;
  hrefFor: (page: number) => string;
}) {
  if (page === 1 && !hasNext) return null;
  return (
    <nav aria-label="Pagination" className="flex items-center justify-between gap-4 pt-2">
      {page > 1 ? (
        <Link href={hrefFor(page - 1)} className={buttonClasses("secondary")}>
          Newer
        </Link>
      ) : (
        <span />
      )}
      <span className="font-mono text-xs text-text-tertiary">Page {page}</span>
      {hasNext ? (
        <Link href={hrefFor(page + 1)} className={buttonClasses("secondary")}>
          Older
        </Link>
      ) : (
        <span />
      )}
    </nav>
  );
}
