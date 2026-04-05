#!/usr/bin/env bash
# stop-oc-gateway.sh
# Approved OC Control action: stop the OpenClaw gateway and leave it stopped.
#
# This script is called ONLY by OCDash after the bounded action planner
# selects "stop_oc_gateway". It is never invoked by the LLM directly.

set -euo pipefail

echo "[oc-control] Stopping OpenClaw gateway..."
openclaw gateway stop

echo "[oc-control] Gateway stopped."
