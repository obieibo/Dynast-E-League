/**
 * FILE: updateWaivers.gs
 * PURPOSE: Fetches all players currently on waivers from the Yahoo
 *          Fantasy Sports API and writes a snapshot to _WAIVERS in
 *          the Data workbook.
 *
 *          Waiver wire data is useful for identifying recently dropped
 *          players, tracking waiver dates for priority purposes, and
 *          surfacing IL-eligible players who have cleared waivers.
 *
 * READS FROM: Yahoo Fantasy Sports API (players;status=W endpoint)
 * WRITES TO:  _WAIVERS (Data WB)
 * CALLED BY:  commonUpdates() in triggerGroups.gs
 * DEPENDENCIES: helperFunctions.gs, playerResolution.gs,
 *               yahooAuthentication.gs
 *
 * OUTPUT SCHEMA (_WAIVERS):
 *   Col A  IDPLAYER     — Master BBREF ID
 *   Col B  PLAYER       — Player display name
 *   Col C  MLB_TEAM     — MLB team abbreviation
 *   Col D  ELIGIBILITY  — Full eligibility string including IL/NA
 *   Col E  POSITION     — Clean eligibility string (IL/NA stripped)
 *   Col F  IL           — TRUE if player has IL eligibility
 *   Col G  NA           — TRUE if player has NA eligibility (minors)
 *   Col H  WAIVER_DATE  — Date player clears waivers (from Yahoo)
 *
 * FETCH STRATEGY:
 *   Yahoo returns players in pages of 25. The script pre-builds
 *   all page URLs up to a ceiling of 200 players (8 pages × 25)
 *   and fetches them in parallel via fetchAllYahooAPI. Pages beyond
 *   the actual waiver count return empty responses — the parser
 *   stops on the first empty page rather than processing all pages.
 *   200 players exceeds any realistic waiver wire count at any
 *   point in the season.
 */


// ============================================================
//  CONSTANTS
// ============================================================

const WAIVERS_SHEET   = '_WAIVERS';
const WAIVERS_HEADERS = [
  'IDPLAYER', 'PLAYER', 'MLB_TEAM', 'ELIGIBILITY', 'POSITION',
  'IL', 'NA', 'WAIVER_DATE'
];

// Maximum pages to fetch. Yahoo returns 25 players per page.
// 8 pages × 25 = 200 players — a safe ceiling for any waiver list.
const WAIVERS_MAX_PAGES = 8;
const WAIVERS_PAGE_SIZE = 25;


// ============================================================
//  MAIN FUNCTION
// ============================================================

/**
 * Fetches all players currently on waivers from Yahoo and writes
 * them to _WAIVERS in the Data workbook.
 *
 * Execution steps:
 *   1. Build all page URLs up to WAIVERS_MAX_PAGES
 *   2. Fetch all pages in parallel via fetchAllYahooAPI
 *   3. Parse each page, stopping on first empty response
 *   4. Write output to _WAIVERS
 *   5. Stamp UPDATE_WAIVERS timestamp
 */
function updateWaivers() {
  const leagueKey = getLeagueKey();
  if (!leagueKey) {
    Logger.log('updateWaivers: no league key found. Aborting.');
    return;
  }

  const maps = getPlayerMaps('YAHOOID');

  // Step 1 — Build all page URLs
  const urls = [];
  for (let start = 0; start < WAIVERS_MAX_PAGES * WAIVERS_PAGE_SIZE; start += WAIVERS_PAGE_SIZE) {
    urls.push(
      `https://fantasysports.yahooapis.com/fantasy/v2/league/${leagueKey}` +
      `/players;status=W;out=ownership;start=${start};count=${WAIVERS_PAGE_SIZE}?format=json`
    );
  }

  // Step 2 — Fetch all pages in parallel
  const responses = fetchAllYahooAPI(urls);

  // Step 3 — Parse responses, stop on first empty page
  const outputRows = [WAIVERS_HEADERS];

  for (let i = 0; i < responses.length; i++) {
    const data = responses[i];
    if (!data) break; // Failed fetch — stop processing

    const leagueData = data.fantasy_content?.league?.[1]?.players;

    // Empty array or count of 0 means no more players — stop
    if (!leagueData || Array.isArray(leagueData) || leagueData.count === 0) break;

    for (let j = 0; j < leagueData.count; j++) {
      const playerData = leagueData[j.toString()]?.player;
      if (!playerData) continue;

      const row = _parseWaiverPlayer(playerData, maps);
      if (row) outputRows.push(row);
    }

    // If this page returned fewer than a full page, we've reached the end
    if (leagueData.count < WAIVERS_PAGE_SIZE) break;
  }

  // Step 4 — Write
  writeToData(WAIVERS_SHEET, outputRows);
  Logger.log('updateWaivers: wrote ' + (outputRows.length - 1) + ' waiver players.');

  // Step 5 — Timestamp
  updateTimestamp('UPDATE_WAIVERS');
  flushIdMatchingQueue();
}


// ============================================================
//  PLAYER PARSER
// ============================================================

/**
 * Parses a single Yahoo waiver player response into an output row.
 * Extracts player info, position eligibility, and waiver date.
 *
 * Waiver date is extracted from the ownership block. Yahoo returns
 * this as a date string (e.g. '2026-04-15') indicating when the
 * player clears waivers and becomes a free agent. Empty string if
 * not available.
 *
 * @param  {Array}  playerData - Raw Yahoo player array
 * @param  {Object} maps       - Player resolution maps
 * @returns {Array} Output row
 */
function _parseWaiverPlayer(playerData, maps) {
  const parsed = parseYahooPlayer(playerData);

  const masterId = resolveMasterId(maps, parsed.pId, null, parsed.name, 'updateWaivers', parsed.team);

  const { cleanPositions, isIL, isNA } = parsePositions(parsed.positions);

  // Extract waiver date from the ownership block
  let waiverDate = '';
  playerData.forEach(block => {
    if (block?.ownership?.waiver_date) {
      waiverDate = block.ownership.waiver_date;
    }
  });

  return [
    masterId,
    parsed.name,
    parsed.team,
    parsed.positions,
    cleanPositions,
    isIL,
    isNA,
    waiverDate
  ];
}