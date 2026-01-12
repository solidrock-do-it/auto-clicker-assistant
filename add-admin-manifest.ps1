# 为生成的 exe 添加管理员权限 manifest
# 需要安装 Windows SDK (包含 mt.exe 工具)

$exePath = "src-tauri\target\release\auto-clicker-assistant.exe"
$manifestPath = "src-tauri\resources\app.manifest"

Write-Host "正在为应用添加管理员权限..." -ForegroundColor Cyan

# 查找 mt.exe (Microsoft Manifest Tool)
$mtPaths = @(
    "C:\Program Files (x86)\Windows Kits\10\bin\*\x64\mt.exe",
    "C:\Program Files (x86)\Windows Kits\10\bin\10.0.*\x64\mt.exe",
    "C:\Program Files (x86)\Microsoft SDKs\Windows\v*\bin\*\mt.exe"
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
    Write-Host "错误: 找不到 mt.exe 工具" -ForegroundColor Red
    Write-Host "请安装 Windows SDK: https://developer.microsoft.com/zh-cn/windows/downloads/windows-sdk/" -ForegroundColor Yellow
    exit 1
}

Write-Host "找到 mt.exe: $mtExe" -ForegroundColor Green

# Embed manifest
& $mtExe -manifest $manifestPath -outputresource:"$exePath;#1"

if ($LASTEXITCODE -eq 0) {
    Write-Host "Success! Administrator privilege added!" -ForegroundColor Green
    Write-Host "The application will now run with admin rights" -ForegroundColor Green
} else {
    Write-Host "Failed with error code: $LASTEXITCODE" -ForegroundColor Red
    exit 1
}
