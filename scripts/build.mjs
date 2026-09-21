import { execSync } from "node:child_process";

execSync("pnpm --filter @omnirush/desktop build", { stdio: "inherit" });
