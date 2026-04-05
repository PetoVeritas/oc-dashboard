#!/usr/bin/env bash
# restart-oc-5s.sh
# Approved OC Control action: restart the OpenClaw gateway with a 5-second pause.
#
# This script is called ONLY by OCDash after the bounded action planner
# selects "restart_oc_5s". It is never invoked by the LLM directly.

set -uo pipefail

echo "[oc-control] Stopping OpenClaw gateway..."
openclaw gateway stop 2>/dev/null || echo "[oc-control] Gateway was not running (or already stopped). Continuing..."

echo "[oc-control] Waiting 5 seconds before restart..."
sleep 5

echo "[oc-control] Starting OpenClaw gateway..."
openclaw gateway start

echo "[oc-control] Gateway restart complete."
