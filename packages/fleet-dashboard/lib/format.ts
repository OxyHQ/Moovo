import {
  FAIR_SYMBOL,
  type DisplayMoney,
  type JobStatus,
  type JobType,
} from "@moovo/shared-types";

/**
 * Display helpers for the Moovo transport domain.
 *
 * Money is a {@link DisplayMoney}: FAIR is the source of truth, with an optional
 * converted fiat `display`. We render the fiat amount when present (what the
 * operator entered/expects to see) and fall back to FAIR otherwise — never
 * recomputing the price from any audit field.
 */

/** ISO-4217 → glyph for the small set of fiat display currencies we support. */
const CURRENCY_SYMBOL: Record<string, string> = {
  EUR: "€",
  USD: "$",
};

/** Format a {@link DisplayMoney} for display (fiat when present, else FAIR). */
export function formatMoney(money: DisplayMoney): string {
  if (money.display) {
    const symbol = CURRENCY_SYMBOL[money.display.currency] ?? "";
    return `${symbol}${money.display.amount.toFixed(2)}`;
  }
  return `${FAIR_SYMBOL}${money.fair.toFixed(2)}`;
}

/** Format an ISO-8601 instant as a short, locale-aware `HH:MM` time. */
export function formatTime(iso: string, locale: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Format an ISO-8601 instant as a short, locale-aware date. */
export function formatDate(iso: string, locale: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/** Whether a job is in a live/active (non-terminal) state. */
export function isActiveJob(status: JobStatus): boolean {
  return (
    status === "requested" ||
    status === "offered" ||
    status === "accepted" ||
    status === "picked_up" ||
    status === "in_transit"
  );
}

/** i18n key for a job status chip label (`dispatch.status.*`). */
export function jobStatusKey(status: JobStatus): string {
  return `dispatch.status.${status}`;
}

/** i18n key for a job/shipment type label (`dispatch.type.*`). */
export function jobTypeKey(type: JobType): string {
  return `dispatch.type.${type}`;
}
