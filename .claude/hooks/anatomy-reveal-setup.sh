#!/bin/bash
# Set up the tools the anatomy-reveal skill (.claude/skills/anatomy-reveal) needs.
#
# - ImageMagick 7: the skill calls `magick`, but Ubuntu only ships ImageMagick 6 and the
#   network policy blocks imagemagick.org and GitHub downloads. The skill only runs
#   `magick <frames> -evaluate-sequence mean <out>`, which IM6's `convert` handles,
#   so a small `magick` wrapper that forwards to `convert` is enough.
# - Chromium: the skill looks for /usr/bin/chromium; the cloud image keeps it in /opt/pw-browsers.

# Only run in Claude Code cloud sessions.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

if ! command -v magick >/dev/null 2>&1; then
  if ! command -v convert >/dev/null 2>&1; then
    (apt-get install -y -qq imagemagick || { apt-get update -qq && apt-get install -y -qq imagemagick; }) >&2
  fi
  if command -v convert >/dev/null 2>&1; then
    cat > /usr/local/bin/magick <<'EOF'
#!/bin/sh
# ImageMagick 7-style entry point backed by ImageMagick 6.
# `magick convert ...` and `magick identify ...` map to the IM6 tools; anything else goes to convert.
case "$1" in
  convert|identify|mogrify|composite|compare|montage) tool="$1"; shift; exec "$tool" "$@" ;;
  *) exec convert "$@" ;;
esac
EOF
    chmod +x /usr/local/bin/magick
  fi
fi

if [ ! -e /usr/bin/chromium ] && [ -x /opt/pw-browsers/chromium ]; then
  ln -s /opt/pw-browsers/chromium /usr/bin/chromium
fi

exit 0
