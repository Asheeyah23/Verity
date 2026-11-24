import { cn } from "../../lib/utils";
import { forwardRef, type ButtonHTMLAttributes } from "react";

/** Shape lock for this project: buttons = rounded-md, cards/panels/inputs =
 * rounded-lg, badges/pills = rounded-full. Followed everywhere, not mixed. */
type Variant = "primary" | "secondary" | "ghost" | "danger";

const variants: Record<Variant, string> = {
  primary:
    "bg-accent-fill text-on-accent hover:bg-accent-fill-hover disabled:opacity-40 disabled:hover:bg-accent-fill",
  secondary:
    "bg-surface-raised text-text-primary border border-border-strong hover:bg-surface-hover disabled:opacity-40",
  ghost: "text-text-secondary hover:text-text-primary hover:bg-surface-hover disabled:opacity-40",
  danger: "bg-danger-fill text-white hover:opacity-90 disabled:opacity-40",
};

export function buttonClasses(variant: Variant = "primary", className?: string) {
  return cn(
    "inline-flex items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-medium",
    "transition-[transform,background-color] duration-150 active:scale-[0.98]",
    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
    "disabled:cursor-not-allowed disabled:active:scale-100",
    variants[variant],
    className
  );
}

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }
>(function Button({ variant = "primary", className, ...props }, ref) {
  return <button ref={ref} className={buttonClasses(variant, className)} {...props} />;
});
