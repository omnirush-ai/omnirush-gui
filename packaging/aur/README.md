# Arch Linux package

OmniRush.ai installs on Arch Linux (`x86_64` and `aarch64`) in two ways.

## 1. The `.pacman` package from a release (quickest)

Every GitHub release carries a pacman package per architecture, built by
electron-builder next to the `.deb` and `.AppImage`:

```bash
# x86_64
sudo pacman -U https://github.com/omnirush-ai/omnirush-gui/releases/download/v<version>/omnirush-linux-x86_64-<version>.pacman
# aarch64
sudo pacman -U https://github.com/omnirush-ai/omnirush-gui/releases/download/v<version>/omnirush-linux-aarch64-<version>.pacman
```

It installs the app under `/opt/OmniRush.ai`, like the `.deb`, and pacman pulls
in the runtime dependencies (the list is `pacman.depends` in
`apps/desktop/electron-builder.base.yml`).

## 2. The PKGBUILD in this directory (AUR)

`PKGBUILD` repackages the release tarball (`omnirush-linux-x64-<version>.tar.gz`
or `omnirush-linux-arm64-<version>.tar.gz`) under `/opt/omnirush`, and adds
`/usr/bin/omnirush`, a desktop entry, the icons and the license. Both
packages are named `omnirush`, so either replaces the other.

The committed `PKGBUILD` and `.SRCINFO` are templates (`pkgver=0.0.0`, zero
checksums). Render them for a release first:

```bash
scripts/aur/update-aur.sh v<version>   # sets pkgver and the sha256 sums
cd packaging/aur
makepkg -si                            # build and install
```

Do not commit the rendered files. `scripts/aur/publish-aur.sh` pushes them to
the AUR repository `omnirush` (needs `AUR_SSH_PRIVATE_KEY`); the
`aur-validate` workflow builds and checks them in an Arch container first.

Prerequisites: `sudo pacman -S --needed base-devel curl`.

## Checks

The `Linux Packages` workflow builds the x64 and arm64 installers on every
change to this packaging, installs the `.pacman` and a `makepkg` build of this
PKGBUILD on Arch Linux of the same CPU, and launches the app headless.

```bash
pacman -Ql omnirush    # what the package installed
omnirush               # start the app
```
