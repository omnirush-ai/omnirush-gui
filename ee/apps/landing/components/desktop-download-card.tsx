"use client";

// The /download card: macOS, WSL and Linux. OmniRush has no native Windows app,
// so WSL takes the column Windows used to have, and it is the recommended
// choice on a Windows computer. This replaces the shared DownloadOmniRushCard
// from @omnirush/ui, which the desktop app's own screens still use. Styling
// matches that card.

import { detectPlatform, type DetectedArch, type DetectedPlatform } from "@omnirush/ui/react";
import { useEffect, useState, type ReactNode } from "react";
import type { DesktopInstallers } from "../lib/github";
import {
  WSL_BUTTON,
  WSL_HEADLINE,
  WSL_INSTALL_LABEL,
  WSL_INSTALL_URL,
  WSL_SENTENCE,
  WSL_STEPS_URL
} from "../lib/wsl";

type DesktopOs = "macos" | "linux";
type Option = { href: string; label: string; arch?: DetectedArch };

function macosOptions(installers: DesktopInstallers): Option[] {
  return [
    { href: installers.macos.appleSilicon, label: "Apple Silicon (M1+)", arch: "arm64" },
    { href: installers.macos.intel, label: "Intel", arch: "x64" }
  ];
}

function linuxOptions(installers: DesktopInstallers): Option[] {
  return [
    { href: installers.linux.appImageX64, label: "AppImage (x64)", arch: "x64" },
    { href: installers.linux.appImageArm64, label: "AppImage (ARM64)", arch: "arm64" },
    { href: installers.linux.tarX64, label: "tar.gz (x64)" },
    { href: installers.linux.tarArm64, label: "tar.gz (ARM64)" }
  ];
}

function DownloadIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1={12} y1={15} x2={12} y2={3} />
    </svg>
  );
}

function MonitorIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
      <rect x={2} y={3} width={20} height={14} rx={2} />
      <line x1={8} y1={21} x2={16} y2={21} />
      <line x1={12} y1={17} x2={12} y2={21} />
    </svg>
  );
}

function TerminalIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
      <polyline points="4 17 10 11 4 5" />
      <line x1={12} y1={19} x2={20} y2={19} />
    </svg>
  );
}

function archLabel(os: DesktopOs, arch: DetectedArch): string {
  if (os === "macos") return arch === "arm64" ? "Apple Silicon" : "Intel";
  return arch === "arm64" ? "ARM64" : "x64";
}

function Column({ title, detectedLabel, children }: { title: string; detectedLabel: string | null; children: ReactNode }) {
  return (
    <div className="bg-white px-6 py-4">
      <div className="flex items-center gap-2">
        <MonitorIcon className="h-4 w-4 text-[#8A96AC]" />
        <span className="text-[13px] font-semibold text-[#07192C]">{title}</span>
        {detectedLabel ? (
          <span className="rounded-full bg-[#E5F5EA] px-1.5 py-px text-[10px] font-medium text-[#15803D]">{detectedLabel}</span>
        ) : null}
      </div>
      <div className="mt-3 flex flex-col gap-2">{children}</div>
    </div>
  );
}

function OptionLink({ href, recommended, testId, icon, children }: {
  href: string;
  recommended: boolean;
  testId: string;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      data-testid={testId}
      data-recommended={recommended ? "true" : undefined}
      className={
        recommended
          ? "inline-flex items-center gap-2 rounded-lg border border-[#07192C] bg-[#07192C] px-3 py-2 text-[12px] font-medium text-white transition-colors hover:border-[#12283F] hover:bg-[#12283F]"
          : "inline-flex items-center gap-2 rounded-lg border border-[#DFE5EE] bg-[#F8FAFC] px-3 py-2 text-[12px] font-medium text-[#1C2B44] transition-colors hover:border-[#C9D5E7] hover:bg-[#EEF4FC]"
      }
    >
      <span className={`shrink-0 ${recommended ? "text-white/70" : "text-[#5A6886]"}`}>{icon}</span>
      {children}
      {recommended ? (
        <span className="ml-auto shrink-0 whitespace-nowrap rounded-full bg-white/15 px-1.5 py-px text-[10px] font-medium text-white/90">
          For your device
        </span>
      ) : null}
    </a>
  );
}

export function DesktopDownloadCard({
  installers,
  releaseTag,
  windowsVisitor
}: {
  installers: DesktopInstallers;
  releaseTag?: string;
  /** From the request's user agent, so a Windows visitor sees WSL recommended on first paint. */
  windowsVisitor: boolean;
}) {
  const [detected, setDetected] = useState<DetectedPlatform | null>(null);

  useEffect(() => {
    let cancelled = false;
    void detectPlatform().then((platform) => {
      if (!cancelled) setDetected(platform);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const tag = releaseTag?.trim();
  const windows = windowsVisitor || detected?.os === "windows";

  const downloadColumn = (os: DesktopOs, title: string, options: Option[]) => {
    const yours = !windows && detected?.os === os;
    return (
      <Column
        title={title}
        detectedLabel={yours ? (detected?.arch ? `Detected · ${archLabel(os, detected.arch)}` : "Detected") : null}
      >
        {options.map((option) => (
          <OptionLink
            key={`${option.label}-${option.href}`}
            href={option.href}
            recommended={Boolean(yours && option.arch && detected?.arch === option.arch)}
            testId="download-omnirush-link"
            icon={<DownloadIcon className="h-3 w-3" />}
          >
            {option.label}
          </OptionLink>
        ))}
      </Column>
    );
  };

  return (
    <section
      data-testid="download-omnirush-card"
      data-detected-os={windows ? "windows" : detected?.os}
      data-detected-arch={detected ? detected.arch ?? "unknown" : undefined}
      className="overflow-hidden rounded-[18px] border border-[#E3E7EE] bg-white shadow-[0_24px_60px_-32px_rgba(7,25,44,0.22)]"
    >
      <div className="bg-gradient-to-b from-[#FAFBFE] to-white px-6 py-5">
        <div className="flex items-center gap-2.5">
          <DownloadIcon className="h-5 w-5 text-[#07192C]/70" />
          <span className="text-[16px] font-semibold text-[#07192C]">Download OmniRush.ai</span>
          {tag ? (
            <span className="rounded-full bg-[#F1F4F9] px-2 py-0.5 text-[11px] font-medium text-[#5A6886]">{tag}</span>
          ) : null}
        </div>
        <p className="mt-2 max-w-[520px] text-[13px] leading-[1.6] text-[#5A6886]">
          Install the desktop app on macOS or Linux, or switch to WSL on Windows. Your workspace connects automatically after sign-in.
        </p>
      </div>

      <div className="grid gap-px border-t border-[#E9EDF3] bg-[#E9EDF3] sm:grid-cols-3">
        {downloadColumn("macos", "macOS", macosOptions(installers))}

        {/* WSL sits where Windows used to be. */}
        <Column title="WSL" detectedLabel={windows ? "Detected · Windows" : null}>
          <div data-testid="wsl-option">
            <p className="text-[13px] font-semibold leading-5 text-[#07192C]">{WSL_HEADLINE}</p>
            <p className="mt-1 text-[12px] leading-[1.55] text-[#5A6886]">{WSL_SENTENCE}</p>
          </div>
          <OptionLink
            href={WSL_STEPS_URL}
            recommended={windows}
            testId="wsl-setup-link"
            icon={<TerminalIcon className="h-3 w-3" />}
          >
            {WSL_BUTTON}
          </OptionLink>
          <a
            href={WSL_INSTALL_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="px-1 text-[12px] text-[#5A6886] underline underline-offset-2 hover:text-[#07192C]"
          >
            {WSL_INSTALL_LABEL} <span aria-hidden="true">↗</span>
          </a>
        </Column>

        {downloadColumn("linux", "Linux", linuxOptions(installers))}
      </div>
    </section>
  );
}
