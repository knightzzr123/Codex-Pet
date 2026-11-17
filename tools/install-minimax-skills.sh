#!/usr/bin/env bash
# Install the MiniMax skills pack for Codex and Cursor in this user account.
# Idempotent. Does not change the 大肥鱼 pet app.
#
# Home directories on cloud agents are not kept across runs unless an
# environment snapshot exists. The repo copy at .cursor/skills/minimax-pdf
# (linked from .agents/skills/minimax-pdf) remains available after checkout.
# This script restores the official home layout and Python/Node dependencies
# used by minimax-pdf.

set -euo pipefail

REPO_URL="https://github.com/MiniMax-AI/skills.git"
DEST="${HOME}/.codex/minimax-skills"
PDF_SCRIPTS="${DEST}/skills/minimax-pdf/scripts"

if [[ -d "${DEST}/.git" ]]; then
  if ! git -C "${DEST}" pull --ff-only; then
    echo "git pull failed; keeping the existing checkout at ${DEST}" >&2
  fi
else
  rm -rf "${DEST}"
  git clone --depth 1 "${REPO_URL}" "${DEST}"
fi

mkdir -p "${HOME}/.agents/skills" "${HOME}/.cursor/skills"
ln -sfn "${DEST}/skills" "${HOME}/.agents/skills/minimax-skills"
ln -sfn "${DEST}" "${HOME}/.cursor/minimax-skills"
ln -sfn "${DEST}/skills/minimax-pdf" "${HOME}/.cursor/skills/minimax-pdf"

if command -v python3 >/dev/null 2>&1; then
  python3 -m pip install --user -q reportlab pypdf matplotlib \
    || python3 -m pip install --user --break-system-packages -q reportlab pypdf matplotlib
else
  echo "python3 is missing; minimax-pdf check will fail" >&2
fi

if command -v npm >/dev/null 2>&1; then
  mkdir -p "${HOME}/.local"
  npm config set prefix "${HOME}/.local"
  export PATH="${HOME}/.local/bin:${PATH}"
  if ! node -e "require(require('child_process').execSync('npm root -g').toString().trim()+'/playwright')" >/dev/null 2>&1; then
    npm install -g playwright
  fi
  if [[ -x "${HOME}/.local/bin/playwright" ]]; then
    "${HOME}/.local/bin/playwright" install chromium
  else
    npx --yes playwright install chromium
  fi
else
  echo "npm is missing; playwright cannot be installed" >&2
fi

if [[ -f "${PDF_SCRIPTS}/make.sh" ]]; then
  bash "${PDF_SCRIPTS}/make.sh" check
fi
