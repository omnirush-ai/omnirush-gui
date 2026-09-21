---
description: Publish an OmniRush.ai desktop release
---

Follow `.opencode/skills/release/SKILL.md` and `docs/RELEASING.md`.

1. Require a clean `main` branch matching `origin/main`.
2. Run the release review checks.
3. Cut the requested semantic version with `pnpm release:cut`; use the next patch version when no version is specified.
4. Watch the `Desktop Release` workflow until every platform build succeeds.
5. Verify the GitHub release is public and includes macOS ARM64/x64, Windows x64, Linux x64, and checksum downloads.

Do not report completion while the release is a draft or an installer is missing.
