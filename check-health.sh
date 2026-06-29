#!/bin/sh

# --- CONFIGURATION (from environment variables) ---
TELEGRAM_BOT_TOKEN="${HEALTH_CHECK_TELEGRAM_BOT_TOKEN}"
TELEGRAM_CHAT_ID="${HEALTH_CHECK_TELEGRAM_CHAT_ID}"

# DNS names used for internal network requests (docker network service names)
WHATSGOAPI_HOST="whatsgoapi"
RAVENA_HOST="ravena-ai"

# Discover actual container names for docker CLI commands (handles prefixes like dd821e43551f_)
WHATSGOAPI_CONTAINER=$(docker ps --filter "label=com.docker.compose.service=whatsgoapi" --format "{{.Names}}" | head -n 1)
RAVENA_CONTAINER=$(docker ps --filter "label=com.docker.compose.service=ravena-ai" --format "{{.Names}}" | head -n 1)

# Fallback to default if empty
WHATSGOAPI_CONTAINER="${WHATSGOAPI_CONTAINER:-whatsgoapi}"
RAVENA_CONTAINER="${RAVENA_CONTAINER:-ravena-ai}"

# whatsgoapi health endpoint and API key
TARGET_URL="http://${WHATSGOAPI_HOST}:${SERVER_PORT:-8080}/instance/all"
API_KEY="${GLOBAL_API_KEY}"

# ravena-ai health endpoint
RAVENA_URL="http://${RAVENA_HOST}:${API_PORT:-5000}/health"

# How often to run the health check (seconds)
CHECK_INTERVAL="${HEALTH_CHECK_INTERVAL:-60}"

# Max retries before restarting
MAX_RETRIES=3
WHATSGO_FAIL_COUNT=0
RAVENA_FAIL_COUNT=0

# --- HELPER FUNCTIONS ---

send_telegram() {
    message="$1"
    if [ -z "$TELEGRAM_BOT_TOKEN" ] || [ -z "$TELEGRAM_CHAT_ID" ]; then
        echo "[health-check] Telegram not configured, skipping notification."
        return
    fi
    # Use %0A for newlines in curl data for Telegram
    curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
        -d chat_id="${TELEGRAM_CHAT_ID}" \
        -d text="${message}" \
        -d parse_mode="HTML" > /dev/null
}

restart_container() {
    container="$1"
    reason="$2"
    echo "[health-check] Restarting container: ${container} (Reason: ${reason})"
    if [ -d "/data" ] && [ -n "${reason}" ]; then
        echo "${reason}" > /data/status_motivo.txt
    fi
    docker restart "${container}"
}

get_ravena_logs() {
    # Get last 50 lines of ravena-ai container logs
    LOGS=$(docker logs --tail 50 "${RAVENA_CONTAINER}" 2>&1)
    if [ -n "$LOGS" ]; then
        LOGS_ESCAPED=$(printf "%s\n" "$LOGS" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g' | awk '{printf "%s%%0A", $0}')
        echo "%0A%0A<b>Last 50 logs of ${RAVENA_CONTAINER}:</b>%0A<pre><code>${LOGS_ESCAPED}</code></pre>"
    fi
}

# --- MAIN LOOP ---

echo "[health-check] Starting health monitor (interval: ${CHECK_INTERVAL}s, max retries: ${MAX_RETRIES})"
echo "[health-check] Monitoring: whatsgoapi at ${TARGET_URL}"
echo "[health-check] Monitoring: ravena-ai at ${RAVENA_URL}"

while true; do

    # ── 1. Check whatsgoapi ──────────────────────────────────
    HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 15 \
        -H "apikey: ${API_KEY}" "${TARGET_URL}")

    if [ "$HTTP_STATUS" != "200" ]; then
        WHATSGO_FAIL_COUNT=$((WHATSGO_FAIL_COUNT + 1))
        echo "[health-check] whatsgoapi failure (${WHATSGO_FAIL_COUNT}/${MAX_RETRIES}) - status: ${HTTP_STATUS}"

        if [ "$WHATSGO_FAIL_COUNT" -ge "$MAX_RETRIES" ]; then
            echo "[health-check] whatsgoapi DOWN. Restarting..."
            
            MSG="🚨 <b>SERVICE DOWN: ${WHATSGOAPI_CONTAINER}</b>%0A<i>Health check returned: ${HTTP_STATUS} (or connection failed).</i>%0A<i>Initiating Docker restart...</i>"
            MSG="${MSG}$(get_ravena_logs)"

            send_telegram "$MSG"
            restart_container "${WHATSGOAPI_CONTAINER}" "O serviço principal do WhatsApp (whatsgoapi) travou ou ficou inacessível."
            WHATSGO_FAIL_COUNT=0
            sleep 30
        fi
    else
        WHATSGO_FAIL_COUNT=0
        
        # ── 2. Check ravena-ai bot activity ─────────────────
        RAVENA_JSON=$(curl -s --max-time 15 "${RAVENA_URL}")

        if [ -n "$RAVENA_JSON" ]; then
            # Determine inactivity threshold based on time of day
            CURRENT_HOUR=$(date +%H)
            # Remove leading zero for comparison
            CURRENT_HOUR=$(echo $CURRENT_HOUR | sed 's/^0//')
            [ -z "$CURRENT_HOUR" ] || [ "$CURRENT_HOUR" = " " ] && CURRENT_HOUR=0
            
            if [ "$CURRENT_HOUR" -ge 1 ] && [ "$CURRENT_HOUR" -lt 7 ]; then
                LIMIT_MIN=60
                MAX_INACTIVE=4
            elif [ "$CURRENT_HOUR" -ge 7 ] && [ "$CURRENT_HOUR" -lt 8 ]; then
                LIMIT_MIN=45
                MAX_INACTIVE=3
            else
                LIMIT_MIN=10
                MAX_INACTIVE=1
            fi

            LIMIT_MS=$((LIMIT_MIN * 60 * 1000))

            INACTIVE_COUNT=$(echo "$RAVENA_JSON" | jq --argjson threshold "$LIMIT_MS" '
                (.payload.bots // .bots)
                | [ .[] | select(.connected == true and .lastMessageReceived != null and ((now * 1000) - .lastMessageReceived) > $threshold) ]
                | length' 2>/dev/null)

            INACTIVE_COUNT=${INACTIVE_COUNT:-0}

            if [ "$INACTIVE_COUNT" -gt "$MAX_INACTIVE" ]; then
                RAVENA_FAIL_COUNT=$((RAVENA_FAIL_COUNT + 1))
                echo "[health-check] ravena-ai unhealthy (${RAVENA_FAIL_COUNT}/${MAX_RETRIES}): ${INACTIVE_COUNT} bots inactive for >${LIMIT_MIN}min."
                
                if [ "$RAVENA_FAIL_COUNT" -ge "$MAX_RETRIES" ]; then
                    echo "[health-check] ravena-ai UNHEALTHY. Restarting..."

                    MSG="🚨 <b>SERVICE UNHEALTHY: ${RAVENA_CONTAINER}</b>%0A<i>${INACTIVE_COUNT} bots inactive for > ${LIMIT_MIN} mins.</i>%0A<i>Initiating Docker restart...</i>"
                    MSG="${MSG}$(get_ravena_logs)"

                    send_telegram "$MSG"
                    restart_container "${RAVENA_CONTAINER}" "O bot foi reiniciado automaticamente pelo monitor de saúde devido à inatividade prolongada dos bots."
                    RAVENA_FAIL_COUNT=0
                    sleep 30
                fi
            else
                RAVENA_FAIL_COUNT=0
                echo "[health-check] OK (whatsgoapi: ${HTTP_STATUS}, inactive bots: ${INACTIVE_COUNT})"
            fi
        else
            RAVENA_FAIL_COUNT=$((RAVENA_FAIL_COUNT + 1))
            echo "[health-check] ravena-ai failure (${RAVENA_FAIL_COUNT}/${MAX_RETRIES}): no response."

            if [ "$RAVENA_FAIL_COUNT" -ge "$MAX_RETRIES" ]; then
                echo "[health-check] ravena-ai DOWN. Restarting..."

                MSG="🚨 <b>SERVICE DOWN: ${RAVENA_CONTAINER}</b>%0A<i>Health check failed to get data from ${RAVENA_URL}.</i>%0A<i>Initiating Docker restart...</i>"
                MSG="${MSG}$(get_ravena_logs)"

                send_telegram "$MSG"
                restart_container "${RAVENA_CONTAINER}" "O bot foi reiniciado automaticamente pelo monitor de saúde por não responder ao teste de conectividade."
                RAVENA_FAIL_COUNT=0
                sleep 30
            fi
        fi
    fi

    sleep "${CHECK_INTERVAL}"
done
