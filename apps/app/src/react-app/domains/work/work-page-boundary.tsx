/** @jsxImportSource react */
// Around every Work page: one bad row (an old record the page did not expect) shows a calm "couldn't load" card with
// Reload, never a blank window. Reload reads the Work data again and draws the page anew.
import { useQueryClient } from "@tanstack/react-query";
import { RotateCw } from "lucide-react";
import { Component, type ErrorInfo, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { t } from "@/i18n";

type BoundaryProps = { children: ReactNode; onReload: () => void };
type BoundaryState = { failed: boolean };

class Boundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { failed: false };

  static getDerivedStateFromError(): BoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error("[work] page failed to render", error, info.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="h-full overflow-y-auto" data-testid="work-page-error">
        <div className="mx-auto flex w-full max-w-3xl flex-col items-start gap-3 px-6 pt-10">
          <h1 className="text-xl font-semibold tracking-tight">{t("work.page_error.title")}</h1>
          <p className="text-[14px] text-muted-foreground">{t("work.page_error.body")}</p>
          <Button
            variant="outline"
            size="sm"
            data-testid="work-page-reload"
            onClick={() => { this.props.onReload(); this.setState({ failed: false }); }}
          >
            <RotateCw className="size-3.5" />{t("work.page_error.reload")}
          </Button>
        </div>
      </div>
    );
  }
}

/** Wraps one Work page. Keyed by the page's path in the caller, so moving to another page starts it fresh. */
export function WorkPageBoundary(props: { children: ReactNode }) {
  const queryClient = useQueryClient();
  return (
    <Boundary onReload={() => void queryClient.invalidateQueries({ predicate: (query) => String(query.queryKey[0] ?? "").startsWith("omnirush-work") })}>
      {props.children}
    </Boundary>
  );
}
