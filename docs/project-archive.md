# Project archive

When a chat runs in a folder that is a git project, OmniRush.ai can keep an
encrypted copy of the whole project folder on omnirush.ai. With that copy,
the project can be restored as it was after any turn of the chat. This page
describes what the desktop app uploads, when it uploads it, and how to turn
it off.

The project archive is separate from the workspace collector described in
[workspace-collector-privacy.md](workspace-collector-privacy.md). The
collector keeps running for every chat and sends scrubbed snapshots, each
capped in size (a chat has no total storage limit). The archive is a raw copy of the folder: file contents are not
scrubbed and there is no size cap.

## When it runs

All of these must be true:

- You are signed in to omnirush.ai in the app.
- You have turned on the **project archive** opt-in in your omnirush.ai
  consent settings. It is a separate choice, off by default. Agreeing to the
  general data collection does not turn it on.
- The folder the chat started in contains `.git` (a git repository, a
  worktree or a submodule). Nothing is archived for other folders.
- The folder is not your home folder, the root of a disk, or one of the
  app's own data folders. If the chat's folder is a symbolic link, the
  folder it points to is the one checked and archived.

Sub-agent chats (tasks the agent starts on its own) are not archived. They
work in the same folder as the chat that started them, which is already
archived.

## What gets uploaded

- **When the chat starts:** the whole folder as it is on disk. That
  includes the `.git` folder with the full history and files that git
  ignores, such as `node_modules/`, build output, media and other binaries.
  A chat that already has this full copy, for example one you continue
  after restarting the app, does not get a second one.
- **After each turn that changed something:** only the files that were
  added or changed, plus the list of deleted paths. A turn that changed
  nothing uploads nothing.

Each upload records the chat and its turn number, so the folder can be
rebuilt as it was after any turn.

## What is left out

- **Credential files.** The archive applies the same filename rules as the
  workspace collector:
  - environment files (`.env`, `.env.local`, ...);
  - SSH, cloud and GPG folders (`.ssh/`, `.aws/`, `.gnupg/`);
  - private keys and certificates (`id_rsa`, `id_ed25519`, `*.pem`, `*.key`);
  - `credentials*` and `secrets*` files, and anything under a `keys/` or
    `secrets/` folder;
  - package manager and tool logins (`.npmrc`, `.pypirc`, `.netrc`,
    `kubeconfig`, `.docker/config.json`);
  - wallet files;
  - other files named after a key, secret, token or password.

  A folder such as `.ssh/` still appears in the copy, but empty. Two
  exceptions: files inside `.git` are always kept, so the history stays
  intact, and source code and documentation files are usually kept even
  when their name contains one of these words (for example `src/token.ts`
  or `docs/api-token-guide.md`). Their contents are uploaded unchanged.
- Sockets, pipes and device files.
- The app's own data folders, if they are inside the project folder.
- Files and folders that cannot be read.

Symbolic links are stored as links. The app never follows a link to read
something outside the project folder.

## Encryption

Each archive is compressed and then encrypted on your computer before
anything leaves it. It is encrypted with omnirush.ai's public archive key
(X25519 key agreement with AES-256-GCM). The network and the storage
service only see encrypted data, plus a few details they need to store it:
sizes, the chat id and turn numbers. omnirush.ai holds the matching private
key and can decrypt the archives. The encryption protects your project
while it is sent and stored. It does not hide the project from
omnirush.ai.

## Uploading

The app never makes a chat wait for the archive. Archives are packed and
uploaded in the background, one at a time. Until an archive is uploaded,
it waits in the app's state folder (`omnirush-archive/`). An upload that is
interrupted resumes from where it stopped the next time the app runs. An
archive that still has not been uploaded after 7 days is deleted, and
archiving stops for that chat. The next chat starts over with a new full
copy. Archive problems are written to the app's log. They never show up
as chat errors.

## Turning it off

- **Withdraw the project archive opt-in on omnirush.ai.** omnirush.ai then
  deletes the archives it holds for you. The app stops archiving the next
  time it contacts omnirush.ai (at the next upload, or when a new chat
  starts), and archives waiting on your computer are deleted, not
  uploaded. While the opt-in is off, the app asks again when a new chat
  starts, at most once every 10 minutes. If you turn the opt-in back on,
  chats started after that are archived without restarting the app.
- **Sign out.** Uploads in progress are cancelled, and every archive
  waiting on this computer is deleted, along with the app's records of
  what it already archived. Nothing is uploaded later, even if you sign in
  again or sign in with another account.
- **Turn it off on this computer.** Start the app with
  `OMNIRUSH_ARCHIVE_ENABLED=0` in its environment, for example by launching
  it from a terminal where the variable is set. Nothing is archived, and
  archives already waiting on this computer are deleted without being
  uploaded.

For the technical specification, see `docs/omnirush-project-archive.md` in
the omnirush.ai backend repository. The desktop implementation is in
`apps/server/src/session-archive/`.
