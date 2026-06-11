# UltraCode Harness — One-Command Installer (Windows PowerShell)
# Copies plugins, commands, agents, and config to OpenCode

Write-Host "🚀 Installing UltraCode Harness..." -ForegroundColor Cyan
Write-Host ""

$OPENCODE_DIR = "$env:USERPROFILE\.config\opencode"

# Create OpenCode config directories if they don't exist
New-Item -ItemType Directory -Force -Path "$OPENCODE_DIR\plugins" | Out-Null
New-Item -ItemType Directory -Force -Path "$OPENCODE_DIR\commands" | Out-Null
New-Item -ItemType Directory -Force -Path "$OPENCODE_DIR\agents" | Out-Null

# Copy plugins
Write-Host "📦 Copying 20 plugins..." -ForegroundColor Yellow
Get-ChildItem -Path ".\plugins\*.ts" | Copy-Item -Destination "$OPENCODE_DIR\plugins\" -Force
Write-Host "   ✅ Plugins installed" -ForegroundColor Green

# Copy commands
Write-Host "📝 Copying 25 commands..." -ForegroundColor Yellow
Get-ChildItem -Path ".\commands\*.md" | Copy-Item -Destination "$OPENCODE_DIR\commands\" -Force
Write-Host "   ✅ Commands installed" -ForegroundColor Green

# Copy agent
Write-Host "🤖 Copying UltraCode agent..." -ForegroundColor Yellow
Copy-Item -Path ".\agents\ultracode.md" -Destination "$OPENCODE_DIR\agents\" -Force
Write-Host "   ✅ Agent installed" -ForegroundColor Green

# Copy CLAUDE.md
if (Test-Path ".\CLAUDE.md") {
    Copy-Item -Path ".\CLAUDE.md" -Destination "$OPENCODE_DIR\" -Force
}

# Handle opencode.jsonc
if (Test-Path "$OPENCODE_DIR\opencode.jsonc") {
    Write-Host "⚠️  opencode.jsonc already exists. Backing up to opencode.jsonc.bak" -ForegroundColor Yellow
    Copy-Item -Path "$OPENCODE_DIR\opencode.jsonc" -Destination "$OPENCODE_DIR\opencode.jsonc.bak" -Force
    Write-Host ""
    Write-Host "   To merge UltraCode config, add these lines to your opencode.jsonc:" -ForegroundColor White
    Write-Host ""
    Write-Host '   "plugin": [' -ForegroundColor Gray
    Get-ChildItem ".\plugins\*.ts" | ForEach-Object { Write-Host "     `"./plugins/$($_.Name)`"," -ForegroundColor Gray }
    Write-Host "   ]," -ForegroundColor Gray
} else {
    Write-Host "📄 Creating opencode.jsonc..." -ForegroundColor Yellow
    Copy-Item -Path ".\opencode.jsonc.example" -Destination "$OPENCODE_DIR\opencode.jsonc" -Force
    Write-Host "   ✅ Config created — edit it to set your model and API key" -ForegroundColor Green
}

Write-Host ""
Write-Host "✅ UltraCode Harness installed successfully!" -ForegroundColor Green
Write-Host ""
Write-Host "   Run: opencode --agent ultracode" -ForegroundColor White
Write-Host "   Or:  opencode run --agent ultracode --model <your-model> `"your task`"" -ForegroundColor White
