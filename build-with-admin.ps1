# Complete build script with admin manifest
Write-Host "Building Tauri app..." -ForegroundColor Cyan
bun run tauri build

if ($LASTEXITCODE -ne 0) {
    Write-Host "Build failed!" -ForegroundColor Red
    exit 1
}

Write-Host "`nAdding admin manifest to exe..." -ForegroundColor Cyan

$exePath = "src-tauri\target\release\auto-clicker-assistant.exe"
$manifestPath = "src-tauri\resources\app.manifest"

# Find mt.exe
$mtPaths = @(
    "C:\Program Files (x86)\Windows Kits\10\bin\*\x64\mt.exe",
    "C:\Program Files (x86)\Windows Kits\10\bin\10.0.*\x64\mt.exe"
)

$mtExe = $null
foreach ($pattern in $mtPaths) {
    $found = Get-ChildItem -Path $pattern -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($found) {
        $mtExe = $found.FullName
        break
    }
}

if (-not $mtExe) {
    Write-Host "Warning: mt.exe not found, skipping manifest embedding" -ForegroundColor Yellow
} else {
    & $mtExe -manifest $manifestPath -outputresource:"$exePath;#1"
    if ($LASTEXITCODE -eq 0) {
        Write-Host "Admin manifest added successfully!" -ForegroundColor Green
    }
}

Write-Host "`nBuild complete!" -ForegroundColor Green
Write-Host "Installer: src-tauri\target\release\bundle\nsis\" -ForegroundColor Cyan
