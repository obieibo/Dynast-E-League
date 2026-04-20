/**
 * FILE: updateIL.gs
 * PURPOSE: Fetches all players with IL eligibility from the Yahoo
 *          Fantasy Sports API and writes a comprehensive snapshot
 *          to _IL in the Data workbook. Captures both rostered and
 *          unrostered IL-eligible players across the entire league
 *          player pool, enriched with ownership and injury details.
 *
 * READS FROM: Yahoo Fantasy Sports API (players;position=IL endpoint)
 *             Yahoo Fantasy Sports API (teams endpoint, for team map)
 * WRITES TO:  _IL (Data WB)
 * CALLED BY:  commonUpdates() in triggerGroups.gs
 * DEPENDENCIES: helperFunctions.gs, playerResolution.gs,
 *               yahooAuthentication.gs
 *
 * OUTPUT SCHEMA (_IL):
 *   Col A  IDPLAYER    — Master BBREF ID
 *   Col B  PLAYER      — Player display name
 *   Col C  MLB_TEAM    — MLB team abbreviation
 *   Col D  ELIGIBILITY — Full eligibility string including IL/NA
 *   Col E  POSITION    — Clean eligibility string (IL/NA stripped)
 *   Col F  IL_TYPE     — Injury designation (e.g. 'IL10', 'IL60', 'DTD')
 *   Col G  INJURY_NOTE — Injury description from Yahoo
 *   Col H  STATUS      — Ownership status: 'Rostered', 'Waivers', or 'Free Agent'
 *   Col I  TEAM_ID     — Yahoo fantasy team ID (blank if not rostered)
 *   Col J  MANAGER_ID  — Yahoo manager ID (blank if not rostered)
 *   Col K  ROSTER      — Fantasy team display name (blank if not rostered)
 *
 * FETCH STRATEGY:
 *   Yahoo returns players in pages of 25. The script pre-builds
 *   all page URLs and fetches them in parallel via fetchAllYahooAPI.
 *   Pages beyond the actual player count return empty responses —
 *   the parser stops on the first empty page rather than continuing
 *   to the ceiling. The ceiling of 400 players (16 pages × 25)
 *   exceeds any realistic IL list but provides a safe upper bound.
 *
 * OWNERSHIP RESOLUTION:
 *   Yahoo's IL endpoint returns an ownership block per player
 *   indicating whether they are rostered, on waivers, or a free
 *   agent. For rostered players it includes the owning team name.
 *   Team name is cross-referenced against a team map built from
 *   the teams endpoint to get Team ID and Manager ID.
 */


// ============================================================
//  CONSTANTS
// ============================================================

const IL_SHEET   = '_IL';
const IL_HEADERS = [
  'IDPLAYER', 'PLAYER', 'MLB_TEAM', 'ELIGIBILITY', 'POSITION',
  'IL_TYPE', 'INJURY_NOTE', 'STATUS', 'TEAM_ID', 'MANAGER_ID', 'ROSTER'
];

// Maximum pages to fetch. Yahoo returns 25 players per page.
// 16 pages × 25 = 400 players — a safe ceiling for any IL list.
const IL_MAX_PAGES  = 16;
const IL_PAGE_SIZE  = 25;


// ============================================================
//  MAIN FUNCTION
// ============================================================

/**
 * Fetches all IL-eligible players from Yahoo and writes them to
 * _IL in the Data workbook.
 *
 * Execution steps:
 *   1. Build team name → { id, managerId } map from teams endpoint
 *   2. Build all page URLs up to IL_MAX_PAGES
 *   3. Fetch all pages in parallel via fetchAllYahooAPI
 *   4. Parse each page, stopping on first empty response
 *   5. Write output to _IL
 *   6. Stamp UPDATE_IL timestamp
 */
function updateIL() {
  const leagueKey = getLeagueKey();
  if (!leagueKey) {
    Logger.log('updateIL: no league key found. Aborting.');
    return;
  }

  const maps = getPlayerMaps('YAHOOID');

  // Step 1 — Build team name → { id, managerId } map
  const teamMap = _buildILTeamMap(leagueKey);

  // Step 2 — Build all page URLs
  const urls = [];
  for (let start = 0; start < IL_MAX_PAGES * IL_PAGE_SIZE; start += IL_PAGE_SIZE) {
    urls.push(
      `https://fantasysports.yahooapis.com/fantasy/v2/league/${leagueKey}` +
      `/players;position=IL;out=ownership;start=${start};count=${IL_PAGE_SIZE}?format=json`
    );
  }

  // Step 3 — Fetch all pages in parallel
  const responses = fetchAllYahooAPI(urls);

  // Steps 4 — Parse responses, stop on first empty page
  const outputRows = [IL_HEADERS];

  for (let i = 0; i < responses.length; i++) {
    const data = responses[i];
    if (!data) break; // Failed fetch — stop processing

    const leagueData = data.fantasy_content?.league?.[1]?.players;

    // Empty array or count of 0 means no more players — stop
    if (!leagueData || Array.isArray(leagueData) || leagueData.count === 0) break;

    for (let j = 0; j < leagueData.count; j++) {
      const playerData = leagueData[j.toString()]?.player;
      if (!playerData) continue;

      const row = _parseILPlayer(playerData, maps, teamMap);
      if (row) outputRows.push(row);
    }

    // If this page returned fewer than a full page, we've reached the end
    if (leagueData.count < IL_PAGE_SIZE) break;
  }

  // Step 5 — Write
  writeToData(IL_SHEET, outputRows);
  Logger.log('updateIL: wrote ' + (outputRows.length - 1) + ' IL players.');

  // Step 6 — Timestamp
  updateTimestamp('UPDATE_IL');
  flushIdMatchingQueue();
}


// ============================================================
//  TEAM MAP
// ============================================================

/**
 * Fetches all fantasy teams and builds a lookup map of
 * team name → { id, managerId }. Used to enrich IL player
 * rows with Team ID and Manager ID from the ownership block,
 * which only returns the team name rather than IDs.
 *
 * Returns an empty object if the fetch fails — IL player rows
 * will have empty Team ID and Manager ID but will not fail.
 *
 * @param  {string} leagueKey
 * @returns {Object} teamName (string) → { id: string, managerId: string }
 */
function _buildILTeamMap(leagueKey) {
  const url  = `https://fantasysports.yahooapis.com/fantasy/v2/league/${leagueKey}/teams?format=json`;
  const data = fetchYahooAPI(url);
  const teamMap = {};

  if (!data) {
    Logger.log('_buildILTeamMap: fetch failed. Team IDs will be empty.');
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

    if (tName) teamMap[tName] = { id: tId, managerId: mId };
  }

  Logger.log('_buildILTeamMap: mapped ' + Object.keys(teamMap).length + ' teams.');
  return teamMap;
}


// ============================================================
//  PLAYER PARSER
// ============================================================

/**
 * Parses a single Yahoo IL player response into an output row.
 * Extracts player info, injury details, and ownership status.
 *
 * Ownership resolution:
 *   ownership_type = 'team'      → player is Rostered
 *   ownership_type = 'waivers'   → player is on Waivers
 *   anything else                → player is a Free Agent
 *
 * For rostered players, owner_team_name is cross-referenced
 * against teamMap to get Team ID and Manager ID. If the team
 * name is not found in teamMap (shouldn't happen but possible
 * if teams data was unavailable), those fields are left empty.
 *
 * Only players with IL eligibility are included — players
 * returned by the IL endpoint who lack the IL flag in their
 * eligibility string are skipped. Yahoo occasionally returns
 * DTD players from this endpoint.
 *
 * @param  {Array}  playerData - Raw Yahoo player array
 * @param  {Object} maps       - Player resolution maps
 * @param  {Object} teamMap    - Team name → { id, managerId }
 * @returns {Array|null} Output row or null if player should be skipped
 */
function _parseILPlayer(playerData, maps, teamMap) {
  const parsed = parseYahooPlayer(playerData);

  const { cleanPositions, isIL, isNA } = parsePositions(parsed.positions);

  // Skip players without actual IL eligibility — endpoint can return DTD players
  if (!isIL) return null;

  const masterId = resolveMasterId(maps, parsed.pId, null, parsed.name, 'updateIL', parsed.team);

  // Extract ownership details from the player data blocks
  let rosterStatus  = 'Free Agent';
  let fantasyTeam   = '';
  let teamId        = '';
  let managerId     = '';

  playerData.forEach(block => {
    if (!block?.ownership) return;

    const ownershipType = block.ownership.ownership_type || 'freeagents';

    if (ownershipType === 'team') {
      rosterStatus = 'Rostered';
      fantasyTeam  = block.ownership.owner_team_name || '';
      const meta   = teamMap[fantasyTeam] || {};
      teamId       = meta.id        || '';
      managerId    = meta.managerId || '';
    } else if (ownershipType === 'waivers') {
      rosterStatus = 'Waivers';
    }
  });

  return [
    masterId,
    parsed.name,
    parsed.team,
    parsed.positions,
    cleanPositions,
    parsed.status,
    parsed.injuryNote,
    rosterStatus,
    teamId,
    managerId,
    fantasyTeam
  ];
}