/**
 * A fictional company's context graph in the shape of GET /omnirush/work/graph and /timeline (contract Addendum B1),
 * deterministic, for the graph explorer's tests and screenshot rig. All names and domains are made up.
 */
import type { OmniRushWorkGraph, OmniRushWorkGraphEdge, OmniRushWorkGraphNode, OmniRushWorkTimelineItem } from "../../src/app/lib/omnirush-server";

function prng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const COMPANIES = ["Harbor Lane Cafe", "Bluebell Grocers", "Copperleaf Hotels", "Stonebridge Dental", "Maple & Pine Interiors", "Northgate Logistics",
  "Sunrise Fitness", "Willow Creek Farms", "Lumen Print Co", "Riverbend Clinic", "Oakridge Builders", "Seaside Florist", "Brightpath Tutors",
  "Juniper Spa", "Granite Peak Outfitters", "Tidewater Brewing", "Silverline Auto", "Fernwood Bakery"];
const FIRST = ["Dana", "Marco", "Priya", "Tom", "Aisha", "Lena", "Jonas", "Rosa", "Omar", "Mei", "Felix", "Nora", "Sam", "Ivy", "Kofi", "Elena", "Raj", "Hana", "Leo", "Zoe"];
const LAST = ["Okafor", "Lindqvist", "Moreau", "Tanaka", "Brennan", "Castillo", "Novak", "Haddad", "Fischer", "Osei", "Kowalski", "Reyes", "Sato", "Walsh"];
const ROLES = ["Owner", "Office manager", "Head chef", "Purchasing", "Accounts", "Operations lead", "Front desk"];
const PRODUCTS = ["Sourdough loaf", "Croissant tray", "Wholesale flour 25kg", "Catering box", "Gluten-free range", "Coffee beans 1kg", "Cake order", "Delivery plan", "Pastry subscription", "Bread crates"];
const PROJECTS = ["Spring menu launch", "New oven install", "Wholesale expansion", "Website refresh", "Holiday catering", "Supplier switch", "Second shop fit-out", "Loyalty programme"];
const RECORD_KINDS: { kind: string; source: string; subjects: string[] }[] = [
  { kind: "email", source: "google", subjects: ["Re: order for next week", "Quote request", "Invoice question", "Delivery time change", "Re: tasting on Friday", "Price list 2026", "Follow-up from our call"] },
  { kind: "message", source: "slack", subjects: ["#orders: van is late", "#sales: big catering lead", "#kitchen: flour running low", "#general: holiday hours"] },
  { kind: "ticket", source: "hubspot", subjects: ["Damaged crate on delivery", "Wrong invoice amount", "Allergen info request", "Missed delivery"] },
  { kind: "invoice", source: "quickbooks", subjects: ["Invoice INV-10", "Invoice INV-11", "Invoice INV-12"] },
  { kind: "event", source: "google", subjects: ["Tasting session", "Quarterly review", "Supplier call", "Kitchen walkthrough"] },
  { kind: "page", source: "notion", subjects: ["Catering playbook", "Wholesale terms", "Onboarding checklist"] },
  { kind: "file", source: "google", subjects: ["Price list.xlsx", "Signed contract.pdf", "Menu draft.docx"] },
  { kind: "bill", source: "quickbooks", subjects: ["Bill from flour mill", "Packaging supplier bill"] },
];
const FACTS: { kind: string; text: string }[] = [
  { kind: "policy", text: "Never discount more than 10% without the owner." },
  { kind: "preference", text: "Prefers deliveries before 7am." },
  { kind: "decision", text: "Moved to net-30 payment terms." },
  { kind: "fact", text: "Orders spike in the week before holidays." },
  { kind: "contact_note", text: "Call, don't e-mail, for urgent changes." },
  { kind: "policy", text: "Copy accounts on every invoice." },
  { kind: "decision", text: "Paused the loyalty discount until March." },
];

const pick = <T,>(rand: () => number, list: readonly T[]) => list[Math.floor(rand() * list.length)]!;
const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "");

/** The whole fictional corpus as one graph (about 420 nodes). */
export function fullWorkGraph(seed = 7): OmniRushWorkGraph {
  const rand = prng(seed);
  const nodes: OmniRushWorkGraphNode[] = [];
  const edges: OmniRushWorkGraphEdge[] = [];
  const day = (ago: number) => new Date(Date.UTC(2026, 10, 13, 9 + Math.floor(rand() * 8), Math.floor(rand() * 60)) - ago * 86_400_000).toISOString();
  const add = (node: Omit<OmniRushWorkGraphNode, "degree">) => (nodes.push({ ...node, degree: 0 }), node.id);
  const link = (a: string, b: string, kind: string, reason: string) => edges.push({ a, b, kind, reason });

  const companies = COMPANIES.map((name, index) => add({ id: `e:c${index}`, type: "entity", kind: "company", label: name, sub: `${slug(name)}.example`, source: "hubspot" }));
  const people: { id: string; company: number; email: string; name: string }[] = [];
  companies.forEach((company, index) => {
    const size = 2 + Math.floor(rand() * 4);
    for (let n = 0; n < size; n += 1) {
      const name = `${pick(rand, FIRST)} ${pick(rand, LAST)}`;
      const email = `${slug(name.split(" ")[0]!)}@${slug(COMPANIES[index]!)}.example`;
      const id = add({ id: `e:p${people.length}`, type: "entity", kind: "person", label: name, sub: `${pick(rand, ROLES)} · ${COMPANIES[index]}`, source: "google" });
      people.push({ id, company: index, email, name });
      link(id, company, "related", `e-mail domain ${slug(COMPANIES[index]!)}.example`);
    }
  });
  const team = Array.from({ length: 6 }, (_, n) => {
    const name = `${FIRST[(n * 3) % FIRST.length]} ${LAST[(n * 5) % LAST.length]}`;
    return add({ id: `e:t${n}`, type: "entity", kind: "person", label: name, sub: `${ROLES[n % ROLES.length]} · Fernwood Bakery`, source: "slack" });
  });
  const products = PRODUCTS.map((name, index) => add({ id: `e:x${index}`, type: "entity", kind: "product", label: name, source: "quickbooks" }));
  const projects = PROJECTS.map((name, index) => add({ id: `e:j${index}`, type: "entity", kind: "project", label: name, source: "notion" }));
  projects.forEach((project) => {
    link(project, pick(rand, team), "related", "owner in Notion");
    link(project, pick(rand, products), "related", "mentioned in the project page");
  });
  const deals = Array.from({ length: 16 }, (_, n) => {
    const company = n % companies.length;
    const id = add({ id: `e:d${n}`, type: "entity", kind: "deal", label: `${COMPANIES[company]!.split(" ")[0]} ${pick(rand, ["catering", "wholesale", "renewal", "event"])} deal`, sub: `$${(2 + Math.floor(rand() * 30)) * 500}`, source: "hubspot" });
    link(id, companies[company]!, "related", "HubSpot deal company");
    link(id, pick(rand, products), "related", "line item");
    return id;
  });

  let invoice = 1040;
  for (let n = 0; n < 230; n += 1) {
    const spec = pick(rand, RECORD_KINDS);
    const person = pick(rand, people);
    const subject = spec.kind === "invoice" ? `Invoice INV-${invoice++}` : pick(rand, spec.subjects);
    const id = add({ id: `r:${n}`, type: "record", kind: spec.kind, label: subject, sub: `${person.name} · ${COMPANIES[person.company]}`, source: spec.source, occurred_at: day(Math.floor(rand() * 120)), url: `https://example.com/${spec.source}/${n}` });
    link(id, person.id, "mentions", `from ${person.email}`);
    if (rand() < 0.55) link(id, companies[person.company]!, "mentions", spec.kind === "invoice" ? `customer ${COMPANIES[person.company]}` : `domain ${person.email.split("@")[1]}`);
    if (rand() < 0.25) link(id, pick(rand, deals), "link", "deal id in the record");
    if (rand() < 0.2) link(id, pick(rand, team), "mentions", "sent by our team");
    if (rand() < 0.12) link(id, pick(rand, projects), "mentions", "project named in the text");
  }
  for (let n = 0; n < 28; n += 1) {
    const fact = FACTS[n % FACTS.length]!;
    const about = n % 3 === 0 ? pick(rand, companies) : pick(rand, people).id;
    const id = add({ id: `f:${n}`, type: "fact", kind: fact.kind, label: fact.text, sub: n % 2 ? "saved by you" : "saved by the agent", occurred_at: day(Math.floor(rand() * 60)) });
    link(id, about, "about", "remembered about this");
  }
  const degree = new Map<string, number>();
  for (const edge of edges) for (const end of [edge.a, edge.b]) degree.set(end, (degree.get(end) ?? 0) + 1);
  for (const node of nodes) node.degree = degree.get(node.id) ?? 0;
  const counts: Record<string, number> = {};
  for (const node of nodes) counts[`${node.type}:${node.kind}`] = (counts[`${node.type}:${node.kind}`] ?? 0) + 1;
  return { nodes, edges, counts, truncated: false };
}

/** GET /graph as the contract describes it: the overview (entities and facts first, then the busiest records) or one node's neighbourhood. */
export function workGraphAnswer(full: OmniRushWorkGraph, query: { focus?: string; limit?: number } = {}): OmniRushWorkGraph {
  const limit = Math.min(500, query.limit ?? 300);
  let ids: Set<string>;
  if (query.focus) {
    ids = new Set([query.focus]);
    for (const edge of full.edges) {
      if (edge.a === query.focus) ids.add(edge.b);
      if (edge.b === query.focus) ids.add(edge.a);
    }
  } else {
    const rank = (node: OmniRushWorkGraphNode) => (node.type === "record" ? 0 : 1000) + node.degree;
    ids = new Set([...full.nodes].sort((a, b) => rank(b) - rank(a)).slice(0, limit).map((node) => node.id));
  }
  const nodes = full.nodes.filter((node) => ids.has(node.id)).slice(0, limit);
  return { nodes, edges: full.edges.filter((edge) => ids.has(edge.a) && ids.has(edge.b)), counts: full.counts, truncated: full.nodes.length > nodes.length && !query.focus };
}

/** GET /timeline: records and facts newest first, for one node or the whole account; the cursor is an offset. */
export function workTimelineAnswer(full: OmniRushWorkGraph, query: { focus?: string; cursor?: string; limit?: number } = {}): { items: OmniRushWorkTimelineItem[]; next_cursor: string | null } {
  const near = query.focus ? new Set(full.edges.flatMap((edge) => (edge.a === query.focus ? [edge.b] : edge.b === query.focus ? [edge.a] : []))) : null;
  const items = full.nodes
    .filter((node) => node.type !== "entity" && (!near || near.has(node.id)))
    .sort((a, b) => String(b.occurred_at).localeCompare(String(a.occurred_at)))
    .map(({ degree: _degree, ...item }) => item);
  const start = Number(query.cursor ?? 0);
  const limit = query.limit ?? 50;
  return { items: items.slice(start, start + limit), next_cursor: start + limit < items.length ? String(start + limit) : null };
}
