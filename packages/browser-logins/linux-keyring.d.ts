import type { ChromiumKeyRing } from "./node";

type ExecFile = (
  file: string,
  args: string[],
  options: { timeout: number; windowsHide: boolean },
  callback: (error: Error | null, stdout: string | Buffer, stderr: string | Buffer) => void,
) => unknown;

export const LINUX_KEYRING_APPLICATIONS: Readonly<Record<"chrome" | "chromium" | "brave" | "edge" | "vivaldi", readonly string[]>>;
export function readLinuxKeyringPassword(browser: string, options?: { execFile?: ExecFile }): Promise<string | null>;
export function linuxChromiumKeys(password: string | null): Required<ChromiumKeyRing> & { v10: Buffer[]; v11: Buffer[] };
