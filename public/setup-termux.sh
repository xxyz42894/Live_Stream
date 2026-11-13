#!/data/data/com.termux/files/usr/bin/bash
# ReStream - Termux Setup Script
# Run once: bash setup-termux.sh

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ReStream — Termux Setup"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Update packages
echo "[1/5] Updating packages..."
pkg update -y -q

# Install Node.js
echo "[2/5] Installing Node.js..."
pkg install nodejs -y -q

# Install FFmpeg
echo "[3/5] Installing FFmpeg..."
pkg install ffmpeg -y -q

# Install Python + yt-dlp
echo "[4/5] Installing yt-dlp..."
pkg install python -y -q
pip install -q yt-dlp

# Install npm dependencies
echo "[5/5] Installing Node dependencies..."
npm install --silent

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Setup complete!"
echo ""
echo "  Start karo:"
echo "    node server.js"
echo ""
echo "  Browser me open karo:"
echo "    http://localhost:3000"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
