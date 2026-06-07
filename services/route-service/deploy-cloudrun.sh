#!/usr/bin/env bash
# Build + deploy tranzit-route-service to Cloud Run with the Tailscale sidecar.
# Prereqs (one-time): gcloud auth, Artifact Registry repo, and two Secret Manager secrets
# (tailscale-authkey, gmaps-api-key). See CLOUDRUN.md.
set -euo pipefail
cd "$(dirname "$0")"

PROJECT="${PROJECT:-$(gcloud config get-value project 2>/dev/null)}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-tranzit-route-service}"
REPO="${REPO:-tranzit}"
OTP_URL="${OTP_BASE_URL:-http://tranzit-otp.tailnet-example.ts.net:8080}"
# Public Cloud Run URL of tranzit-db-middleware (used to look up live vehicle_id per trip).
MIDDLEWARE_URL="${MIDDLEWARE_BASE_URL:-https://tranzit-db-middleware-qsv32inqpq-uc.a.run.app}"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/${REPO}/${SERVICE}:latest"

echo "Project=$PROJECT Region=$REGION Service=$SERVICE"
echo "Image=$IMAGE"
echo "OTP_BASE_URL=$OTP_URL"
echo "MIDDLEWARE_BASE_URL=$MIDDLEWARE_URL"

# Ensure the Artifact Registry repo exists (no-op if already there).
gcloud artifacts repositories create "$REPO" \
  --repository-format=docker --location="$REGION" 2>/dev/null || true

echo "==> Building image via Cloud Build"
gcloud builds submit --config cloudbuild.yaml --substitutions=_IMAGE="$IMAGE"

echo "==> Deploying to Cloud Run"
gcloud run deploy "$SERVICE" \
  --image "$IMAGE" \
  --region "$REGION" \
  --platform managed \
  --allow-unauthenticated \
  --port 8080 \
  --no-cpu-throttling \
  --set-env-vars "OTP_BASE_URL=${OTP_URL},OTP_HTTP_PROXY=http://localhost:1055,TS_HOSTNAME=${SERVICE},MIDDLEWARE_BASE_URL=${MIDDLEWARE_URL}" \
  --set-secrets "TS_AUTHKEY=tailscale-authkey:latest,GMAPS_API_KEY=gmaps-api-key:latest"

echo "==> Done. Service URL:"
gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)'
