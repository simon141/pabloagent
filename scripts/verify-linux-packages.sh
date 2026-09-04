#!/usr/bin/env bash
#
# Guards the Linux package properties that fail silently: the package name
# users type into apt and dnf, the version, the WebKitGTK runtime dependency
# the Tauri CLI injects, and the installed binary.
#
# Usage: scripts/verify-linux-packages.sh <path-to-deb> <path-to-rpm>

set -euo pipefail

DEB=${1:?usage: scripts/verify-linux-packages.sh <path-to-deb> <path-to-rpm>}
RPM=${2:?usage: scripts/verify-linux-packages.sh <path-to-deb> <path-to-rpm>}

[ -f "$DEB" ] || { echo "FAIL: no such deb: $DEB"; exit 1; }
[ -f "$RPM" ] || { echo "FAIL: no such rpm: $RPM"; exit 1; }

version=$(node -p "JSON.parse(require('fs').readFileSync('src-tauri/tauri.conf.json')).version")

field() { dpkg-deb -f "$DEB" "$1"; }

package=$(field Package)
[ "$package" = pablo-agent ] || { echo "FAIL: deb Package is $package, expected pablo-agent."; exit 1; }

deb_version=$(field Version)
[ "$deb_version" = "$version" ] || { echo "FAIL: deb Version is $deb_version, expected $version."; exit 1; }

deb_arch=$(field Architecture)
case "$deb_arch" in
  amd64|arm64) ;;
  *) echo "FAIL: deb Architecture is $deb_arch."; exit 1 ;;
esac

field Depends | grep -qF libwebkit2gtk-4.1-0 || {
  echo "FAIL: deb Depends lacks libwebkit2gtk-4.1-0: $(field Depends)"
  echo
  echo "The Tauri CLI injects it when bundling on a Linux host. Check the runner."
  exit 1
}

# Tauri writes tar members without a ./ prefix, so match the bare path.
contents=$(dpkg-deb -c "$DEB")
echo "$contents" | grep -q 'usr/bin/pablo$' || { echo "FAIL: deb lacks usr/bin/pablo."; exit 1; }
echo "$contents" | grep -q 'usr/share/applications/.*\.desktop$' || { echo "FAIL: deb lacks a .desktop file."; exit 1; }
echo "$contents" | grep -q 'usr/share/icons/hicolor/128x128/apps/pablo.png$' || { echo "FAIL: deb lacks the 128x128 icon."; exit 1; }

read -r name rpm_version release rpm_arch license <<<"$(rpm -qp --qf '%{NAME} %{VERSION} %{RELEASE} %{ARCH} %{LICENSE}\n' "$RPM")"
[ "$name" = pablo-agent ] || { echo "FAIL: rpm Name is $name, expected pablo-agent."; exit 1; }
[ "$rpm_version" = "$version" ] || { echo "FAIL: rpm Version is $rpm_version, expected $version."; exit 1; }
[ "$license" = MIT ] || { echo "FAIL: rpm License is '$license', expected MIT (bundle.license in tauri.conf.json)."; exit 1; }
case "$rpm_arch" in
  x86_64|aarch64) ;;
  *) echo "FAIL: rpm Arch is $rpm_arch."; exit 1 ;;
esac

rpm -qpR "$RPM" | grep -qF 'libwebkit2gtk-4.1.so.0()(64bit)' || {
  echo "FAIL: rpm Requires lacks libwebkit2gtk-4.1.so.0()(64bit):"
  rpm -qpR "$RPM" | sed 's/^/  /'
  exit 1
}

files=$(rpm -qpl "$RPM")
echo "$files" | grep -qx /usr/bin/pablo || { echo "FAIL: rpm lacks /usr/bin/pablo."; exit 1; }
echo "$files" | grep -q '^/usr/share/applications/.*\.desktop$' || { echo "FAIL: rpm lacks a .desktop file."; exit 1; }

echo "OK: $package $deb_version ($deb_arch), $name $rpm_version-$release ($rpm_arch), license $license."
