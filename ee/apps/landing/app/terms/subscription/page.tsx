import { LegalPage } from "../../../components/legal-page";

export const metadata = {
  title: "OmniRush.ai — Subscription Terms",
  description:
    "Subscription terms governing production use of OmniRush.ai Enterprise Edition software by Different AI, doing business as OmniRush.ai.",
  alternates: {
    canonical: "/terms/subscription"
  }
};

export default function SubscriptionTermsPage() {
  return <LegalPage file="terms/subscription/subscription-terms.md" />;
}
