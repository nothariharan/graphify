param(
  [Parameter(Mandatory=$true)][string]$Graph,
  [string]$Lane = "L0",
  [string]$Only = "",
  [string]$Dprs = "1",
  [string]$Csv = "",
  [string]$Repeat = "1",
  [bool]$Warmup = $true
)
$ErrorActionPreference = "Stop"
$lab = Split-Path $PSScriptRoot -Parent
$dprList = @($Dprs -split '[,\s]+' | Where-Object { $_ -ne "" } | ForEach-Object { [int]$_ })
$reps = [int]$Repeat

if ($Warmup) {
  # one throwaway launch so Chrome/GPU/OS caches are warm before the measured runs
  $wf = Join-Path $lab "variants\base-httpx.html"
  if (Test-Path $wf) {
    node (Join-Path $PSScriptRoot "measure.mjs") --file "variants/base-httpx.html" --label __warmup --lane W --graph httpx --dpr 1 --csv (Join-Path $lab "results\warmup.csv") | Out-Null
    Write-Host "warmup done"
  }
}
$lab  = Split-Path $PSScriptRoot -Parent
$lab  = Split-Path $PSScriptRoot -Parent
$base = Join-Path $lab "variants\base-$Graph.html"
if (!(Test-Path $base)) { throw "missing base: $base" }

$vargs = @((Join-Path $PSScriptRoot "variants.py"), "--base", $base, "--outdir", (Join-Path $lab "variants"), "--prefix", $Graph)
if ($Only) { $vargs += @("--only", $Only) }
python @vargs
if (-not $?) { throw "variants.py failed" }

$files = Get-ChildItem (Join-Path $lab "variants") -Filter "${Graph}__*.html" | Sort-Object Name
if ($Only) {
  $onlySet = @($Only -split ',' | Where-Object { $_ -ne "" })
  $files = $files | Where-Object { $onlySet -contains ($_.BaseName -split "__")[-1] }
}
foreach ($f in $files) {
  $name = ($f.BaseName -split "__")[-1]
  foreach ($d in $dprList) {
    for ($k = 1; $k -le $reps; $k++) {
    Write-Host "== $Graph / $name / dpr=$d / rep=$k"
    $margs = @((Join-Path $PSScriptRoot "measure.mjs"), "--file", "variants/$($f.Name)", "--label", $name, "--lane", $Lane, "--graph", $Graph, "--dpr", "$d")
    if ($Csv) { $margs += @("--csv", $Csv) }
    node @margs
    if (-not $?) { Write-Host "   (measure failed for $name dpr=$d rep=$k)" }
    }
  }
}
Write-Host "sweep done for $Graph"
