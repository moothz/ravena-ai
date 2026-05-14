#!/bin/bash

# --- CONFIGURATION (from environment variables) ---
TELEGRAM_BOT_TOKEN="${HEALTH_CHECK_TELEGRAM_BOT_TOKEN}"
TELEGRAM_CHAT_ID="${HEALTH_CHECK_TELEGRAM_CHAT_ID}"

# Container names (must match docker-compose.yml service names)
WHATSGOAPI_CONTAINER="whatsgoapi"
RAVENA_CONTAINER="ravena-ai"

# whatsgoapi health endpoint and API key
TARGET_URL="http://${WHATSGOAPI_CONTAINER}:${SERVER_PORT:-8080}/instance/all"
API_KEY="${GLOBAL_API_KEY}"

# ravena-ai health endpoint
RAVENA_URL="http://${RAVENA_CONTAINER}:${API_PORT:-5000}/health"

# How often to run the health check (seconds)
CHECK_INTERVAL="${HEALTH_CHECK_INTERVAL:-60}"

# --- HELPER FUNCTIONS ---

send_telegram() {
    local message="$1"
    if [ -z "$TELEGRAM_BOT_TOKEN" ] || [ -z "$TELEGRAM_CHAT_ID" ]; then
        echo "[health-check] Telegram not configured, skipping notification."
        return
    fi
    curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
        -d chat_id="${TELEGRAM_CHAT_ID}" \
        -d text="${message}" \
        -d parse_mode="HTML" > /dev/null
}

restart_container() {
    local container="$1"
    echo "[health-check] Restarting container: ${container}"
    docker restart "${container}"
}

# --- MAIN LOOP ---

echo "[health-check] Starting health monitor (interval: ${CHECK_INTERVAL}s)"
echo "[health-check] Monitoring: whatsgoapi at ${TARGET_URL}"
echo "[health-check] Monitoring: ravena-ai at ${RAVENA_URL}"

while true; do

    # ── 1. Check whatsgoapi ──────────────────────────────────
    HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 \
        -H "apikey: ${API_KEY}" "${TARGET_URL}")

    if [ "$HTTP_STATUS" != "200" ]; then
        echo "[health-check] whatsgoapi DOWN (status: ${HTTP_STATUS}). Restarting..."

        MSG="🚨 <b>SERVICE DOWN: ${WHATSGOAPI_CONTAINER}</b>%0A"
        MSG+="<i>Health check returned: ${HTTP_STATUS} (or connection failed).</i>%0A"
        MSG+="<i>Initiating Docker restart...</i>"

        send_telegram "$MSG"
        restart_container "${WHATSGOAPI_CONTAINER}"

    else
        # ── 2. Check ravena-ai bot activity ─────────────────
        RAVENA_JSON=$(curl -s --max-time 10 "${RAVENA_URL}")

        if [ -n "$RAVENA_JSON" ]; then
            # Determine inactivity threshold based on time of day
            CURRENT_HOUR=$(date +%-H)
            if [ "$CURRENT_HOUR" -ge 1 ] && [ "$CURRENT_HOUR" -lt 7 ]; then
                LIMIT_MIN=45
            elif [ "$CURRENT_HOUR" -ge 7 ] && [ "$CURRENT_HOUR" -lt 9 ]; then
                LIMIT_MIN=20
            else
                LIMIT_MIN=8
            fi

            LIMIT_MS=$((LIMIT_MIN * 60 * 1000))

            INACTIVE_COUNT=$(echo "$RAVENA_JSON" | jq --argjson threshold "$LIMIT_MS" '
                (.payload.bots // .bots)
                | [ .[] | select(.connected == true and .lastMessageReceived != null and ((now * 1000) - .lastMessageReceived) > $threshold) ]
                | length' 2>/dev/null)

            INACTIVE_COUNT=${INACTIVE_COUNT:-0}

            if [ "$INACTIVE_COUNT" -gt 1 ]; then
                echo "[health-check] ravena-ai UNHEALTHY: ${INACTIVE_COUNT} bots inactive for >${LIMIT_MIN}min. Restarting..."

                MSG="🚨 <b>SERVICE UNHEALTHY: ${RAVENA_CONTAINER}</b>%0A"
                MSG+="<i>${INACTIVE_COUNT} bots inactive for > ${LIMIT_MIN} mins.</i>%0A"
                MSG+="<i>Initiating Docker restart...</i>"

                send_telegram "$MSG"
                restart_container "${RAVENA_CONTAINER}"
            else
                echo "[health-check] OK (whatsgoapi: ${HTTP_STATUS}, inactive bots: ${INACTIVE_COUNT})"
            fi
        else
            echo "[health-check] ravena-ai DOWN (no response). Restarting..."

            MSG="🚨 <b>SERVICE DOWN: ${RAVENA_CONTAINER}</b>%0A"
            MSG+="<i>Health check failed to get data from ${RAVENA_URL}.</i>%0A"
            MSG+="<i>Initiating Docker restart...</i>"

            send_telegram "$MSG"
            restart_container "${RAVENA_CONTAINER}"
        fi
    fi

    sleep "${CHECK_INTERVAL}"
done
