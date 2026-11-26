# Build script for Windows (x64 & ARM64)
$ErrorActionPreference = "Stop"

Write-Host "Checking Tauri CLI..." -ForegroundColor Cyan
if (-not (Get-Command cargo-tauri -ErrorAction SilentlyContinue)) {
    Write-Host "Installing tauri-cli..." -ForegroundColor Yellow
    cargo install tauri-cli --version "^2.0"
}

Write-Host "Generating valid monochrome app icons..." -ForegroundColor Cyan
cargo tauri icon icon-source.png

Write-Host "Building native Windows installers (.msi and .exe)..." -ForegroundColor Cyan
cargo tauri build

Write-Host "`nDone! Your packaged installers are in:" -ForegroundColor Green
Write-Host "  src-tauri\target\release\bundle\msi\"
Write-Host "  src-tauri\target\release\bundle\nsis\"
