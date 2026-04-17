/**
 * FILE: updatePlayers.gs
 * PURPOSE: Fetches the complete Yahoo Fantasy Sports player pool
 * for the current league and writes it to _PLAYERS in the
 * Data workbook. Covers all rostered, waiver wire, and free
 * agent players in the Yahoo MLB player universe.
 *
 * _PLAYERS provides a comprehensive player reference used
 * for lookups, eligibility checks, injury monitoring, and
 * as the source of truth for which players Yahoo recognizes
 * in this league's player pool.
 *
 * This script fetches all players regardless of ownership
 * status — rostered, waivers, and free agents are all
 * included. The STATUS and TEAM_ID columns indicate
 * current ownership where applicable.
 *
 * READS FROM: Yahoo Fantasy Sports API (players endpoint, paginated)
 * Yahoo Fantasy Sports API (teams endpoint, for team map)
 * WRITES TO:  _PLAYERS (Data WB)
 * CALLED BY:  weeklyUpdates() in triggerGroups.gs
 * Can also be run manually on demand.
 * DEPENDENCIES: helperFunctions.gs, playerResolution.gs,
 * yahooAuthentication.gs
 *
 * OUTPUT SCHEMA (_PLAYERS):
 * Col A  IDPLAYER    — Master BBREF ID
 * Col B  YAHOO_ID    — Yahoo player ID
 * Col C  PLAYER      — Player display name
 * Col D  MLB_TEAM    — MLB team abbreviation
 * Col E  ELIGIBILITY — Full eligibility string including IL/NA
 * Col F  POSITION    — Clean eligibility string (IL/NA stripped)
 * Col G  IL          — TRUE if player has IL eligibility
 * Col H  NA          — TRUE if player has NA eligibility (minors)
 * Col I  STATUS      — Injury/availability status (e.g. 'IL10', 'DTD') or ''
 * Col J  INJURY_NOTE — Injury description or ''
 * Col K  OWNERSHIP   — 'Rostered', 'Waivers', or 'Free Agent'
 * Col L  TEAM_ID     — Yahoo fantasy team ID (blank if not rostered)
 * Col M  MANAGER_ID  — Yahoo manager ID (blank if not rostered)
 * Col N  ROSTER      — Fantasy team display name (blank if not rostered)
 *
 * FETCH STRATEGY:
 * Yahoo returns players in pages of 25. Pages are fetched in
 * batches of PLAYERS_BATCH_SIZE parallel requests to stay within
 * UrlFetchApp rate limits. After each batch the script checks
 * whether the last page returned a full set of results — if it
 * returned fewer than 25 players the full pool has been retrieved
 * and fetching stops. The ceiling of PLAYERS_MAX_PAGES pages
 * (typically ~4000 players) covers the full Yahoo MLB player pool.
 *
 * PERFORMANCE:
 * Fetching the full player pool makes ~160 API calls (4000 players
 * ÷ 25 per page). This takes 30-60 seconds depending on Yahoo's
 * response time. Running weekly rather than hourly is appropriate.
 * The UPDATE_PLAYERS timestamp tracks the last successful run.
 */


// ============================================================
//  CONSTANTS
// ============================================================

const PLAYERS_SHEET      = '_PLAYERS';
const PLAYERS_HEADERS    = [
  'IDPLAYER', 'YAHOO_ID', 'PLAYER', 'MLB_TEAM', 'ELIGIBILITY', 'POSITION',
  'IL', 'NA', 'STATUS', 'INJURY_NOTE', 'OWNERSHIP', 'TEAM_ID', 'MANAGER_ID', 'ROSTER'
];

const PLAYERS_PAGE_SIZE  = 25;   // Yahoo's fixed page size
const PLAYERS_MAX_PAGES  = 200;  // 200 × 25 = 5000 — safe ceiling for Yahoo MLB pool
const PLAYERS_BATCH_SIZE = 20;   // Parallel requests per batch


// ============================================================
//  MAIN FUNCTION
// ============================================================

/**
 * Fetches all players in the Yahoo player pool for the current
 * league and writes them to _PLAYERS in the Data workbook.
 *
 * Execution steps:
 * 1. Build team ID → { managerId, teamName } map from teams endpoint
 * 2. Fetch all player pages in parallel batches
 * 3. Parse each page and build output rows
 * 4. Write output to _PLAYERS
 * 5. Stamp UPDATE_PLAYERS timestamp
 * 6. Flush ID Matching Queue
 */
function updatePlayers() {
  const leagueKey = getLeagueKey();
  if (!leagueKey) {
    Logger.log('updatePlayers: no league key found. Aborting.');
    return;
  }

  const maps = getPlayerMaps('YAHOOID');

  // Step 1 — Build team ID → { managerId, teamName } map
  const teamMap = _buildPlayersTeamMap(leagueKey);

  // Steps 2-3 — Fetch pages in batches and parse
  const outputRows = [PLAYERS_HEADERS];
  let   start      = 0;
  let   done       = false;

  while (!done && start < PLAYERS_MAX_PAGES * PLAYERS_PAGE_SIZE) {
    // Build a batch of URLs
    const batchUrls = [];
    for (let b = 0; b < PLAYERS_BATCH_SIZE; b++) {
      const offset = start + (b * PLAYERS_PAGE_SIZE);
      if (offset >= PLAYERS_MAX_PAGES * PLAYERS_PAGE_SIZE) break;
      batchUrls.push(
        `https://fantasysports.yahooapis.com/fantasy/v2/league/${leagueKey}` +
        `/players;out=ownership;start=${offset};count=${PLAYERS_PAGE_SIZE}?format=json`
      );
    }

    if (batchUrls.length === 0) break;

    const responses = fetchAllYahooAPI(batchUrls);

    for (let i = 0; i < responses.length; i++) {
      const data = responses[i];

      if (!data) {
        Logger.log('updatePlayers: null response at offset ' + (start + i * PLAYERS_PAGE_SIZE) + '. Stopping batch.');
        done = true;
        break;
      }

      const leagueData = data.fantasy_content?.league?.[1]?.players;

      // Empty array or count of 0 means no more players
      if (!leagueData || Array.isArray(leagueData) || leagueData.count === 0) {
        done = true;
        break;
      }

      for (let j = 0; j < leagueData.count; j++) {
        const playerData = leagueData[j.toString()]?.player;
        if (!playerData) continue;

        const row = _parsePlayer(playerData, maps, teamMap);
        if (row) outputRows.push(row);
      }

      // Fewer than a full page means we have reached the end
      if (leagueData.count < PLAYERS_PAGE_SIZE) {
        done = true;
        break;
      }
    }

    start += PLAYERS_BATCH_SIZE * PLAYERS_PAGE_SIZE;

    // Brief pause between batches to avoid hammering Yahoo's API
    if (!done) Utilities.sleep(200);
  }

  // Step 4 — Write
  writeToData(PLAYERS_SHEET, outputRows);
  Logger.log('updatePlayers: wrote ' + (outputRows.length - 1) + ' players.');

  // Step 5 — Timestamp
  updateTimestamp('UPDATE_PLAYERS');
  
  // Step 6 — Flush missing players to the ID Matching Sheet
  flushIdMatchingQueue();
}


// ============================================================
//  TEAM MAP
// ============================================================

/**
 * Fetches all fantasy teams and builds a lookup map of
 * team ID → { managerId, teamName }. Used to enrich player
 * rows with ownership details from the ownership block,
 * which returns team ID for rostered players.
 *
 * Returns an empty object if the fetch fails — ownership
 * details will be blank but the script will not fail.
 *
 * @param  {string} leagueKey
 * @returns {Object} teamId (string) → { managerId: string, teamName: string }
 */
function _buildPlayersTeamMap(leagueKey) {
  const url  = `https://fantasysports.yahooapis.com/fantasy/v2/league/${leagueKey}/teams?format=json`;
  const data = fetchYahooAPI(url);
  const teamMap = {};

  if (!data) {
    Logger.log('_buildPlayersTeamMap: fetch failed. Ownership details will be empty.');
    return teamMap;
  }

  const teams = data.fantasy_content?.league?.[1]?.teams;
  if (!teams) return teamMap;

  for (let i = 0; i < teams.count; i++) {
    const t    = teams[i.toString()]?.team?.[0];
    if (!t) continue;

    const tId   = t.find(item => item?.team_id)?.team_id?.toString()   || '';
    const tName = t.find(item => item?.name)?.name                     || '';
    const mId   = t.find(item => item?.managers)?.managers?.[0]?.manager?.manager_id?.toString() || '';

    if (tId) teamMap[tId] = { managerId: mId, teamName: tName };
  }

  Logger.log('_buildPlayersTeamMap: mapped ' + Object.keys(teamMap).length + ' teams.');
  return teamMap;
}


// ============================================================
//  PLAYER PARSER
// ============================================================

/**
 * Parses a single Yahoo player response into an output row.
 * Extracts player info, position eligibility, injury status,
 * and ownership details.
 *
 * Ownership resolution:
 * ownership_type = 'team'      → Rostered
 * ownership_type = 'waivers'   → Waivers
 * anything else                → Free Agent
 *
 * For rostered players, owner_team_key is parsed to extract the
 * team ID, which is then looked up in teamMap to get Manager ID
 * and team name.
 *
 * @param  {Array}  playerData - Raw Yahoo player array
 * @param  {Object} maps       - Player resolution maps
 * @param  {Object} teamMap    - teamId → { managerId, teamName }
 * @returns {Array} Output row
 */
function _parsePlayer(playerData, maps, teamMap) {
  const parsed = parseYahooPlayer(playerData);

  // Added parsed.team as the 6th parameter so missing players hit the ID Matching sheet with their MLB Team attached!
  const masterId = resolveMasterId(maps, parsed.pId, null, parsed.name, 'updatePlayers', parsed.team);

  const { cleanPositions, isIL, isNA } = parsePositions(parsed.positions);

  let ownership = 'Free Agent';
  let teamId    = '';
  let managerId = '';
  let teamName  = '';

  playerData.forEach(block => {
    if (!block?.ownership) return;

    const ownershipType = block.ownership.ownership_type || 'freeagents';

    if (ownershipType === 'team') {
      ownership = 'Rostered';
      // owner_team_key format: '431.l.12345.t.6' — extract team ID after '.t.'
      const teamKey = block.ownership.owner_team_key || '';
      const tIdMatch = teamKey.match(/\.t\.(\d+)$/);
      teamId = tIdMatch ? tIdMatch[1] : '';
      const meta = teamMap[teamId] || {};
      managerId = meta.managerId || '';
      teamName  = meta.teamName  || '';
    } else if (ownershipType === 'waivers') {
      ownership = 'Waivers';
    }
  });

  return [
    masterId,
    parsed.pId,
    parsed.name,
    parsed.team,
    parsed.positions,
    cleanPositions,
    isIL,
    isNA,
    parsed.status,
    parsed.injuryNote,
    ownership,
    teamId,
    managerId,
    teamName
  ];
}