import type { ButtonHTMLAttributes, ReactNode } from "react";
import { useI18n } from "./i18n";

export function Button({
  variant = "primary",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" | "danger" }) {
  const styles = {
    primary: "bg-brand-700 text-white hover:bg-brand-600 disabled:opacity-50",
    ghost:
      "border border-stone-300 text-stone-700 hover:bg-stone-100 dark:border-stone-700 dark:text-stone-200 dark:hover:bg-stone-800",
    danger:
      "border border-red-300 text-red-700 hover:bg-red-50 dark:border-red-900 dark:text-red-300 dark:hover:bg-red-950",
  }[variant];
  return (
    <button
      type="button"
      className={`inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition ${styles} ${className}`}
      {...props}
    />
  );
}

export function Card({
  title,
  actions,
  children,
  className = "",
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-xl border border-stone-200 bg-white dark:border-stone-800 dark:bg-stone-900 ${className}`}
    >
      {title || actions ? (
        <header className="flex items-center justify-between gap-2 border-b border-stone-100 px-4 py-2.5 dark:border-stone-800">
          <h2 className="text-sm font-semibold text-stone-700 dark:text-stone-200">{title}</h2>
          <div className="flex gap-2">{actions}</div>
        </header>
      ) : null}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const { t } = useI18n();
  const live = status === "live";
  const color =
    status === "live"
      ? "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300"
      : status === "paused" || status === "joining"
        ? "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300"
        : status === "failed"
          ? "bg-stone-200 text-red-700 dark:bg-stone-800"
          : "bg-stone-100 text-stone-600 dark:bg-stone-800 dark:text-stone-300";
  const label = (t as Record<string, string>)[`status_${status}`] ?? status;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${color}`}
    >
      {live ? <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-red-600" /> : null}
      {label}
    </span>
  );
}

export const usd = (value: number) =>
  value < 0.01 && value > 0 ? `US$ ${value.toFixed(4)}` : `US$ ${value.toFixed(2)}`;

export const formatDate = (iso: string, lang: string) =>
  new Date(iso).toLocaleString(lang, { dateStyle: "medium", timeStyle: "short" });

export const clock = (ms: number) => {
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  return `${String(minutes).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
};
