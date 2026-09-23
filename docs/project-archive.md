# Project archive

When a chat runs in a folder that is a git project, OmniRush.ai keeps an
encrypted copy of the whole project folder on omnirush.ai: when the chat
starts, after every completed turn, and once more when the chat goes quiet,
is deleted, or the app quits. With that copy, the project can be restored
as it was after any turn of the chat, and as it was left at the end. This
page describes what the desktop app uploads, when it uploads it, the size
limits, and how to opt out.

The project archive is separate from the workspace collector described in
[workspace-collector-privacy.md](workspace-collector-privacy.md). The
collector keeps running for every chat and sends scrubbed snapshots, each
capped in size (a chat has no total storage limit). The archive is a raw
copy of the folder: file contents are not scrubbed. omnirush.ai accepts up
to 100 GiB per upload and 100 GiB per chat (see [Size limits](#size-limits)).

## When it runs

All of these must be true:

- You are signed in to omnirush.ai in the app.
- Project upload is on for your account. It is on by default for every
  account, and there is no switch for it in the omnirush.ai console. To opt
  out, email info@omnirush.ai (see [Turning it off](#turning-it-off)).
- The folder the chat started in contains `.git` (a git repository, a
  worktree or a submodule), or sits inside a git repository, for example
  `packages/app` in a repository whose `.git` is two folders up. In that
  case only the chat's folder is archived, with all its subfolders; the
  repository's `.git` and the rest of the repository are not; only its
  current branch, commit, remote address (without any login in it),
  whether it has uncommitted changes and the folder's path inside it
  are recorded. A `.git` in any account's home folder (a dotfiles
  repository), on this disk, another disk, a network share or a WSL
  distribution, at the root of a disk or network share, or in a system
  or application folder (such as `/usr`, `/Applications`, `C:\Windows`,
  `C:\Program Files` or a WSL distribution's `/etc`) does not count.
  Nothing is archived for other folders.
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
  The copy is taken once the app has had no new message for about two
  seconds (at most ten seconds after the chat's first message), so opening
  and starting several chats in a row is not slowed down by it. A chat
  that already has this full copy, for example one you continue after
  restarting the app, does not get a second one.
- **After each turn that changed something:** only the files that were
  added or changed, plus the list of deleted paths. A turn that changed
  nothing uploads nothing.
- **Once more after the last turn (a final copy):** the files added,
  changed or deleted since the previous upload, in the same form, when the
  folder changed after the chat's last completed turn, for example because
  you edited files yourself, or a turn was stopped or failed before it
  finished. The app looks for such changes:
  - when the chat has had no new message for 10 minutes after a turn (a
    new message before then cancels it);
  - when a turn ends without completing (the app stops following it after
    an hour, or loses track of it);
  - when you delete the chat in the app, if its folder still exists;
  - when you quit the app. The app spends at most about 5 seconds on this
    while it shuts down; the copy is uploaded the next time the app runs;
  - when the app starts again, for chats archived in the last 7 days:
    anything the last shutdown did not get to, and changes made while the
    app was closed (for the most recent chat on each folder).

  A folder that did not change uploads nothing. A final copy is only taken
  for a chat that already has its full copy, and only while the folder is
  still one that qualifies (see [When it runs](#when-it-runs)).

Each upload records the chat and its turn number, so the folder can be
rebuilt as it was after any turn. A final copy carries the number of the
last completed turn again and is marked as final, with what prompted it.

## Size limits

omnirush.ai accepts up to 100 GiB in a single upload, and up to 100 GiB of
uploads in total for one chat. The app does not check the size itself. If
an upload is over either limit, omnirush.ai refuses it and the app stops
archiving that chat. The chat itself carries on as usual, and other chats
are still archived.

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
uploaded in the background, one at a time, on a separate thread, so
switching between chats stays responsive while an archive is packed. Until an archive is uploaded,
it waits in the app's state folder (`omnirush-archive/`). An upload that is
interrupted resumes from where it stopped the next time the app runs. When
the app quits, uploads in progress stop at once; the final copies packed
while it shuts down are uploaded the next time it runs. An
archive that still has not been uploaded after 7 days is deleted, and
archiving stops for that chat. The next chat starts over with a new full
copy. Archive problems are written to the app's log. They never show up
as chat errors.

## Turning it off

- **Opt out by email.** Write to info@omnirush.ai and ask for project
  upload to be turned off for your account. There is no switch for it in
  the omnirush.ai console. Once your opt-out is recorded, omnirush.ai
  deletes the archives it holds for you. The app stops archiving the next
  time it contacts omnirush.ai (at the next upload, or when a new chat
  starts), and archives waiting on your computer are deleted, not
  uploaded. While project upload is off, the app checks again when a new
  chat starts, at most once every 10 minutes. If you later ask for it to
  be turned back on, chats started after that are archived without
  restarting the app.
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
