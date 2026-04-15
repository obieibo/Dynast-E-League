/**
 * FILE: updateMatchups.gs
 * PURPOSE: Fetches all weekly matchup results from the Yahoo Fantasy
 *          Sports API and maintains an incremental log in _MATCHUPS.
 *          Fetches all weeks from week 1 through the current week in
 *          parallel, then merges results into the existing sheet —
 *          updating rows for weeks already in progress and appending
 *          rows for newly completed weeks.
 *
 * READS FROM: Yahoo Fantasy Sports API (scoreboard endpoint, per week)
 *             Yahoo Fantasy Sports API (league endpoint, for current week)
 *             Yahoo Fantasy Sports API (settings endpoint, for stat map)
 * WRITES TO:  _MATCHUPS (Data WB)
 * CALLED BY:  commonUpdates() in triggerGroups.gs
 * DEPENDENCIES: helperFunctions.gs, yahooAuthentication.gs
 *
 * OUTPUT SCHEMA (_MATCHUPS):
 *   Col A  WEEK         — Scoring week number
 *   Col B  MATCHUP_ID   — Matchup number within the week (1-based)
 *   Col C  TEAM_ID      — Yahoo fantasy team ID
 *   Col D  MANAGER_ID   — Yahoo manager ID
 *   Col E  RESULT       — Win, Loss, or Tie
 *   Col F  OPP_TEAM_ID  — Opposing team ID
 *   Col G  TEAM         — Fantasy team display name
 *   Col H  SCORE        — Total points scored (H2H points leagues)
 *   Col I+ [STAT COLS]  — One column per scoring category, dynamically
 *                         named from Yahoo stat IDs via the settings
 *                         endpoint. Column count varies by league.
 *
 * MERGE BEHAVIOR:
 *   Existing rows are keyed by WEEK + TEAM_ID. On each run:
 *   - Rows for completed prior weeks are updated in place if Yahoo
 *     returns revised data (rare but possible for corrected stats)
 *   - Rows for the current in-progress week are updated on every run
 *     since scores change throughout the week
 *   - New week rows are appended when a new scoring week begins
 *   This ensures the sheet is always current without duplicating rows.
 */


// ============================================================
//  CONSTANTS
// ============================================================

const MATCHUPS_SHEET = '_MATCHUPS';


// ============================================================
//  MAIN FUNCTION
// ============================================================

/**
 * Fetches all matchup data from week 1 through the current week,
 * merges results into _MATCHUPS, and writes the updated dataset
 * back to the Data workbook.
 *
 * Execution steps:
 *   1. Fetch stat category map from Yahoo settings endpoint
 *   2. Fetch current week number from Yahoo league endpoint
 *   3. Fetch all weeks in parallel via fetchAllYahooAPI
 *   4. Load existing _MATCHUPS data for merge
 *   5. Parse each week's matchups and merge into existing data
 *   6. Write merged dataset back to _MATCHUPS
 *   7. Stamp UPDATE_MATCHUPS timestamp
 */
function updateMatchups() {
  const leagueKey = getLeagueKey();
  if (!leagueKey) {
    Logger.log('updateMatchups: no league key found. Aborting.');
    return;
  }

  // Step 1 — Stat category map
  const statMap = _fetchStatMap(leagueKey);
  if (!statMap) {
    Logger.log('updateMatchups: could not build stat map. Aborting.');
    return;
  }

  // Step 2 — Current week
  const currentWeek = _fetchCurrentWeek(leagueKey);
  if (!currentWeek) {
    Logger.log('updateMatchups: could not determine current week. Aborting.');
    return;
  }

  // Step 3 — Fetch all weeks in parallel
  const urls = [];
  for (let w = 1; w <= currentWeek; w++) {
    urls.push(`https://fantasysports.yahooapis.com/fantasy/v2/league/${leagueKey}/scoreboard;week=${w}?format=json`);
  }
  const responses = fetchAllYahooAPI(urls);

  // Step 4 — Load existing data
  const { existingData, headers, rowMap } = _loadExistingMatchups();

  // Step 5 — Parse and merge
  const mergedData = _parseAndMergeMatchups(
    responses, existingData, headers, rowMap, statMap
  );

  if (mergedData.length <= 1) {
    Logger.log('updateMatchups: no matchup data to write.');
    return;
  }

  // Step 6 — Write
  writeToData(MATCHUPS_SHEET, mergedData);
  Logger.log('updateMatchups: wrote ' + (mergedData.length - 1) + ' matchup rows.');

  // Step 7 — Timestamp
  updateTimestamp('UPDATE_MATCHUPS');
}


// ============================================================
//  STAT MAP FETCH
// ============================================================

/**
 * Fetches the league settings from Yahoo and builds a map of
 * stat ID → display name for all scoring categories. Used to
 * generate column headers in _MATCHUPS dynamically so the sheet
 * reflects the actual categories used by this specific league.
 *
 * Returns null if the fetch fails — callers should abort if null
 * is returned since stat columns cannot be named without this map.
 *
 * @param  {string} leagueKey
 * @returns {Object|null} statId (string) → display name (string)
 */
function _fetchStatMap(leagueKey) {
  const url  = `https://fantasysports.yahooapis.com/fantasy/v2/league/${leagueKey}/settings?format=json`;
  const data = fetchYahooAPI(url);

  if (!data) {
    Logger.log('_fetchStatMap: settings fetch failed.');
    return null;
  }

  const categories = data.fantasy_content?.league?.[1]?.settings?.[0]?.stat_categories?.stats;
  if (!categories) {
    Logger.log('_fetchStatMap: stat categories not found in settings response.');
    return null;
  }

  const statMap = {};
  categories.forEach(s => {
    statMap[s.stat.stat_id] = s.stat.display_name;
  });

  Logger.log('_fetchStatMap: mapped ' + Object.keys(statMap).length + ' stat categories.');
  return statMap;
}


// ============================================================
//  CURRENT WEEK FETCH
// ============================================================

/**
 * Fetches the current scoring week number from the Yahoo league
 * endpoint. Used to determine how many weeks of scoreboard data
 * to fetch in parallel.
 *
 * Returns null if the fetch fails or the week cannot be parsed.
 *
 * @param  {string} leagueKey
 * @returns {number|null} Current week number
 */
function _fetchCurrentWeek(leagueKey) {
  const url  = `https://fantasysports.yahooapis.com/fantasy/v2/league/${leagueKey}?format=json`;
  const data = fetchYahooAPI(url);

  if (!data) {
    Logger.log('_fetchCurrentWeek: league fetch failed.');
    return null;
  }

  const week = parseInt(data.fantasy_content?.league?.[0]?.current_week, 10);
  if (!week) {
    Logger.log('_fetchCurrentWeek: current_week not found in response.');
    return null;
  }

  Logger.log('_fetchCurrentWeek: current week is ' + week + '.');
  return week;
}


// ============================================================
//  EXISTING DATA LOADER
// ============================================================

/**
 * Reads the current _MATCHUPS sheet from the Data workbook and
 * returns the existing data array, header row, and a row index map
 * keyed by WEEK_TEAMID composite string.
 *
 * The row index map allows O(1) lookup of existing rows during
 * merge without scanning the full array for each incoming matchup.
 *
 * Returns empty structures if the sheet does not yet exist or
 * has no data — the merge function handles both cases correctly.
 *
 * @returns {{ existingData: Array[], headers: Array, rowMap: Object }}
 */
function _loadExistingMatchups() {
  const dataSS = getDataSS();
  const sheet  = dataSS?.getSheetByName(MATCHUPS_SHEET);

  if (!sheet || sheet.getLastRow() === 0) {
    Logger.log('_loadExistingMatchups: no existing data found.');
    return { existingData: [], headers: [], rowMap: {} };
  }

  const existingData = sheet.getDataRange().getValues();
  const headers      = existingData.length > 0 ? existingData[0] : [];
  const rowMap       = {};

  // Build WEEK_TEAMID → row index map (1-based to match existingData indices)
  for (let i = 1; i < existingData.length; i++) {
    const week   = existingData[i][0];
    const teamId = existingData[i][2];
    if (week && teamId) {
      rowMap[`${week}_${teamId}`] = i;
    }
  }

  Logger.log('_loadExistingMatchups: loaded ' + (existingData.length - 1) + ' existing rows.');
  return { existingData, headers, rowMap };
}


// ============================================================
//  PARSE AND MERGE
// ============================================================

/**
 * Parses all weekly scoreboard responses and merges them into the
 * existing matchup data. For each team in each matchup:
 *   - If a row already exists for that WEEK + TEAM_ID combination,
 *     the row is updated in place with fresh data
 *   - If no row exists, a new row is appended
 *
 * Headers are built dynamically from the first matchup response
 * that contains stat data. If the existing sheet already has
 * headers they are preserved unless the stat columns have changed.
 *
 * @param  {Array}   responses    - Array of parsed Yahoo API responses
 * @param  {Array[]} existingData - Current _MATCHUPS data (may be empty)
 * @param  {Array}   headers      - Existing header row (may be empty)
 * @param  {Object}  rowMap       - WEEK_TEAMID → row index in existingData
 * @param  {Object}  statMap      - Stat ID → display name
 * @returns {Array[]} Merged dataset including header row
 */
function _parseAndMergeMatchups(responses, existingData, headers, rowMap, statMap) {
  // Work on a copy so we don't mutate the original
  const mergedData = existingData.length > 0 ? existingData.map(r => [...r]) : [];
  let   headersSet = headers.length > 0;

  responses.forEach(data => {
    if (!data) return;

    const matchups = data.fantasy_content?.league?.[1]?.scoreboard?.['0']?.matchups;
    if (!matchups || matchups.count === 0) return;

    for (let i = 0; i < matchups.count; i++) {
      const m        = matchups[i.toString()]?.matchup;
      if (!m) continue;

      const matchWeek = parseInt(m.week) || 0;
      if (!matchWeek) continue;

      const teamData = m['0']?.teams;
      if (!teamData) continue;

      // Extract scores for result calculation
      const score0 = parseFloat(teamData['0']?.team?.[1]?.team_points?.total || 0);
      const score1 = parseFloat(teamData['1']?.team?.[1]?.team_points?.total || 0);

      for (let t = 0; t < 2; t++) {
        const team     = teamData[t.toString()]?.team;
        if (!team) continue;

        const meta     = team[0];
        const teamId   = meta.find(item => item?.team_id)?.team_id   || '';
        const teamName = meta.find(item => item?.name)?.name         || '';
        const mngrId   = meta.find(item => item?.managers)?.managers?.[0]?.manager?.manager_id || '';
        const score    = t === 0 ? score0 : score1;
        const oppScore = t === 0 ? score1 : score0;
        const oppTeam  = teamData[t === 0 ? '1' : '0']?.team?.[0];
        const oppId    = oppTeam?.find(item => item?.team_id)?.team_id || '';

        let result = 'Tie';
        if (score > oppScore) result = 'Win';
        else if (score < oppScore) result = 'Loss';

        const stats    = team[1]?.team_stats?.stats || [];
        const statVals = stats.map(s => {
          let val = s.stat?.value || '';
          // If it's a fraction/ratio (contains a slash) prepend an apostrophe to prevent date conversion
          if (typeof val === 'string' && val.includes('/')) {
            val = "'" + val;
          }
          return val;
        });

        // Build headers from the first team's stats if not already set
        if (!headersSet) {
          const statHeaders = stats.map(s => statMap[s.stat?.stat_id] || `Stat_${s.stat?.stat_id}`);
          const newHeaders  = [
            'WEEK', 'MATCHUP_ID', 'TEAM_ID', 'MANAGER_ID',
            'RESULT', 'OPP_TEAM_ID', 'TEAM', 'SCORE',
            ...statHeaders
          ];
          mergedData.unshift(newHeaders);
          headersSet = true;
        }

        const rowData = [
          matchWeek, i + 1, teamId, mngrId,
          result, oppId, teamName, score,
          ...statVals
        ];

        const key = `${matchWeek}_${teamId}`;

        if (rowMap[key] !== undefined) {
          // Update existing row in place
          mergedData[rowMap[key]] = rowData;
        } else {
          // Append new row and record its index
          mergedData.push(rowData);
          rowMap[key] = mergedData.length - 1;
        }
      }
    }
  });

  return mergedData;
}