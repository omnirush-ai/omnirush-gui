/**
 * Cloud tasks in the shapes of backend docs/work-cloud.md (the contract every lane shares), deterministic, for the
 * desktop's tests and its screenshot rig until the backend's tests/fixtures/work_cloud/*.json land. All companies,
 * sites and people are made up; the sites are our own test portals' names.
 */
import type {
  OmniRushWorkCloud, OmniRushWorkCloudFeedItem, OmniRushWorkCloudRun, OmniRushWorkCloudSignin, OmniRushWorkCloudStep,
  OmniRushWorkCloudTask, OmniRushWorkOrgCloud,
} from "../../src/app/lib/omnirush-server";

// Times are relative to now, so "3 min ago" reads right in the rig's screenshots; nothing asserts a clock time.
const NOW = Math.floor(Date.now() / 60_000) * 60_000;
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const later = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();

export const CLOUD_ADMIN: OmniRushWorkCloud = { on: true, create: true, admin: true, live: true, vault: true, limits: { desktops: 2, minutes_left: 412 } };
export const CLOUD_MEMBER: OmniRushWorkCloud = { on: true, create: false, admin: false, live: true, vault: false, limits: { desktops: 2, minutes_left: 412 } };

export const ORG_CLOUD: OmniRushWorkOrgCloud = {
  enabled: true,
  hosts: ["portal.northbeam.example", "billdesk.example", "*.carrier-reports.example", "vat.tax-office.example", "orders.fernwood.example", "suppliers.copperleaf.example", "tickets.lumen.example", "files.granite.example", "portal.tidewater.example", "reports.silverline.example"],
  creators: "admins",
  notify: "owner_and_admins",
  retention_days: 30,
  vault: true,
  usage: { minutes: 188, minutes_limit: 600, steps: 1240, steps_limit: 3000, desktops: 2, desktops_now: 1 },
};

export const SIGNINS: OmniRushWorkCloudSignin[] = [
  { id: "s_northbeam", label: "Northbeam (ops)", hosts: ["portal.northbeam.example"], username_hint: "o***s@acme-freight.example", use: "everyone", last_used_at: ago(90) },
  { id: "s_billdesk", label: "BillDesk finance", hosts: ["billdesk.example"], username_hint: "f*****e@acme-freight.example", use: "admins", last_used_at: ago(60 * 26) },
  { id: "s_vat", label: "Tax office", hosts: ["vat.tax-office.example"], username_hint: "a***n", use: "admins", last_used_at: null },
];

const owner = { id: "u_dana", name: "Dana Okafor" };
const task = (id: string, title: string, start: string, over: Partial<OmniRushWorkCloudTask> = {}): OmniRushWorkCloudTask => ({
  id, title, instructions: `${title}. Save each one with its PDF.`, start_url: start, signin_id: null, signin_mode: "none", output: { kind: "row" }, write_mode: "read",
  schedule: null, paused: false, owner, next_run_at: null, last_run: null, created_at: ago(60 * 24 * 20), updated_at: ago(60 * 24 * 2), ...over,
});

export const TASKS: OmniRushWorkCloudTask[] = [
  task("t_invoices", "Pull supplier invoices", "https://portal.northbeam.example/login", {
    signin_id: "s_northbeam", signin_mode: "saved", output: { kind: "invoice" }, schedule: { every: "week", at: "08:00", weekday: 0, tz: "Europe/Berlin" },
    next_run_at: later(60 * 24 * 6), last_run: { id: "r_code", status: "waiting", summary: "Waiting for a sign-in code", at: ago(3) },
  }),
  task("t_vat", "Quarterly VAT export", "https://vat.tax-office.example/returns", {
    signin_id: "s_vat", signin_mode: "saved", write_mode: "ask", last_run: { id: "r_approval", status: "waiting", summary: "Waiting for your approval", at: ago(12) },
  }),
  task("t_billdesk", "BillDesk invoices for acme", "https://billdesk.example/acme", {
    signin_id: "s_billdesk", signin_mode: "saved", output: { kind: "invoice" }, schedule: { every: "week", at: "07:00", weekday: 0, tz: "Europe/Berlin" },
    last_run: { id: "r_done", status: "done", summary: "20 invoices saved", at: ago(60 * 25) },
  }),
  task("t_carrier", "Carrier delivery report", "https://daily.carrier-reports.example/", {
    output: { kind: "files" }, schedule: { every: "day", at: "07:30", tz: "Europe/Berlin" },
    last_run: { id: "r_failed", status: "failed", summary: "The site did not load", at: ago(120) },
  }),
  task("t_orders", "Fernwood order sync", "https://orders.fernwood.example/", {
    output: { kind: "order" }, schedule: { every: "day", at: "06:00", tz: "Europe/Berlin" },
    last_run: { id: "r_running", status: "running", summary: "Running, step 6", at: ago(2) },
  }),
  task("t_tickets", "Lumen support tickets", "https://tickets.lumen.example/queue", { output: { kind: "ticket" }, schedule: { every: "day", at: "09:00", tz: "Europe/Berlin" }, last_run: { id: "r_t", status: "done", summary: "7 tickets saved", at: ago(30) } }),
  task("t_month", "Month-end statements", "https://suppliers.copperleaf.example/statements", { schedule: { every: "month", at: "09:00", day: 1, tz: "Europe/Berlin" }, last_run: { id: "r_m", status: "done", summary: "12 rows saved", at: ago(60 * 24 * 23) } }),
  task("t_granite", "Granite file drop", "https://files.granite.example/", { output: { kind: "files" }, last_run: { id: "r_g", status: "stopped", summary: "Cancelled", at: ago(60 * 24 * 3) } }),
  task("t_tidewater", "Tidewater price list", "https://portal.tidewater.example/prices", { schedule: { every: "week", at: "10:00", weekday: 3, tz: "Europe/Berlin" }, last_run: { id: "r_tw", status: "done", summary: "48 rows saved", at: ago(60 * 24 * 5) } }),
  task("t_silverline", "Silverline parts report", "https://reports.silverline.example/parts", { last_run: { id: "r_s", status: "limit", summary: "Stopped at the month's limit", at: ago(60 * 24 * 9) } }),
  task("t_old", "Old quote portal", "https://portal.tidewater.example/quotes", { paused: true, paused_reason: "Owner left the company", schedule: { every: "week", at: "11:00", weekday: 4, tz: "Europe/Berlin" }, owner: { id: "u_jonas", name: "Jonas Novak" }, last_run: { id: "r_o", status: "done", summary: "3 rows saved", at: ago(60 * 24 * 14) } }),
  task("t_new", "Freight claims check", "https://billdesk.example/claims"),
];

const run = (id: string, taskId: string, over: Partial<OmniRushWorkCloudRun>): OmniRushWorkCloudRun => ({
  id, task_id: taskId, status: "done", waiting_for: null, trigger: "schedule", run_as: "u_dana", started_at: ago(60), ended_at: null, minutes: 0, steps: 0,
  tokens: { in: 0, out: 0 }, result: null, flags: [], error: null, live: false, approval: null, ...over,
});

const invoiceIds = Array.from({ length: 20 }, (_, index) => `webtask:t_billd:INV-${4471 + index}`);

export const RUNS: Record<string, OmniRushWorkCloudRun> = {
  r_done: run("r_done", "t_billdesk", {
    started_at: ago(60 * 25), ended_at: ago(60 * 25 - 1.2), minutes: 1.2, steps: 14, tokens: { in: 61_200, out: 1_840 },
    result: {
      answer: "20 invoices saved to Work, 2 of them new since last week. The newest is INV-4490 from Northbeam Supplies for $8,946.20, due 19 Dec.",
      records: { saved: 20, skipped: 1, source_ids: invoiceIds },
      files: Array.from({ length: 7 }, (_, index) => ({ name: `INV-${4471 + index}.pdf`, bytes: 48_000 + index * 3_100, mime: "application/pdf" })),
    },
    flags: [
      { kind: "ignored_instruction", text: "The portal showed a message asking to buy gift cards for the account manager. It was ignored." },
      { kind: "blocked_host", text: "cdn.billdesk-assets.example", host: "cdn.billdesk-assets.example" },
      { kind: "blocked_host", text: "cdn.billdesk-assets.example", host: "cdn.billdesk-assets.example" },
      { kind: "note", text: "INV-4479 had no PDF on the portal, so only its row was saved." },
    ],
  }),
  r_code: run("r_code", "t_invoices", { status: "waiting", waiting_for: "code", started_at: ago(4), minutes: 3.4, steps: 5, live: true }),
  r_approval: run("r_approval", "t_vat", {
    status: "waiting", waiting_for: "approval", trigger: "manual", started_at: ago(14), minutes: 2.1, steps: 11, live: true,
    approval: { summary: "Submit the Q3 VAT return for Acme Freight: net VAT due 12,430.55 EUR, filed for July to September.", shot_url: "/omnirush/work/cloud/runs/r_approval/steps/11/shot" },
  }),
  r_running: run("r_running", "t_orders", { status: "running", started_at: ago(2), minutes: 1.6, steps: 6, live: true }),
  r_takeover: run("r_takeover", "t_orders", { status: "waiting", waiting_for: "takeover", started_at: ago(5), minutes: 4.2, steps: 8, live: true }),
  r_failed: run("r_failed", "t_carrier", {
    status: "failed", started_at: ago(121), ended_at: ago(120), minutes: 0.8, steps: 3, error: { code: "site_unreachable", message: "site_unreachable" },
    flags: [{ kind: "blocked_host", text: "static.carrier-cdn.example", host: "static.carrier-cdn.example" }],
  }),
};

/** Earlier runs of BillDesk invoices (the run view's short list). */
export const BILLDESK_RUNS: OmniRushWorkCloudRun[] = [
  RUNS.r_done!,
  ...Array.from({ length: 7 }, (_, index) => run(`r_b${index}`, "t_billdesk", { started_at: ago(60 * 24 * 7 * (index + 1) + 60), ended_at: ago(60 * 24 * 7 * (index + 1)), minutes: 1 + index / 10, steps: 12 + index, status: index === 2 ? "failed" : "done", error: index === 2 ? { code: "site_unreachable", message: "" } : null })),
];

export const STEPS: OmniRushWorkCloudStep[] = [
  "Opened billdesk.example/acme", "Clicked the user name field", "Filled the user name from BillDesk finance", "Filled the password from BillDesk finance",
  "Clicked Sign in", "Opened Invoices", "Read the invoice table, 20 rows on 2 pages", "Fetched INV-4471.pdf", "Fetched INV-4472.pdf", "Fetched INV-4473.pdf",
  "Saved 20 invoices to Work", "Noted that INV-4479 has no PDF", "Ignored a gift card request on the page", "Done: 20 invoices saved",
].map((summary, index) => ({ n: index + 1, at: ago(60 * 25 - index * 0.08), tool: index < 5 ? "computer" : "collect_tables", summary, ok: true, error: null, served_model: "gpt-6-astra", has_shot: index % 3 === 0 }));

export const FEED_CLOUD: OmniRushWorkCloudFeedItem[] = [
  { run_id: "r_code", task_id: "t_invoices", title: "Pull supplier invoices", status: "waiting", waiting_for: "code", at: ago(3) },
  { run_id: "r_approval", task_id: "t_vat", title: "Quarterly VAT export", status: "waiting", waiting_for: "approval", at: ago(12) },
  { run_id: "r_failed", task_id: "t_carrier", title: "Carrier delivery report", status: "failed", waiting_for: null, at: ago(120) },
];

export const LIVE_TICKET = `${"eyJkIjoiZDEiLCJvIjoibzEiLCJ1IjoidTEiLCJtIjoidmlldyJ9"}.${"c2lnbmF0dXJlLW9mLXRoZS10aWNrZXQtZm9yLXRlc3Rz"}`;
