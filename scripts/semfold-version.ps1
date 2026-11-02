param(
  [string]$Smif = "smif",
  [switch]$AllowDirty,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
  $resolved = Get-Command $Smif -ErrorAction SilentlyContinue
  if (-not $resolved) {
    if ($Smif -ne "smif") {
      throw "Semifold CLI not found: $Smif"
    }
    $cargoHome = if ($env:CARGO_HOME) { $env:CARGO_HOME } else { Join-Path $env:USERPROFILE ".cargo" }
    $candidate = Join-Path $cargoHome "bin\smif.exe"
    if (-not (Test-Path $candidate)) {
      cargo install semifold --version 0.3.4 --locked
      if ($LASTEXITCODE -ne 0) { throw "cargo install semifold failed" }
    }
    $resolved = Get-Item $candidate
  }
  $smifPath = if ($resolved.Source) { $resolved.Source } else { $resolved.FullName }

  if (-not $DryRun -and -not $AllowDirty) {
    $dirty = @(git status --porcelain)
    if ($LASTEXITCODE -ne 0) { throw "git status failed" }
    if ($env:GITHUB_ACTIONS -eq "true") {
      # CI intentionally has generated frontend/analyzer artifacts before Tauri
      # invokes this hook. The release workflow stages only explicit version files.
      $AllowDirty = $true
    }
    if ($dirty.Count -gt 0) {
      if (-not $AllowDirty) {
        throw "Working tree is not clean. Commit code changes first, or pass -AllowDirty explicitly:`n$($dirty -join "`n")"
      }
    }
  }

  $subject = (git log -1 --pretty=%s).Trim()
  if (-not $subject) { $subject = "Automated KDock build" }
  $tag = "fix"
  if ($subject -match '^(feat|fix|perf|refactor|chore)(\([^)]+\))?!?:') {
    $tag = $Matches[1]
  }
  $short = (git rev-parse --short=7 HEAD).Trim()
  $suffix = if ($env:GITHUB_RUN_ID) { $env:GITHUB_RUN_ID } else { Get-Date -Format "yyyyMMddHHmmss" }
  $name = ("auto-$short-$suffix" -replace '[^0-9A-Za-z._-]', '-').ToLowerInvariant()

  $commitArgs = @(
    "commit",
    "--name", $name,
    "--package", "nodejs-kdock=patch",
    "--package", "rust-kdock=patch",
    "--tag", $tag,
    "--summary", $subject
  )
  if ($DryRun) { $commitArgs += "--dry-run" }
  & $smifPath @commitArgs
  if ($LASTEXITCODE -ne 0) { throw "smif commit failed with exit code $LASTEXITCODE" }

  $versionArgs = @("version", "--allow-dirty")
  if ($DryRun) { $versionArgs += "--dry-run" }
  & $smifPath @versionArgs
  if ($LASTEXITCODE -ne 0) { throw "smif version failed with exit code $LASTEXITCODE" }

  if (-not $DryRun) {
    $version = (node scripts/sync-app-version.mjs).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $version) { throw "app version sync failed" }
    Write-Output "KDOCK_VERSION=$version"
    if ($env:GITHUB_OUTPUT) {
      "version=$version" | Out-File -FilePath $env:GITHUB_OUTPUT -Append -Encoding utf8
    }
  }
} finally {
  Pop-Location
}
