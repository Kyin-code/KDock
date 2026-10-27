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
New-Item -ItemType Directory -Force $stage,$pythonStage,$site | Out-Null

function Download($url, $dst) {
  New-Item -ItemType Directory -Force (Split-Path $dst) | Out-Null
  Invoke-WebRequest -Uri $url -OutFile $dst -UseBasicParsing
}

try {
  Write-Host "== Python $PythonVersion (embeddable) =="
  $pyZip = Join-Path $stage "python.zip"
  Download "https://www.python.org/ftp/python/$PythonVersion/python-$PythonVersion-embed-amd64.zip" $pyZip
  Expand-Archive -LiteralPath $pyZip -DestinationPath $pythonStage -Force
  $pth = Get-ChildItem $pythonStage -Filter "python*._pth" | Select-Object -First 1
  if (-not $pth) { throw "Python embeddable package has no _pth file" }
  $parts = $PythonVersion.Split('.')
  $lines = @("python$($parts[0])$($parts[1]).zip", ".", "..\site-packages", "import site")
  Set-Content -LiteralPath $pth.FullName -Value $lines -Encoding ascii

  Write-Host "== dependencies (locked) =="
  $src = Join-Path $root "tools/bingraph/requirements.txt"
  if (-not (Test-Path $src)) { throw "missing $src" }
  $py = Join-Path $pythonStage "python.exe"
  # embeddable Python has no pip. Use uv when available; otherwise bootstrap
  # pip with the official get-pip.py, so a release install can repair itself
  # without assuming the user has Python or uv.
  $uv = Get-Command uv.exe -ErrorAction SilentlyContinue
  $native = "angr,unicorn,pyvex,capstone,cffi,pydantic-core,z3-solver,lmdb,msgspec,psutil"
  if ($uv) {
    & $uv.Source pip install --python $py --target $site --no-cache "--only-binary=$native" -r $src | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "dependency installation failed" }
  } else {
    $getPip = Join-Path $stage "get-pip.py"
    Download "https://bootstrap.pypa.io/get-pip.py" $getPip
    & $py $getPip --no-warn-script-location | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "pip bootstrap failed" }
    & $py -m pip install --target $site --no-cache-dir "--only-binary=$native" -r $src | Out-Host
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

  $check = & $py -c "import sys; sys.path.insert(0, r'$site'); import angr, bingraph; print(sys.version.split()[0]); print(angr.__version__); print(bingraph.__version__)"
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

  if (Test-Path $OutDir) { Remove-Item $OutDir -Recurse -Force }
  New-Item -ItemType Directory -Force (Split-Path $OutDir) | Out-Null
  Move-Item $stage $OutDir
  Write-Host "OK -> $OutDir"
} finally {
  if (-not $KeepStage -and (Test-Path $stage)) { Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue }
}
