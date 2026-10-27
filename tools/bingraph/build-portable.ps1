param(
  [string]$PythonVersion = "3.13.13",
  [string]$OutDir = "",
  [string]$GraphvizBin = "",
  [switch]$NoGraphviz,
  [switch]$KeepStage
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not $OutDir) { $OutDir = Join-Path $root "resources/bingraph" }
$OutDir = [IO.Path]::GetFullPath($OutDir)
$stage = Join-Path $env:TEMP ("kdock-bingraph-" + [guid]::NewGuid().ToString("N"))
$pythonStage = Join-Path $stage "python"
$site = Join-Path $stage "site-packages"
$pyZip = Join-Path $stage "python.zip"
New-Item -ItemType Directory -Force $stage,$pythonStage,$site | Out-Null

function Download($url, $dst) {
  New-Item -ItemType Directory -Force (Split-Path $dst) | Out-Null
  Invoke-WebRequest -Uri $url -OutFile $dst -UseBasicParsing
}

try {
  Write-Host "== Python $PythonVersion (embeddable) =="
  Download "https://www.python.org/ftp/python/$PythonVersion/python-$PythonVersion-embed-amd64.zip" $pyZip
  Expand-Archive -LiteralPath $pyZip -DestinationPath $pythonStage -Force
  $pth = Get-ChildItem $pythonStage -Filter "python*._pth" | Select-Object -First 1
  if (-not $pth) { throw "Python embeddable package has no _pth file" }
  $parts = $PythonVersion.Split('.')
  # arpy (an angr dependency) ships only an sdist, and its legacy setuptools
  # backend imports setuptools from the *active* interpreter. Embeddable
  # Python disables normal site processing via _pth, so explicitly expose the
  # final dependency directory and a separate, ephemeral build-tools directory.
  # Build tools stay out of the shipped package while remaining available to
  # sdist builds through --no-build-isolation.
  $buildTools = Join-Path $stage "build-tools"
  New-Item -ItemType Directory -Force $buildTools | Out-Null
  # Paths in _pth are relative to python.exe and survive moving the portable
  # package to another directory or drive.
  $runtimePth = @("python$($parts[0])$($parts[1]).zip", ".", "..\site-packages")
  $lines = @($runtimePth + @("..\build-tools", "import site"))
  Set-Content -LiteralPath $pth.FullName -Value $lines -Encoding ascii

  Write-Host "== dependencies (locked) =="
  $src = Join-Path $root "tools/bingraph/requirements.txt"
  if (-not (Test-Path $src)) { throw "missing $src" }
  $py = Join-Path $pythonStage "python.exe"
  $pinnedBuildTools = @("setuptools==84.2.1", "wheel==0.48.0")
  # embeddable Python has no pip. Use uv when available; otherwise bootstrap
  # pip with the official get-pip.py, so a release install can repair itself
  # without assuming the user has Python or uv.
  $uv = Get-Command uv.exe -ErrorAction SilentlyContinue
  $native = "angr,unicorn,pyvex,capstone,cffi,pydantic-core,z3-solver,lmdb,msgspec,psutil"
  if ($uv) {
    & $uv.Source pip install --python $py --target $buildTools --no-cache @pinnedBuildTools | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "build tool installation failed" }
    & $uv.Source pip install --python $py --target $site --no-cache --no-build-isolation "--only-binary=$native" -r $src | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "dependency installation failed" }
  } else {
    $getPip = Join-Path $stage "get-pip.py"
    Download "https://bootstrap.pypa.io/get-pip.py" $getPip
    & $py $getPip --no-warn-script-location | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "pip bootstrap failed" }
    & $py -m pip install --target $buildTools --no-cache-dir @pinnedBuildTools | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "build tool installation failed" }
    & $py -m pip install --target $site --no-cache-dir --no-build-isolation "--only-binary=$native" -r $src | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "dependency installation failed" }
  }

  Write-Host "== KDock launcher =="
  $launcher = Join-Path $stage "launcher"
  New-Item -ItemType Directory -Force $launcher | Out-Null
  Copy-Item -Recurse -Force (Join-Path $root "tools/bingraph/src/*") $launcher
  # KDock starts python.exe directly, no .cmd wrapper needed.

  # Runtime JSON does not need Graphviz. Only include it when explicitly
  # requested; otherwise keep the portable package small and avoid shipping
  # an EPL component that KDock never invokes for JSON analysis.
  if (-not $NoGraphviz) {
    if (-not $GraphvizBin) {
      $gv = Get-Command dot.exe -ErrorAction SilentlyContinue
      if ($gv) { $GraphvizBin = Split-Path $gv.Source }
    }
    if ($GraphvizBin -and (Test-Path (Join-Path $GraphvizBin "dot.exe"))) {
      New-Item -ItemType Directory -Force (Join-Path $stage "graphviz/bin") | Out-Null
      Copy-Item (Join-Path $GraphvizBin "*") (Join-Path $stage "graphviz/bin") -Recurse -Force
      Write-Host "bundled Graphviz from $GraphvizBin"
    } else {
      Write-Warning "Graphviz not found; runtime JSON does not need it."
    }
  }

  $version = [ordered]@{
    name = "pybingraph-native"
    version = "0.1.0"
    python = $PythonVersion
    builtAt = (Get-Date).ToUniversalTime().ToString("o")
    dependencies = "tools/bingraph/requirements.txt"
  } | ConvertTo-Json
  Set-Content -LiteralPath (Join-Path $stage "VERSION.json") -Value $version -Encoding utf8

  $check = & $py -c "import sys, setuptools; sys.path.insert(0, r'$site'); import angr, bingraph; print(sys.version.split()[0]); print(angr.__version__); print(bingraph.__version__)"
  if ($LASTEXITCODE -ne 0) { throw "portable analyzer self-check failed" }
  Write-Host ($check -join " / ")

  # run.py is the stable KDock entry point; keep it at the package root so
  # launcher updates do not require reinstalling site-packages.
  Copy-Item -LiteralPath (Join-Path $root "tools/bingraph/src/run.py") -Destination (Join-Path $stage "run.py") -Force

  # Keep the package notes and dependency licence inventory next to the
  # binaries. Individual dist-info license files already live in site-packages.
  foreach ($doc in @("README.md", "THIRD_PARTY_NOTICES.md")) {
    $from = Join-Path $root "tools/bingraph/$doc"
    if (Test-Path $from) { Copy-Item -LiteralPath $from -Destination (Join-Path $stage $doc) -Force }
  }
  $licenseDir = Join-Path $stage "licenses"
  New-Item -ItemType Directory -Force $licenseDir | Out-Null
  Copy-Item -LiteralPath (Join-Path $pythonStage "LICENSE.txt") -Destination (Join-Path $licenseDir "PYTHON-3.13-LICENSE.txt") -Force
  foreach ($dist in Get-ChildItem $site -Directory -Filter "*.dist-info") {
    $files = Get-ChildItem $dist.FullName -Recurse -File -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -match "^(LICENSE|LICENCE|COPYING|NOTICE|AUTHORS)" }
    if (-not $files) { continue }
    $dest = Join-Path $licenseDir $dist.Name
    New-Item -ItemType Directory -Force $dest | Out-Null
    foreach ($file in $files) {
      $relative = $file.FullName.Substring($dist.FullName.Length).TrimStart("\\")
      $target = Join-Path $dest $relative
      New-Item -ItemType Directory -Force (Split-Path $target) | Out-Null
      Copy-Item -LiteralPath $file.FullName -Destination $target -Force
    }
  }
  Write-Host "license inventory -> $licenseDir"

  # These are only needed while installing sdists. Do not ship an extra copy
  # of pip/setuptools/wheel in the analyzer package, and restore the runtime
  # _pth so the moved package never points into the build staging directory.
  Remove-Item -LiteralPath $buildTools -Recurse -Force
  Remove-Item -LiteralPath $pyZip -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath (Join-Path $stage "get-pip.py") -Force -ErrorAction SilentlyContinue
  Set-Content -LiteralPath $pth.FullName -Value @($runtimePth + @("import site")) -Encoding ascii

  if (Test-Path $OutDir) { Remove-Item $OutDir -Recurse -Force }
  New-Item -ItemType Directory -Force (Split-Path $OutDir) | Out-Null
  Move-Item $stage $OutDir
  Write-Host "OK -> $OutDir"
} finally {
  if (-not $KeepStage -and (Test-Path $stage)) { Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue }
}
