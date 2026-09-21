import { LandingTrustOverview } from "../../components/landing-trust";
import { getGithubData } from "../../lib/github";
import { baseOpenGraph } from "../../lib/seo";

export const metadata = {
  title: "OmniRush.ai — Security & Data Privacy",
  description:
    "How OmniRush.ai handles data, subprocessors, incident response, and compliance for self-hosted enterprise deployments.",
  alternates: {
    canonical: "/trust"
  },
  openGraph: {
    ...baseOpenGraph,
    url: "https://omnirushlabs.com/trust"
  }
};

export default async function TrustPage() {
  const github = await getGithubData();
  const cal = process.env.NEXT_PUBLIC_CAL_URL ?? "";

  return (
    <LandingTrustOverview
      stars={github.stars}
      calUrl={cal}
    />
  );
}
