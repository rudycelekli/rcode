#!/bin/sh
# rcode installer: curl -fsSL https://raw.githubusercontent.com/rudycelekli/rcode/main/install.sh | sh
set -eu
REPO="rudycelekli/rcode"
DEST="${RCODE_INSTALL_DIR:-$HOME/.rcode/bin}"
os=$(uname -s | tr '[:upper:]' '[:lower:]'); arch=$(uname -m)
case "$arch" in x86_64|amd64) arch=x64 ;; arm64|aarch64) arch=arm64 ;; *) echo "unsupported arch: $arch"; exit 1 ;; esac
case "$os" in darwin|linux) ;; *) echo "unsupported OS: $os (use: bun install -g github:$REPO)"; exit 1 ;; esac
asset="rcode-$os-$arch"
tag="${RCODE_VERSION:-$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1)}"
[ -n "$tag" ] || { echo "No release found. Install from source: bun install -g github:$REPO"; exit 1; }
base="https://github.com/$REPO/releases/download/$tag"
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
echo "Downloading rcode $tag ($asset)…"
curl -fsSL "$base/$asset" -o "$tmp/rcode"
curl -fsSL "$base/SHA256SUMS" -o "$tmp/SHA256SUMS"
want=$(grep " $asset\$" "$tmp/SHA256SUMS" | cut -d' ' -f1)
if command -v sha256sum >/dev/null; then got=$(sha256sum "$tmp/rcode" | cut -d' ' -f1); else got=$(shasum -a 256 "$tmp/rcode" | cut -d' ' -f1); fi
[ "$want" = "$got" ] || { echo "checksum mismatch — aborting"; exit 1; }
mkdir -p "$DEST" && mv "$tmp/rcode" "$DEST/rcode" && chmod +x "$DEST/rcode"
echo "Installed $DEST/rcode"
case ":$PATH:" in *":$DEST:"*) ;; *) echo "Add to your PATH:  export PATH=\"$DEST:\$PATH\"" ;; esac
echo "Next: rcode setup"
