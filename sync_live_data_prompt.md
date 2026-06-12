# WorldCup 2026 Sync Live Data Webhook Integration

This document contains instructions to update the external script `sync-live-data.js` in the `worldcup2026` folder. It will enable the script to detect game events (match start, goal, match end) and send them to the `/copa` endpoint of the Ravena bot API.

## Code Changes for `sync-live-data.js`

Open `sync-live-data.js` in the `worldcup2026` folder and apply the following modifications.

### 1. Add Configuration and Helpers

Add the notification functions and configuration at the top of the file, or right before `syncGames()`:

```javascript
// URL of the Ravena Bot API
const RAVENA_API_URL = process.env.RAVENA_API_URL || 'http://localhost:5000';

/**
 * Sends a game event to the Ravena Bot API /copa endpoint
 */
async function notifyCopa(event, match, goalDetails = null) {
    try {
        await axios.post(`${RAVENA_API_URL}/copa`, {
            event,
            match: {
                id: match.id,
                home_team_id: match.home_team_id,
                away_team_id: match.away_team_id,
                home_team_name_en: match.home_team_name_en,
                away_team_name_en: match.away_team_name_en,
                home_score: match.home_score,
                away_score: match.away_score,
                finished: match.finished,
                time_elapsed: match.time_elapsed,
                stadium_id: match.stadium_id,
                type: match.type,
                group: match.group
            },
            goalDetails
        }, { timeout: 5000 });
        console.log(`📡 Event '${event}' successfully sent to Ravena bot.`);
    } catch (err) {
        console.error(`⚠️ Failed to notify Ravena bot about event '${event}':`, err.message);
    }
}

/**
 * Helper to identify the scorer name from scorers difference
 */
function findNewScorer(oldScorers, newScorers) {
    if (!newScorers) return null;
    
    const parseScorers = (val) => {
        if (Array.isArray(val)) return val.map(x => typeof x === 'object' ? (x.name || x.player) : String(x));
        if (typeof val === 'string') return val.split(',').map(s => s.trim());
        return [];
    };

    const oldList = parseScorers(oldScorers);
    const newList = parseScorers(newScorers);

    for (const name of newList) {
        if (!oldList.includes(name)) {
            return name;
        }
    }
    return newList[newList.length - 1] || null;
}
```

### 2. Update `syncGames` Loop to Detect Transitions

Modify the game update section inside the `syncGames()` function. Find this block:

```javascript
            // Update database
            const result = await Game.updateOne(
                { id: liveGame.id },
                {
                    $set: {
                        home_score: liveGame.home_score,
                        away_score: liveGame.away_score,
                        home_scorers: liveGame.home_scorers,
                        away_scorers: liveGame.away_scorers,
                        finished: liveGame.finished,
                        time_elapsed: liveGame.time_elapsed
                    }
                }
            );
```

And replace it with the transition detection code:

```javascript
            // Fetch previous game state from DB to compare and detect transitions
            const oldGame = await Game.findOne({ id: liveGame.id });

            if (oldGame) {
                // 1. Detect Match Start (transitions from 'notstarted' to active)
                if (oldGame.time_elapsed === "notstarted" && liveGame.time_elapsed !== "notstarted" && liveGame.finished !== "TRUE") {
                    await notifyCopa("match_start", liveGame);
                }

                // 2. Detect Goals (scores increased)
                const oldHomeScore = Number(oldGame.home_score) || 0;
                const newHomeScore = Number(liveGame.home_score) || 0;
                const oldAwayScore = Number(oldGame.away_score) || 0;
                const newAwayScore = Number(liveGame.away_score) || 0;

                if (newHomeScore > oldHomeScore) {
                    const scorer = findNewScorer(oldGame.home_scorers, liveGame.home_scorers);
                    await notifyCopa("goal", liveGame, {
                        scoringTeamId: liveGame.home_team_id,
                        scoringTeamNameEn: liveGame.home_team_name_en,
                        player: scorer || "",
                        minute: liveGame.time_elapsed
                    });
                } else if (newAwayScore > oldAwayScore) {
                    const scorer = findNewScorer(oldGame.away_scorers, liveGame.away_scorers);
                    await notifyCopa("goal", liveGame, {
                        scoringTeamId: liveGame.away_team_id,
                        scoringTeamNameEn: liveGame.away_team_name_en,
                        player: scorer || "",
                        minute: liveGame.time_elapsed
                    });
                }

                // 3. Detect Match End (transitions to finished)
                if (oldGame.finished !== "TRUE" && liveGame.finished === "TRUE") {
                    await notifyCopa("match_end", liveGame);
                }
            }

            // Update database
            const result = await Game.updateOne(
                { id: liveGame.id },
                {
                    $set: {
                        home_score: liveGame.home_score,
                        away_score: liveGame.away_score,
                        home_scorers: liveGame.home_scorers,
                        away_scorers: liveGame.away_scorers,
                        finished: liveGame.finished,
                        time_elapsed: liveGame.time_elapsed
                    }
                }
            );
```

## Setup Environment Variables (Optional)

If the Ravena bot runs on a different port or server, set `RAVENA_API_URL` in `worldcup2026` `.env` file:
```env
RAVENA_API_URL=http://localhost:5000
```
Otherwise, it defaults to `http://localhost:5000` automatically.
