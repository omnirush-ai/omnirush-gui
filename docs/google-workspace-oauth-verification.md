# Google Workspace OAuth Verification

## Project

- Google Cloud project: `OmniRush.ai Google Workspace`
- Project ID: `noted-victory-497500-f9`
- OAuth app name: `OmniRush.ai`
- Support email: `info@omnirush.ai`
- Homepage: `https://omnirush.ai`
- Privacy policy: not published yet (omnirush.ai has no privacy page to register)
- Terms: not published yet (omnirush.ai has no terms page to register)
- Authorized domain: `omnirush.ai`
- Desktop OAuth client ID: `929071212606-pmkqimjhm2tnp68kbklnout0irllj99h.apps.googleusercontent.com`

## Phase 1 Scopes

```text
openid
https://www.googleapis.com/auth/userinfo.email
https://www.googleapis.com/auth/userinfo.profile
https://www.googleapis.com/auth/calendar.readonly
https://www.googleapis.com/auth/drive.file
https://www.googleapis.com/auth/gmail.compose
```

## Opt-In Scopes (Custom OAuth Client Only)

These scopes are never requested by the built-in OmniRush.ai OAuth client. They are only requested when the user supplies their own Google OAuth client and explicitly enables the matching permission in `Settings -> Extensions -> Google Workspace -> Advanced`:

```text
https://www.googleapis.com/auth/gmail.readonly        (Read Gmail)
https://www.googleapis.com/auth/drive                 (Full Google Drive access)
https://www.googleapis.com/auth/calendar.events       (Create calendar events)
https://www.googleapis.com/auth/chat.spaces.readonly  (Google Chat)
https://www.googleapis.com/auth/chat.messages.readonly
https://www.googleapis.com/auth/chat.messages.create
```

Each opt-in permission is enforced per account at runtime: extension actions that need a scope return a `403` (`google_gmail_read_not_granted`, `google_calendar_write_not_granted`, `google_chat_not_granted`) when the connected account did not grant it.

## Scope Justifications

### `openid`, `userinfo.email`, `userinfo.profile`

OmniRush.ai uses these scopes to identify the connected Google account in the app, display the signed-in account email to the user, and help users confirm they connected the intended Google account.

### `calendar.readonly`

OmniRush.ai uses this scope to read upcoming Google Calendar events when the user asks for meeting context or meeting preparation. OmniRush.ai does not modify calendars with this scope. The initial Google Workspace integration uses calendar data to show event title, time, attendees, and linked resources so the user can prepare for upcoming meetings.

### `drive.file`

OmniRush.ai uses this scope to access only the specific Google Drive files that the user selects, opens, or creates with OmniRush.ai. OmniRush.ai does not request broad Drive read access in Phase 1. This lets the user ask OmniRush.ai to summarize or use a selected document while keeping the rest of the user's Drive outside the app's access.

### `gmail.compose`

OmniRush.ai uses this scope to create Gmail drafts for the user to review in Gmail. Phase 1 does not expose an automatic send-email tool. Draft creation is used for workflows like drafting a meeting follow-up after the user asks for it. Users remain in control and send messages themselves from Gmail.

## Data Use Statement

OmniRush.ai uses Google Workspace data only to provide user-requested features, such as reading calendar context, reading explicitly selected Drive files, and creating Gmail drafts. OmniRush.ai does not sell Google user data, use Google user data for advertising, or use Google user data to train generalized AI models. Desktop OAuth tokens are stored locally using encrypted OS storage when available.

## Deployment Mode

The default desktop flow uses a Google Desktop OAuth client with PKCE and a loopback redirect. The desktop app exchanges authorization codes directly with Google and stores user tokens locally in encrypted OS storage.

For installed desktop apps, Google may provide both a `client_id` and `client_secret`. In this context, the `client_secret` is client metadata, not a confidential backend secret, because any value shipped in a desktop binary can be extracted. It is acceptable for official OmniRush.ai desktop builds to include the OmniRush.ai-owned Google Desktop OAuth client metadata, while user access tokens and refresh tokens must remain protected and must never be committed.

For local development, pass `OMNIRUSH_GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET` from the Google Cloud desktop client metadata instead of committing it to source. This keeps source checkouts and forks from accidentally reusing the official OmniRush.ai OAuth client metadata unless they opt in explicitly.

## Demo Video Script

Google's verification video should show the OAuth consent flow and each requested sensitive/restricted scope in use.

1. Start OmniRush.ai Desktop with the Google Workspace desktop OAuth client metadata:

   ```bash
   OMNIRUSH_GOOGLE_WORKSPACE_OAUTH_CLIENT_ID="929071212606-pmkqimjhm2tnp68kbklnout0irllj99h.apps.googleusercontent.com" \
   OMNIRUSH_GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET="<desktop-client-secret-from-google-cloud>" \
   pnpm dev
   ```

2. Open `Settings -> Extensions -> Google Workspace`.

3. Show the extension panel describing Phase 1 capabilities:
   - Calendar read.
   - Gmail drafts.
   - Selected Drive files.

4. Click `Connect with Google`.

5. Show the Google OAuth consent screen, including the app name `OmniRush.ai` and requested scopes.

6. Approve access with a test account.

7. Return to OmniRush.ai and show the connected account email.

8. Click `Test connection` and show profile + Calendar read access verified.

9. Click `Run scope smoke test` and show the success state, including the created Drive file and Gmail draft IDs. This verifies all requested Phase 1 scopes:
   - Calendar read through the Calendar API.
   - Drive selected/app-created file access by creating and reading `OmniRush.ai Google Workspace smoke test.txt`.
   - Gmail compose access by creating `OmniRush.ai Google Workspace smoke test draft` in Gmail drafts.

10. Open Google Drive and show the created smoke-test file.

11. Open Gmail drafts and show the created smoke-test draft. State that OmniRush.ai created a draft only and did not send email automatically.

12. Click `Disconnect` in OmniRush.ai and state that OmniRush.ai revokes the Google OAuth token and removes the local encrypted token vault entry.

## Daytona Recording Plan

Use Daytona for a clean, repeatable Electron recording:

```bash
bash .devcontainer/test-on-daytona.sh feature/google-workspace-phase-1 --record-video --recording-name google-workspace-oauth-phase-1
```

Then open the noVNC URL printed by the script, sign in to the Google test account when the OAuth browser opens, and complete the script above while recording.

If the sandbox does not have the Google OAuth client metadata in the environment, restart Electron with:

```bash
OMNIRUSH_GOOGLE_WORKSPACE_OAUTH_CLIENT_ID="929071212606-pmkqimjhm2tnp68kbklnout0irllj99h.apps.googleusercontent.com" \
OMNIRUSH_GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET="<desktop-client-secret-from-google-cloud>" \
bash /opt/omnirush-daytona/start-daytona-electron.sh --detach
```

## Current Verification Blockers

- `gmail.compose` is a restricted Gmail scope. Google may require restricted-scope verification and possibly additional security review.
- The privacy policy source includes Google Workspace data-use language, but it must be deployed publicly before submitting verification.
