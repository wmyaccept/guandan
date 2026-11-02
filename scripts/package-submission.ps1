param([string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$projectRoot = Split-Path -Parent $PSScriptRoot
if (-not $OutputDirectory) {
    $OutputDirectory = Join-Path $projectRoot ('submissions/' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
}
if (Test-Path -LiteralPath $OutputDirectory) { throw 'Output directory already exists; choose a new directory.' }
$output = New-Item -ItemType Directory -Path $OutputDirectory
$staging = New-Item -ItemType Directory -Path (Join-Path $output.FullName 'staging')
$full = New-Item -ItemType Directory -Path (Join-Path $staging.FullName 'full')
$anonymous = New-Item -ItemType Directory -Path (Join-Path $staging.FullName 'anonymous')
$sharedFiles = @(
    'package.json', 'package-lock.json', 'Dockerfile', '设计与实现说明.md',
    'public/index.html', 'public/app.js', 'public/styles.css', 'public/courtyard.svg', 'public/joker.svg',
    'scripts/browser-smoke.mjs', 'scripts/ai-benchmark.mjs',
    'deploy/install.sh', 'deploy/guandan.service', 'deploy/nginx.conf', 'deploy/nginx.subdomain.conf'
)
$sharedFiles += Get-ChildItem -LiteralPath (Join-Path $projectRoot 'server') -Recurse -File |
    ForEach-Object { [IO.Path]::GetRelativePath($projectRoot, $_.FullName) }
foreach ($target in @($full, $anonymous)) {
    foreach ($relative in $sharedFiles) {
        $destination = Join-Path $target.FullName $relative
        [IO.Directory]::CreateDirectory((Split-Path -Parent $destination)) | Out-Null
        Copy-Item -LiteralPath (Join-Path $projectRoot $relative) -Destination $destination
    }
}
Copy-Item -LiteralPath (Join-Path $projectRoot 'README.md') -Destination (Join-Path $full.FullName 'README.md')
Copy-Item -LiteralPath (Join-Path $projectRoot 'README.anonymous.md') -Destination (Join-Path $anonymous.FullName 'README.md')
$identity = '王铭煜|陈立峰|吴子铭|咕咕嘎嘎|wmyaccept|daoxiang|30538|\bwmy\b|\bclf\b|\bwzm\b|[A-Z]:[\\/]Users[\\/]'
foreach ($file in (Get-ChildItem -LiteralPath $anonymous.FullName -Recurse -File)) {
    if ($file.Name -match $identity -or (Get-Content -LiteralPath $file.FullName -Raw -Encoding utf8) -match $identity) {
        throw "Identity found in anonymous package: $($file.FullName)"
    }
}
foreach ($relative in $sharedFiles) {
    $fullHash = (Get-FileHash -LiteralPath (Join-Path $full.FullName $relative) -Algorithm SHA256).Hash
    $anonymousHash = (Get-FileHash -LiteralPath (Join-Path $anonymous.FullName $relative) -Algorithm SHA256).Hash
    if ($fullHash -ne $anonymousHash) { throw "Shared file mismatch: $relative" }
}
$prefix = '2026-零杯壹组-咕咕嘎嘎-王铭煜'
$fullZip = Join-Path $output.FullName "$prefix-完整版本.zip"
$anonymousZip = Join-Path $output.FullName "$prefix-匿名版本.zip"
[IO.Compression.ZipFile]::CreateFromDirectory($full.FullName, $fullZip)
[IO.Compression.ZipFile]::CreateFromDirectory($anonymous.FullName, $anonymousZip)
$outerPath = Join-Path $output.FullName '零杯壹组-咕咕嘎嘎-王铭煜.zip'
$outer = [IO.Compression.ZipFile]::Open($outerPath, [IO.Compression.ZipArchiveMode]::Create)
try {
    foreach ($zip in @($fullZip, $anonymousZip)) {
        [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($outer, $zip, [IO.Path]::GetFileName($zip)) | Out-Null
    }
} finally { $outer.Dispose() }
foreach ($zipPath in @($fullZip, $anonymousZip, $outerPath)) {
    $archive = [IO.Compression.ZipFile]::OpenRead($zipPath)
    try {
        if ($zipPath -eq $outerPath) {
            if ($archive.Entries.Count -ne 2) { throw 'Outer ZIP must contain exactly two ZIPs.' }
        } else {
            $names = @($archive.Entries | ForEach-Object { $_.FullName.Replace('\', '/') })
            foreach ($required in @('README.md', 'package-lock.json', 'public/courtyard.svg', 'public/joker.svg', 'server/index.js')) {
                if ($required -notin $names) { throw "Missing archive file: $required" }
            }
            if ($names | Where-Object { $_ -match '(^|/)(node_modules|\.git|chrome|tmp-[^/]*)(/|$)|lobby-hero\.jpg|README\.anonymous|提交前待办|评分细则' }) {
                throw 'Unexpected archive file.'
            }
        }
    } finally { $archive.Dispose() }
}
Get-ChildItem -LiteralPath $output.FullName -Filter '*.zip' | Select-Object FullName, Length
Write-Output "Output directory: $($output.FullName)"
