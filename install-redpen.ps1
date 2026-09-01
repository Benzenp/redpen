$ErrorActionPreference = "Stop"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js 20 or newer is required."
}
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  throw "Git is required."
}

$hostName = if ($env:REDPEN_HOST) { $env:REDPEN_HOST } else { "claude" }
$projectRoot = if ($env:REDPEN_PROJECT) { $env:REDPEN_PROJECT } else { (Get-Location).Path }
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("redpen-install-" + [guid]::NewGuid().ToString("N"))
$checkout = Join-Path $tempRoot "redpen"

try {
  New-Item -ItemType Directory -Path $tempRoot | Out-Null
  git clone --depth 1 https://github.com/Benzenp/redpen.git $checkout
  Push-Location $checkout
  try {
    corepack pnpm install --frozen-lockfile
    corepack pnpm run build
    Push-Location (Join-Path $checkout "apps/cli")
    try {
      corepack pnpm pack --pack-destination $tempRoot
    } finally {
      Pop-Location
    }
  } finally {
    Pop-Location
  }

  $package = Get-ChildItem $tempRoot -Filter "redpen-cli-*.tgz" | Select-Object -First 1
  if (-not $package) { throw "Redpen CLI package was not created." }
  npm install --global $package.FullName
  redpen install --host $hostName --project $projectRoot
  Write-Host "Redpen installed. Restart your coding agent, then run /redpen."
} finally {
  Remove-Item -Recurse -Force $tempRoot -ErrorAction SilentlyContinue
}
