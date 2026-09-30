/** @jsxImportSource react */
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, CircleAlert, Copy, Eye, Hand, Loader2, MousePointer2, RefreshCw, ShieldCheck } from "lucide-react";

import { desktopBridge } from "@/app/lib/desktop";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { registerExtensionConfig } from "./extension-registry";

type PermissionResult = {
  ok: boolean;
  accessibility: boolean;
  screenRecording: boolean;
  supported: boolean;
  error?: string;
  platform?: string;
  modes?: string[];
};

type ComputerUseConfigProps = {
  connected: boolean;
  connecting: boolean;
  onConnect?: () => void | Promise<void>;
  onRefresh?: () => void | Promise<void>;
  onPermissionsChange?: (permissions: { accessibility: boolean; screenRecording: boolean }) => void;
};

registerExtensionConfig("computer-use", (ctx) => (
  <ComputerUseConfig
    connected={ctx.computerUse?.connected ?? false}
    connecting={ctx.computerUse?.connecting ?? false}
    onConnect={ctx.computerUse?.onConnect}
    onRefresh={ctx.computerUse?.onRefresh}
    onPermissionsChange={ctx.computerUse?.onPermissionsChange}
  />
));

function hasDesktopBridge() {
  return typeof window !== "undefined" && Boolean(window.__OMNIRUSH_ELECTRON__?.invokeDesktop);
}

function parsePermissionResult(value: unknown): PermissionResult {
  if (typeof value !== "object" || value === null) throw new Error("Could not read Computer Use permissions.");
  return {
    ok: "ok" in value && value.ok === true,
    accessibility: "accessibility" in value && value.accessibility === true,
    screenRecording: "screenRecording" in value && value.screenRecording === true,
    supported: !("supported" in value && value.supported === false),
    platform: "platform" in value && typeof value.platform === "string" ? value.platform : "darwin",
    modes: "modes" in value && Array.isArray(value.modes) ? value.modes.filter((mode): mode is string => typeof mode === "string") : ["observe", "assist", "control"],
    error: "error" in value && typeof value.error === "string" ? value.error : undefined,
  };
}

const PERMISSIONS_QUERY_KEY = ["computer-use", "permissions"];
const modes = [
  { mode: "observe", icon: Eye, name: "Read a window", description: "See its text and screenshots. No clicks or typing." },
  { mode: "assist", icon: Hand, name: "Use app controls", description: "Work through accessible controls while your pointer stays free." },
  { mode: "control", icon: MousePointer2, name: "Use mouse and keyboard", description: "Work in the foreground. Your input pauses the session." },
];

export function ComputerUseConfig({ connected, connecting, onConnect, onRefresh, onPermissionsChange }: ComputerUseConfigProps) {
  const queryClient = useQueryClient();
  const [waitingForConnection, setWaitingForConnection] = useState(false);
  const connectedRef = useRef(connected);
  useEffect(() => {
    connectedRef.current = connected;
    if (connected) setWaitingForConnection(false);
  }, [connected]);
  const { data: result, isFetching, error: checkError, refetch } = useQuery({
    queryKey: PERMISSIONS_QUERY_KEY,
    queryFn: async () => {
      // Engine connections can finish restoring after the settings page mounts.
      // Refresh workspace readiness alongside macOS permissions while it is open.
      const [permissions] = await Promise.all([desktopBridge.checkComputerUsePermissions(), onRefresh?.()]);
      return parsePermissionResult(permissions);
    },
    enabled: hasDesktopBridge(),
    retry: false,
    refetchOnWindowFocus: true,
    staleTime: 0,
    refetchInterval: 2_000,
    refetchIntervalInBackground: true,
  });
  const connect = useMutation({
    mutationFn: async () => {
      setWaitingForConnection(true);
      await onConnect?.();
      const deadline = Date.now() + 15_000;
      while (!connectedRef.current && Date.now() < deadline) {
        await onRefresh?.();
        if (connectedRef.current) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (!connectedRef.current) {
        throw new Error("Computer Use is still starting. Refresh the status and try again if it does not connect.");
      }
    },
    onSettled: () => setWaitingForConnection(false),
  });
  const setup = useMutation({
    mutationFn: async () => parsePermissionResult(await desktopBridge.openComputerUsePermissionSetup()),
    onSuccess: (next) => queryClient.setQueryData(PERMISSIONS_QUERY_KEY, next),
  });
  const copyCli = useMutation({
    mutationFn: async () => {
      const [command, env] = await Promise.all([desktopBridge.getComputerUseMcpCommand(), desktopBridge.getComputerUseMcpEnvironment()]);
      if (!command.length || !command.every((part) => typeof part === "string") || !env) throw new Error("Computer Use could not create a CLI connection. Check desktop access and try again.");
      await navigator.clipboard.writeText(JSON.stringify({ mcpServers: { "computer-use": { command: command[0], args: command.slice(1), env } } }, null, 2));
    },
  });
  useEffect(() => {
    if (result) onPermissionsChange?.({ accessibility: result.accessibility, screenRecording: result.screenRecording });
  }, [result, onPermissionsChange]);

  const mac = result?.platform === "darwin";
  const availableModes = result?.modes ?? ["observe", "control"];
  const error = (connect.error ?? setup.error ?? copyCli.error ?? checkError)?.message ?? result?.error;
  const supported = hasDesktopBridge() && result?.supported !== false;
  const permissionsReady = result?.ok === true;
  const ready = connected && permissionsReady;
  const busy = isFetching || waitingForConnection || setup.isPending;
  const refresh = async () => { setup.reset(); connect.reset(); await refetch(); await onRefresh?.(); };

  return (
    <Card variant="outline" size="sm">
      <CardHeader>
        <CardTitle>Work in an app you choose</CardTitle>
        <CardDescription>
          Approve one app, choose its window, and decide how omnirush.ai can help. Your input interrupts control; Stop in the preview ends access.
        </CardDescription>
        <CardAction>
          <Button variant="ghost" size="icon-sm" aria-label="Refresh Computer Use status" onClick={() => void refresh()} disabled={busy}>
            <RefreshCw className={cn(busy && "animate-spin")} />
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="flex items-center gap-2 rounded-xl border border-border bg-muted/40 px-3 py-3 text-sm" role="status" aria-live="polite">
          {ready ? <CheckCircle2 className="size-4 shrink-0 text-green-11" /> : <ShieldCheck className="size-4 shrink-0 text-muted-foreground" />}
          <span>{ready ? "Ready · app access is approved when a session starts" : !supported ? "Desktop access is unavailable on this session" : !connected ? permissionsReady ? "Permissions are ready. Enable Computer Use for this workspace." : "Set up Computer Use for this workspace" : mac ? "Connected · finish macOS permissions below" : "Connected · check desktop access below"}</span>
        </div>
        {!ready ? (
          <Button className="w-full" onClick={() => { if (!connected) connect.mutate(); else setup.mutate(); }} disabled={!supported || connecting || waitingForConnection || connect.isPending || setup.isPending || (!connected && !onConnect)}>
            {connecting || waitingForConnection || connect.isPending || setup.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
            {connecting || waitingForConnection || connect.isPending ? "Enabling…" : !connected ? "Enable Computer Use" : mac ? "Allow macOS access" : "Check desktop access"}
          </Button>
        ) : null}
        {error ? <Alert variant="destructive"><CircleAlert /><AlertDescription className="break-words">{error}</AlertDescription></Alert> : null}
        <div className="space-y-3">
          <p className="text-sm font-medium">You choose the scope</p>
          <div className="grid gap-2">
            {modes.filter(({ mode }) => availableModes.includes(mode)).map(({ icon: Icon, name, description }) => (
              <div key={name} className="flex gap-3 rounded-xl border border-border p-3">
                <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <div><p className="text-sm font-medium">{name}</p><p className="mt-1 text-xs leading-relaxed text-muted-foreground">{description}</p></div>
              </div>
            ))}
          </div>
        </div>
        <div className="space-y-3 border-t border-border pt-4">
          <div><p className="text-sm font-medium">{mac ? "macOS permissions" : "Desktop access"}</p><p className="mt-1 text-xs leading-relaxed text-muted-foreground">These let the helper work. App access still needs your approval for each session.</p></div>
          {mac ? <PermissionRow title="Accessibility" description="Read and use app controls" granted={result?.accessibility} /> : <PermissionRow title="Mouse and keyboard" description="Foreground input; your input pauses control" granted={result?.accessibility} />}
          <PermissionRow title={mac ? "Screen Recording" : "Window screenshots"} description="See only the window you approve" granted={result?.screenRecording} />
          <Button variant="outline" className="min-h-10 w-full whitespace-normal" disabled={!supported || setup.isPending} onClick={() => setup.mutate()}>
            {setup.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
            Open permissions and session controls
          </Button>
        </div>
        {permissionsReady ? <div className="space-y-2 border-t border-border pt-4">
          <Button variant="outline" disabled={copyCli.isPending} onClick={() => copyCli.mutate()}><Copy className="size-4" />{copyCli.isSuccess ? "CLI connection copied" : "Copy CLI connection"}</Button>
          <p className="text-xs leading-relaxed text-muted-foreground">Keep OmniRush.ai open. Add the copied server to ~/.omnirush/mcp.json, then run /mcp reconnect in the CLI. Window approval stays in this app.</p>
        </div> : null}
        <p className="text-xs leading-relaxed text-muted-foreground">
          {!mac ? "Keep the target app visible on an unlocked desktop. Computer Use moves the mouse and types in the foreground; choose Continue after taking over. Choose a model that accepts images. For background Blender work, ask for a Blender Python script or use an app connector. " : null}
          Hide the preview if it covers app controls; Stop stays available in the OmniRush.ai window. Sessions end after 15 minutes and pause when idle. Window content is processed by your selected model provider. Enter passwords yourself. For websites, use the built-in browser.
        </p>
      </CardContent>
      <CardFooter className="flex flex-wrap items-center justify-between gap-3 border-t border-border">
        <p className="max-w-sm text-xs text-muted-foreground">{ready ? "Mention an app in your next message, then approve the window when asked." : !connected ? "Desktop access and enabling tools for this workspace are separate steps." : "Allow access, then return here. Status updates automatically."}</p>
        {ready ? <Button variant="outline" onClick={() => void refresh()} disabled={busy}>Check readiness</Button> : null}
      </CardFooter>
    </Card>
  );
}

function PermissionRow({ title, description, granted }: { title: string; description: string; granted: boolean | undefined }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg bg-muted/40 px-3 py-2">
      <div><p className="text-sm">{title}</p><p className="text-xs text-muted-foreground">{description}</p></div>
      <span className={cn("shrink-0 text-xs font-medium", granted ? "text-green-11" : "text-muted-foreground")}>
        {granted === undefined ? "Checking…" : granted ? "Allowed" : "Needed"}
      </span>
    </div>
  );
}
