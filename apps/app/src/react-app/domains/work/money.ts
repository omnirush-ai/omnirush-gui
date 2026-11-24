/** An amount in its currency ("€48,000.00"), or the plain number when the currency is unknown. Deals and the record
 *  viewers format money the same way. */
export function money(amount: string | number | null | undefined, currency: string | null | undefined): string {
  if (amount == null || amount === "") return "";
  const value = Number(amount);
  if (!Number.isFinite(value)) return `${amount}${currency ? ` ${currency}` : ""}`;
  try {
    return currency ? new Intl.NumberFormat(undefined, { style: "currency", currency }).format(value) : new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
  } catch {
    return `${value.toFixed(2)}${currency ? ` ${currency}` : ""}`;
  }
}
