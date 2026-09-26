# Project archive

When a chat runs in a folder that is a git project, OmniRush.ai keeps an
encrypted copy of the whole project folder on omnirush.ai: when the chat
starts, after every completed turn, and once more when the chat goes quiet,
is deleted, or the app quits. In any other folder, it uploads the files the
agent opens or changes there, as they are, including binaries. With that
copy, the chat's work can be restored as it was after any turn of the chat,
and as it was left at the end. This page describes what the desktop app
uploads, when it uploads it, the size limits, and how to opt out.

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
  For any other folder, see [Other folders](#other-folders).
- The folder is not your home folder, the root of a disk, or one of the
  app's own data folders. If the chat's folder is a symbolic link, the
  folder it points to is the one checked and archived.

Sub-agent chats (tasks the agent starts on its own) are not archived. They
work in the same folder as the chat that started them, which is already
archived.

## Other folders

In any other folder, it uploads the files the agent opens or changes there,
as they are, including binaries. That means every file in the chat's
folder, or in a folder inside it, that during the chat:

- the agent opens, reads, writes or edits with its tools (a sub-agent
  counts for the chat that started it), or
- is created, changed or deleted, for example by a command the agent runs.

Nothing else in the folder is uploaded: not the files the agent does not
touch, and not the content of a folder the agent only lists. Nothing outside
the chat's folder is uploaded, or read by the app for the upload, even when
the agent opens it, or a symbolic link in the folder points to it (such a
link is skipped; a link to a file inside the folder counts as that file).
The same files are left out as for a git project (see
[What is left out](#what-is-left-out)), such as credential files.

The first upload happens at the end of the first turn in which the agent
touched a file (or at the first final copy, see
[What gets uploaded](#what-gets-uploaded)) and holds the touched files. Each
later upload holds the touched files that were added or changed since, and
lists the touched files that were deleted. The list of touched files is kept
on your computer, so a chat you continue after restarting the app keeps it,
and changes made to those files while the app was closed are uploaded when
it starts again.

This is a setting on omnirush.ai too: while it is off for your account,
nothing is uploaded for these folders, and no list of touched files is
kept. If omnirush.ai turns on archiving every folder for your account (see
below), a folder without `.git` is copied whole instead.

### Archiving every folder

Archiving every folder is a setting on omnirush.ai, and it is off. It
applies only to accounts that accepted the omnirush.ai terms that describe
it (the 2026-09-24 version or later); everyone else stays on git projects
only. While it is off for your account, no folder without `.git` is copied
whole, and nothing else changes, apart from the check described below.
Once it is on for your account, a chat folder without `.git` is archived
the same way as a git project, including binaries and large files. Files
its `.gitignore` files exclude are left out, as in a git project.
A folder inside your home folder, such as `~/projects/app` or
`~/Documents/report`, can be archived. A folder without `.git` is never
archived when it is your home folder or a folder above it, the root of a
disk or network share, or another account's home folder or a shared folder
beside yours (such as `/Users/Shared` or `C:\Users\Public`). Nor when it
is, or is inside, one of these (checked on the path as given and on the
folder it resolves to through symbolic links):

- a credential folder, wherever it is: `.ssh`, `.aws`, `.gnupg`, `.kube`,
  `.docker`, `.azure`, `.password-store`, `Keychains` or `.config/gcloud`,
  and any folder the credential rules below leave out as a whole, such as a
  `keys`, `secrets` or `credentials` folder, a `.env...` folder,
  `node_modules` or `.git`;
- an app-data folder: the app's own data folders, any folder in your home
  folder whose name starts with a dot (such as `.config`, `.local` or
  `.cache`), `~/Library` on macOS (including iCloud Drive's
  `~/Library/Mobile Documents`), `~/snap` on Linux, `AppData` on Windows,
  and `Library/Application Support` anywhere. The same applies in another
  account's home folder;
- a system or app folder outside your home folder: `/System`, `/Library`,
  `/Applications`, `/private` (which holds `/tmp`), `/usr`, `/bin`,
  `/sbin`, `/etc`, `/var`, `/opt` and `/cores` on macOS; `/usr`, `/bin`,
  `/sbin`, `/etc`, `/var`, `/opt`, `/root`, `/proc`, `/sys`, `/dev`,
  `/boot`, `/lib`, `/lib64`, `/run`, `/snap` and `/nix` on Linux;
  `Windows`, `Windows.old`, `Program Files`, `Program Files (x86)`,
  `ProgramData`, `$Recycle.Bin`, `System Volume Information`, `Recovery`
  and `PerfLogs` on any Windows drive.

The same limits apply to the files the agent touches in a folder without
`.git`: nothing is uploaded from such a folder. These limits apply to folders
without `.git` only. A git project is archived as it is today, under the
conditions in [When it runs](#when-it-runs), wherever it is, including inside
one of these folders.

To learn whether these settings are on, the app asks omnirush.ai when a chat
starts in a folder without `.git` that passes these limits: one request,
with no retries, and any failure counts as off. The answer is kept for five
minutes, so starting several chats sends one request, and a change on
omnirush.ai reaches the app within five minutes, without an app update.
While a setting is off for your account, a chat already archived that way
uploads nothing more; its next upload after it is back on includes every
change made meanwhile. If omnirush.ai refuses an upload because the setting
is off, the app stops archiving that chat.

## What gets uploaded

This section describes a git project (and a folder archived whole). In
another folder, the same moments apply to the files the agent touched
there, as described in [Other folders](#other-folders): nothing is uploaded
when the chat starts, and each upload holds only touched files.

- **When the chat starts:** the whole folder as it is on disk. That
  includes the `.git` folder with the full history, media and other
  binaries. Files and folders that git ignores (your `.gitignore` files,
  `.git/info/exclude` and your global excludes file), such as
  `node_modules/`, build output, virtual environments and caches, are left
  out: they can be rebuilt from the project. The `.gitignore` files
  themselves are kept.
  The copy is taken once the app has had no new message for about two
  seconds (at most ten seconds after the chat's first message), so opening
  and starting several chats in a row is not slowed down by it. If the
  app cannot read the chat from its engine then (the engine can still be
  starting after an app restart), it tries again after 1, 2, 5 and 10
  minutes, and with the chat's next message or completed turn, so a chat
  whose first turn runs for hours still gets its full copy. A chat
  that already has this full copy, for example one you continue after
  restarting the app, does not get a second one.
- **After each turn that changed something:** only the files that were
  added or changed, plus the list of deleted paths. A turn that changed
  nothing uploads nothing. The app follows a turn for as long as it runs
  (up to 24 hours), so a turn of several hours gets its upload when it
  ends.
- **Once more after the last turn (a final copy):** the files added,
  changed or deleted since the previous upload, in the same form, when the
  folder changed after the chat's last completed turn, for example because
  you edited files yourself, or a turn was stopped or failed before it
  finished. The app looks for such changes:
  - when the chat has had no new message for 10 minutes after a turn (a
    new message before then cancels it, also one sent while the turn was
    still finishing);
  - when a turn ends without the app seeing it complete (the app stops
    following a turn after 24 hours, or on an unexpected error; it waits
    for an engine that stops answering or restarts);
  - when you delete the chat in the app, if its folder still exists;
  - when you quit the app. The app spends at most about 5 seconds on this
    while it shuts down; the copy is uploaded the next time the app runs;
  - when the app starts again, for chats you sent a message in, or that
    finished a turn, in the last 7 days (a final copy does not count as
    use, so a chat you left gets none a week after its last turn):
    anything the last shutdown did not get to, and changes made while the
    app was closed (for the chat used most recently on each folder, and
    for every chat whose touched files are uploaded).

  A folder that did not change uploads nothing. A final copy is only taken
  for a chat that already has its full copy, and only while the folder is
  still one that qualifies (see [When it runs](#when-it-runs)). When
  several chats work in the same folder, each has its own copies, so one
  chat's final copy (like its turn uploads) also holds what another chat
  changed in the folder since that chat's previous upload.

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

- **Files git ignores.** Anything your `.gitignore` files,
  `.git/info/exclude` or your global git excludes file exclude, such as
  `node_modules/`, `dist/`, virtual environments and caches, because it can
  be rebuilt. An ignored folder is skipped as a whole without being read.
  Files git tracks are always kept, even when an ignore rule matches them,
  and so are the `.git` folder and the `.gitignore` files. In a folder
  without `.git`, its `.gitignore` files apply the same way. A file that
  becomes ignored during a chat is removed from the copy with the next
  upload; one that stops being ignored is added back.
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
