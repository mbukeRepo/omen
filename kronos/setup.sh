#!/bin/sh
# One-time setup for the Kronos forecast sidecar: venv + deps + vendored repo.
set -e
cd "$(dirname "$0")"

if [ ! -d vendor/Kronos ]; then
  mkdir -p vendor
  git clone --depth 1 https://github.com/shiyu-coder/Kronos vendor/Kronos
fi

if [ ! -d venv ]; then
  python3 -m venv venv
fi
./venv/bin/pip install --quiet --upgrade pip
./venv/bin/pip install --quiet torch numpy pandas einops huggingface_hub safetensors tqdm

echo "kronos sidecar ready: $(./venv/bin/python -c 'import torch; print("torch", torch.__version__)')"
