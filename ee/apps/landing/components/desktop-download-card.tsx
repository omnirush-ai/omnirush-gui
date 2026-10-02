"use client";

// The /download card: macOS and Linux only. OmniRush has no native Windows app
// (it runs in WSL there), so this replaces the shared DownloadOmniRushCard from
// @omnirush/ui, which still lists Windows installers for the desktop app's own
// screens. Styling matches that card.

import { detectPlatform, type DetectedArch, type DetectedPlatform } from "@omnirush/ui/react";
import { useEffect, useState } from "react";
import type { DesktopInstallers } from "../lib/github";
import { WslLine } from "./wsl-line";

type DesktopOs = "macos" | "linux";
type Option = { href: string; label: string; arch?: DetectedArch };
type Group = { os: DesktopOs; title: string; options: Option[] };

function groupsFor(installers: DesktopInstallers): Group[] {
  return [
    {
      os: "macos",
      title: "macOS",
      options: [
        { href: installers.macos.appleSilicon, label: "Apple Silicon (M1+)", arch: "arm64" },
        { href: installers.macos.intel, label: "Intel", arch: "x64" }
      ]
    },
    {
      os: "linux",
      title: "Linux",
      options: [
        { href: installers.linux.appImageX64, label: "AppImage (x64)", arch: "x64" },
        { href: installers.linux.appImageArm64, label: "AppImage (ARM64)", arch: "arm64" },
        { href: installers.linux.tarX64, label: "tar.gz (x64)" },
        { href: installers.linux.tarArm64, label: "tar.gz (ARM64)" }
      ]
    }
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

function archLabel(os: DesktopOs, arch: DetectedArch): string {
  if (os === "macos") return arch === "arm64" ? "Apple Silicon" : "Intel";
  return arch === "arm64" ? "ARM64" : "x64";
}

export function DesktopDownloadCard({
  installers,
  releaseTag,
  windowsVisitor
}: {
  installers: DesktopInstallers;
  releaseTag?: string;
  /** From the request's user agent, so the WSL line is placed without a layout shift. */
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

  return (
    <>
      {windowsVisitor ? (
        <WslLine className="mb-4 rounded-[14px] border border-[#07192C] bg-white px-5 py-4 text-[15px] leading-6 text-[#07192C]" />
      ) : null}

      <section
        data-testid="download-omnirush-card"
        data-detected-os={detected?.os}
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
            Install the desktop app on macOS or Linux. Your workspace connects automatically after sign-in.
          </p>
        </div>

        <div className="grid gap-px border-t border-[#E9EDF3] bg-[#E9EDF3] sm:grid-cols-2">
          {groupsFor(installers).map((group) => {
            const yours = detected?.os === group.os;
            return (
              <div key={group.os} className="bg-white px-6 py-4">
                <div className="flex items-center gap-2">
                  <MonitorIcon className="h-4 w-4 text-[#8A96AC]" />
                  <span className="text-[13px] font-semibold text-[#07192C]">{group.title}</span>
                  {yours ? (
                    <span className="rounded-full bg-[#E5F5EA] px-1.5 py-px text-[10px] font-medium text-[#15803D]">
                      {detected?.arch ? `Detected · ${archLabel(group.os, detected.arch)}` : "Detected"}
                    </span>
                  ) : null}
                </div>
                <div className="mt-3 flex flex-col gap-2">
                  {group.options.map((option) => {
                    const recommended = Boolean(yours && option.arch && detected?.arch === option.arch);
                    return (
                      <a
                        key={`${option.label}-${option.href}`}
                        href={option.href}
                        target="_blank"
                        rel="noreferrer"
                        data-testid="download-omnirush-link"
                        data-download-omnirush-link="true"
                        data-recommended={recommended ? "true" : undefined}
                        className={
                          recommended
                            ? "inline-flex items-center gap-2 rounded-lg border border-[#07192C] bg-[#07192C] px-3 py-2 text-[12px] font-medium text-white transition-colors hover:border-[#12283F] hover:bg-[#12283F]"
                            : "inline-flex items-center gap-2 rounded-lg border border-[#DFE5EE] bg-[#F8FAFC] px-3 py-2 text-[12px] font-medium text-[#1C2B44] transition-colors hover:border-[#C9D5E7] hover:bg-[#EEF4FC]"
                        }
                      >
                        <DownloadIcon className={`h-3 w-3 shrink-0 ${recommended ? "text-white/70" : "text-[#5A6886]"}`} />
                        {option.label}
                        {recommended ? (
                          <span className="ml-auto shrink-0 whitespace-nowrap rounded-full bg-white/15 px-1.5 py-px text-[10px] font-medium text-white/90">
                            For your device
                          </span>
                        ) : null}
                      </a>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {windowsVisitor ? null : <WslLine className="mt-4 text-[13px] text-gray-500" />}
    </>
  );
}
