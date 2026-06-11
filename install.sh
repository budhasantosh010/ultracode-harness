#!/bin/bash
# UltraCode Harness — One-Command Installer (Linux/macOS)
# Copies plugins, commands, agents, and config to OpenCode

set -e

echo "🚀 Installing UltraCode Harness..."
echo ""

OPENCODE_DIR="${HOME}/.config/opencode"

# Create OpenCode config directories if they don't exist
mkdir -p "${OPENCODE_DIR}/plugins"
mkdir -p "${OPENCODE_DIR}/commands"
mkdir -p "${OPENCODE_DIR}/agents"
mkdir -p "${OPENCODE_DIR}/scripts"

# Copy plugins
echo "📦 Copying 20 plugins..."
cp -r plugins/*.ts "${OPENCODE_DIR}/plugins/"
echo "   ✅ Plugins installed"

# Copy commands
echo "📝 Copying 25 commands..."
cp -r commands/*.md "${OPENCODE_DIR}/commands/"
echo "   ✅ Commands installed"

# Copy agent
echo "🤖 Copying UltraCode agent..."
cp agents/ultracode.md "${OPENCODE_DIR}/agents/"
echo "   ✅ Agent installed"

# Copy CLAUDE.md (managed-level instructions)
echo "📋 Copying CLAUDE.md..."
cp CLAUDE.md "${OPENCODE_DIR}/" 2>/dev/null || true
echo "   ✅ Instructions installed"

# Copy scripts
echo "⚙️  Copying scripts..."
cp scripts/*.mjs "${OPENCODE_DIR}/scripts/" 2>/dev/null || true
echo "   ✅ Scripts installed"

# Handle opencode.jsonc
if [ -f "${OPENCODE_DIR}/opencode.jsonc" ]; then
    echo "⚠️  opencode.jsonc already exists. Backing up to opencode.jsonc.bak"
    cp "${OPENCODE_DIR}/opencode.jsonc" "${OPENCODE_DIR}/opencode.jsonc.bak"
    echo ""
    echo "   To merge UltraCode config, manually add these lines to your opencode.jsonc:"
    echo ""
    echo '   "plugin": ['
    for f in plugins/*.ts; do
        name=$(basename "$f")
        echo "     \"./plugins/${name}\","
    done
    echo "   ],"
else
    echo "📄 Creating opencode.jsonc..."
    cp opencode.jsonc.example "${OPENCODE_DIR}/opencode.jsonc"
    echo "   ✅ Config created — edit it to set your model and API key"
fi

# Install graphify (optional, for knowledge graphs)
echo ""
echo "🔍 Optional: Install graphify for knowledge graphs?"
echo "   pip install graphifyy"
echo "   Or skip if you don't need knowledge graph features."

echo ""
echo "✅ UltraCode Harness installed successfully!"
echo ""
echo "   Run: opencode --agent ultracode"
echo "   Or:  opencode run --agent ultracode --model <your-model> \"your task\""
echo ""
echo "   📖 Read the docs: cat docs/SYSTEM_ARCHITECTURE.md"
