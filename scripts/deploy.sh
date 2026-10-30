#!/usr/bin/env bash
set -e

echo "🚀 Deploying Weather Alert..."
cd "$(dirname "$0")/.."

echo "📥 Pulling latest changes from git..."
git pull origin main

echo "🐳 Rebuilding and starting containers..."
docker compose up -d --build --remove-orphans

echo "🧹 Cleaning up dangling images..."
docker image prune -f

echo "✅ Weather Alert successfully updated!"
docker compose ps
