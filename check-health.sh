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

# RAM Alert state tracking
LAST_RAM_WARN_TIME=0
RAM_WARN_INTERVAL=900  # 15 minutes cooldown for >75% warning alerts

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

restart_stack() {
    reason="$1"
    echo "[health-check] Restarting full ravena-ai stack (Reason: ${reason})"
    if [ -d "/data" ] && [ -n "${reason}" ]; then
        echo "${reason}" > /data/status_motivo.txt
    fi

    # Discover compose project name or fallback to ravena-ai
    PROJECT_NAME=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$HOSTNAME" 2>/dev/null)
    PROJECT_NAME="${PROJECT_NAME:-ravena-ai}"

    # Get all containers in the stack except health-check itself
    STACK_CONTAINERS=$(docker ps --filter "label=com.docker.compose.project=${PROJECT_NAME}" --format "{{.Names}}" | grep -v "^health-check$")

    if [ -n "${STACK_CONTAINERS}" ]; then
        echo "[health-check] Restarting stack containers: ${STACK_CONTAINERS}"
        docker restart ${STACK_CONTAINERS}
    else
        echo "[health-check] Fallback: Restarting main containers ${WHATSGOAPI_CONTAINER} and ${RAVENA_CONTAINER}"
        docker restart "${WHATSGOAPI_CONTAINER}" "${RAVENA_CONTAINER}"
    fi
}

get_ravena_logs() {
    # Get last 50 lines of ravena-ai container logs
    LOGS=$(docker logs --tail 50 "${RAVENA_CONTAINER}" 2>&1)
    if [ -n "$LOGS" ]; then
        LOGS_ESCAPED=$(printf "%s\n" "$LOGS" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g' | awk '{printf "%s%%0A", $0}')
        echo "%0A%0A<b>Last 50 logs of ${RAVENA_CONTAINER}:</b>%0A<pre><code>${LOGS_ESCAPED}</code></pre>"
    fi
}

get_top_ram_processes() {
    TOP_PROCS=""
    if command -v ps >/dev/null 2>&1; then
        TOP_PROCS=$(ps -eo rss,comm,args --sort=-rss 2>/dev/null | awk 'NR>1 && NR<=11 {
            rss=$1 / 1024;
            comm=$2;
            $1=""; $2="";
            sub(/^ +/, "");
            cmd=($0 != "") ? $0 : comm;
            gsub(/&/, "\&amp;", cmd);
            gsub(/</, "\&lt;", cmd);
            gsub(/>/, "\&gt;", cmd);
            if (length(cmd) > 60) cmd = substr(cmd, 1, 57) "...";
            printf "%d. <b>%.1f MB</b> - <code>%s</code>%%0A", NR-1, rss, cmd
        }')
    fi

    if [ -z "$TOP_PROCS" ]; then
        TOP_PROCS=$(docker stats --no-stream --format "{{.Name}}\t{{.MemUsage}}\t{{.MemPerc}}" 2>/dev/null \
            | sed 's/%//' \
            | sort -k3 -n -r \
            | head -n 10 \
            | awk '{
                gsub(/&/, "\&amp;", $1);
                gsub(/</, "\&lt;", $1);
                gsub(/>/, "\&gt;", $1);
                printf "%d. <b>%s</b> - %s (<code>%s</code>)%%0A", NR, $2, $1, $3"%"
            }')
    fi

    if [ -n "$TOP_PROCS" ]; then
        echo "%0A%0A<b>Top 10 Processos por Uso de RAM:</b>%0A${TOP_PROCS}"
    else
        echo "%0A%0A<i>Não foi possível obter a lista de processos.</i>"
    fi
}

# --- MAIN LOOP ---

echo "[health-check] Starting health monitor (interval: ${CHECK_INTERVAL}s, max retries: ${MAX_RETRIES})"
echo "[health-check] Monitoring: whatsgoapi at ${TARGET_URL}"
echo "[health-check] Monitoring: ravena-ai at ${RAVENA_URL}"

while true; do

    # ── Check for SKIP_HEALTH_CHECK ─────────────────────────
    if [ -f "/app/SKIP_HEALTH_CHECK" ] || [ -f "/data/SKIP_HEALTH_CHECK" ] || [ -f "/SKIP_HEALTH_CHECK" ]; then
        echo "[health-check] Arquivo SKIP_HEALTH_CHECK detectado. Verificação de saúde pausada..."
        WHATSGO_FAIL_COUNT=0
        RAVENA_FAIL_COUNT=0
        sleep "${CHECK_INTERVAL}"
        continue
    fi

    # ── 0. Check RAM Usage ────────────────────────────────────
    if [ -f "/proc/meminfo" ]; then
        MEM_TOTAL_KB=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null)
        MEM_AVAIL_KB=$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo 2>/dev/null)

        if [ -n "$MEM_TOTAL_KB" ] && [ -n "$MEM_AVAIL_KB" ] && [ "$MEM_TOTAL_KB" -gt 0 ]; then
            MEM_USED_KB=$((MEM_TOTAL_KB - MEM_AVAIL_KB))
            RAM_USAGE_PCT=$(( (MEM_USED_KB * 100) / MEM_TOTAL_KB ))

            MEM_TOTAL_GB=$(awk -v t="$MEM_TOTAL_KB" 'BEGIN {printf "%.2f", t/1048576}')
            MEM_USED_GB=$(awk -v u="$MEM_USED_KB" 'BEGIN {printf "%.2f", u/1048576}')

            CURRENT_TIME=$(date +%s)

            if [ "$RAM_USAGE_PCT" -ge 85 ]; then
                echo "[health-check] CRITICAL: RAM usage at ${RAM_USAGE_PCT}% (${MEM_USED_GB}GB / ${MEM_TOTAL_GB}GB). Restarting bot stack..."

                TOP_PROCS=$(get_top_ram_processes)
                MSG="🚨 <b>ALERTA CRÍTICO: RAM em ${RAM_USAGE_PCT}%</b>%0A<i>Uso de memória: ${MEM_USED_GB} GB / ${MEM_TOTAL_GB} GB</i>%0A<i>Reiniciando a stack inteira do bot ravena-ai...</i>${TOP_PROCS}"

                send_telegram "$MSG"
                restart_stack "Uso excessivo de RAM (${RAM_USAGE_PCT}% ocupado - limite de 85% atingido)."

                LAST_RAM_WARN_TIME=$CURRENT_TIME
                sleep 30
                continue
            elif [ "$RAM_USAGE_PCT" -ge 75 ]; then
                TIME_DIFF=$((CURRENT_TIME - LAST_RAM_WARN_TIME))
                if [ "$LAST_RAM_WARN_TIME" -eq 0 ] || [ "$TIME_DIFF" -ge "$RAM_WARN_INTERVAL" ]; then
                    echo "[health-check] WARNING: RAM usage at ${RAM_USAGE_PCT}% (${MEM_USED_GB}GB / ${MEM_TOTAL_GB}GB). Sending Telegram alert..."

                    TOP_PROCS=$(get_top_ram_processes)
                    MSG="⚠️ <b>ALERTA: Alto uso de Memória RAM (${RAM_USAGE_PCT}%)</b>%0A<i>Uso de memória: ${MEM_USED_GB} GB / ${MEM_TOTAL_GB} GB</i>${TOP_PROCS}"

                    send_telegram "$MSG"
                    LAST_RAM_WARN_TIME=$CURRENT_TIME
                fi
            else
                LAST_RAM_WARN_TIME=0
            fi
        fi
    fi

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
