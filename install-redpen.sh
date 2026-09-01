#!/usr/bin/env bash
set -euo pipefail

command -v node >/dev/null 2>&1 || { echo "Node.js 20 or newer is required." >&2; exit 1; }
command -v git >/dev/null 2>&1 || { echo "Git is required." >&2; exit 1; }

host_name="${REDPEN_HOST:-claude}"
project_root="${REDPEN_PROJECT:-$PWD}"
temp_root="$(mktemp -d "${TMPDIR:-/tmp}/redpen-install.XXXXXX")"
checkout="$temp_root/redpen"

cleanup() {
  rm -rf "$temp_root"
}
trap cleanup EXIT INT TERM

git clone --depth 1 https://github.com/Benzenp/redpen.git "$checkout"
(
  cd "$checkout"
  corepack pnpm install --frozen-lockfile
  corepack pnpm run build
  cd apps/cli
  corepack pnpm pack --pack-destination "$temp_root"
)

package_path="$(find "$temp_root" -maxdepth 1 -name 'redpen-cli-*.tgz' -print -quit)"
if [[ -z "$package_path" ]]; then
  echo "Redpen CLI package was not created." >&2
  exit 1
fi
npm install --global "$package_path"
redpen install --host "$host_name" --project "$project_root"
echo "Redpen installed. Restart your coding agent, then run /redpen."
