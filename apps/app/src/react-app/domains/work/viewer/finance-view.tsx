/** @jsxImportSource react */
// Finance and commerce (QuickBooks, Xero, Stripe, Shopify; design 2.5): the number, customer, amount, status, dates
// and lines of an invoice, bill, payment or order; customers and products as fields.
import { t } from "@/i18n";

import { Body, FieldGrid, Pill, SectionTitle, statusTone } from "./parts";
import type { RecordFinance, WorkRecord } from "./records";

export function money(amount: string | null | undefined, currency: string | null | undefined): string {
  if (amount == null || amount === "") return "";
  const value = Number(amount);
  if (!Number.isFinite(value)) return `${amount}${currency ? ` ${currency}` : ""}`;
  try {
    return currency ? new Intl.NumberFormat(undefined, { style: "currency", currency }).format(value) : new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
  } catch {
    return `${value.toFixed(2)}${currency ? ` ${currency}` : ""}`;
  }
}
const day = (value: string | null | undefined) => {
  if (!value) return "";
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? value : at.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
};

export function FinanceView(props: { record: WorkRecord }) {
  const record = props.record;
  const finance: RecordFinance | undefined = record.finance;
  if (!finance) {
    return (
      <div className="flex flex-col gap-5 px-4 py-4" data-testid="work-finance-view">
        <FieldGrid fields={record.fields} />
        <Body body={record.body} />
      </div>
    );
  }
  const lines = finance.lines ?? [];
  const facts = [
    finance.customer ? { label: t("work.viewer.customer"), value: finance.customer } : null,
    finance.issued ? { label: t("work.viewer.issued"), value: day(finance.issued) } : null,
    finance.due ? { label: t("work.viewer.due"), value: day(finance.due) } : null,
    finance.balance != null && finance.balance !== "" ? { label: t("work.viewer.balance"), value: money(finance.balance, finance.currency) } : null,
  ].filter((f): f is { label: string; value: string } => Boolean(f));
  return (
    <div className="flex flex-col gap-5 px-4 py-4" data-testid="work-finance-view">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[24px] font-semibold leading-8 tracking-[-0.02em] text-foreground tabular-nums" data-testid="work-finance-amount">{money(finance.amount, finance.currency) || "-"}</p>
          {finance.number ? <p className="text-[12px] text-muted-foreground">{t("work.viewer.number", { number: finance.number })}</p> : null}
        </div>
        {finance.status ? <Pill tone={statusTone(finance.status)}>{finance.status}</Pill> : null}
      </div>
      <FieldGrid fields={facts} />
      {lines.length ? (
        <section aria-label={t("work.viewer.lines")}>
          <SectionTitle count={lines.length}>{t("work.viewer.lines")}</SectionTitle>
          <table className="w-full text-[13px]">
            <tbody className="divide-y divide-border">
              {lines.map((line, index) => (
                <tr key={index}>
                  <td className="py-1.5 pe-3 text-foreground">{line.description || t("work.viewer.line")}</td>
                  <td className="py-1.5 text-end tabular-nums text-foreground">{money(line.amount, finance.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}
    </div>
  );
}
