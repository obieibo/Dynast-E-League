/**
 * FILE: updateHistoricalRosters.gs
 * PURPOSE: Automated and manual fetching of league rosters for 
 * historical/Replacement Level analysis. 
 *
 * READS FROM: LEAGUE_KEYS_HISTORY, CURRENT_YEAR (Primary WB)
 * WRITES TO:  _HIST_ROSTERS_[YEAR]_W[WEEK] (Data WB)
 * TIMESTAMPS: UPDATE_HISTORICAL_ROSTERS (Primary WB)
 */

/**
 * ENTRY POINT FOR WEEKLY TRIGGER
 * Set this to run on a Weekly Timer (e.g., Monday mornings).
 * It will only fire if the target week (16) has just concluded.
 */
function autoUpdateHistoricalRosters() {
  const ss = getPrimarySS();
  const dataSS = getDataSS();
  const currentYear = parseInt(ss.getRangeByName("CURRENT_YEAR").getValue(), 10);
  
  // 1. Get current week from your _LEAGUE_INFO output in the Data WB
  const leagueInfoSheet = dataSS.getSheetByName("_LEAGUE_INFO");
  if (!leagueInfoSheet) {
    Logger.log("autoUpdateHistoricalRosters: _LEAGUE_INFO not found. Run updateLeagueInfo first.");
    return;
  }
  
  const leagueData = leagueInfoSheet.getDataRange().getValues();
  // Find "current_week" in Col B, Value in Col C
  const currentWeekRow = leagueData.find(r => r[1] === "current_week");
  const currentWeek = currentWeekRow ? parseInt(currentWeekRow[2], 10) : 0;

  const targetWeek = 16; // The designated week for Replacement Level analysis
  const targetSheetName = `_HIST_ROSTERS_${currentYear}_W${targetWeek}`;

  // 2. CHECK: Only run once the target week has actually concluded (Week 17+)
  if (currentWeek <= targetWeek) {
    Logger.log(`autoUpdateHistoricalRosters: Week ${targetWeek} hasn't concluded yet (Current: ${currentWeek}). Skipping.`);
    return;
  }

  // 3. CHECK: Only run if the sheet doesn't already exist to prevent redundant API calls
  if (dataSS.getSheetByName(targetSheetName)) {
    Logger.log(`autoUpdateHistoricalRosters: ${targetSheetName} already exists. Skipping.`);
    return;
  }

  // 4. EXECUTE
  Logger.log(`autoUpdateHistoricalRosters: Week ${targetWeek} concluded. Triggering snapshot for ${currentYear}...`);
  updateHistoricalRosters(currentYear, targetWeek);
}

/**
 * CORE LOGIC
 * Fetches rosters for all teams for any given year/week combination.
 * * @param {number|string} yearRequested - The year to pull (defaults to 2025)
 * @param {number} week - The fantasy week to pull (defaults to 16)
 */
function updateHistoricalRosters(yearRequested = 2025, week = 16) {
  const ss = getPrimarySS();
  const keysRange = ss.getRangeByName("LEAGUE_KEYS_HISTORY");

  if (!keysRange) {
    Logger.log("updateHistoricalRosters: Named range LEAGUE_KEYS_HISTORY not found.");
    return;
  }

  const keysData = keysRange.getValues();
  
  // Find the league key for the requested year. String() handles potential undefined/null safely.
  const row = keysData.find(r => r && r[0] && String(r[0]) === String(yearRequested));
  
  if (!row || !row[2]) {
    Logger.log(`updateHistoricalRosters: No league key found for year ${yearRequested} in LEAGUE_KEYS_HISTORY.`);
    return;
  }

  const leagueKey = row[2].toString().trim();
  Logger.log(`updateHistoricalRosters: Fetching rosters for ${yearRequested} (Key: ${leagueKey}), Week ${week}...`);

  // Load player maps for ID resolution
  const maps = getPlayerMaps("MLBID");
  
  const teamCount = 12; 
  const rosterData = [["TeamID", "IDPLAYER", "PlayerName", "Position", "Status"]];

  for (let tId = 1; tId <= teamCount; tId++) {
    // Construct the Yahoo URL using the dynamic league key
    const url = `https://fantasysports.yahooapis.com/fantasy/v2/team/${leagueKey}.t.${tId}/roster;week=${week}?format=json`;
    const json = fetchYahooAPI(url);
    
    if (json && json.fantasy_content && json.fantasy_content.team) {
      const teamObj = json.fantasy_content.team;
      const players = teamObj[1].roster["0"].players;

      Object.keys(players).forEach(key => {
        if (key === "count") return;
        
        const rawPlayer = players[key].player;
        const p = parseYahooPlayer(rawPlayer); // Uses the helper in helperFunctions.gs
        
        // Resolve IDPLAYER to link these names to stats later
        const masterId = resolveMasterId(maps, p.pId, p.pId, p.name, 'updateHistoricalRosters', p.team);

        rosterData.push([tId, masterId, p.name, p.positions, p.status]);
      });
    } else {
      Logger.log(`updateHistoricalRosters: Failed to fetch Team ${tId} for ${yearRequested}.`);
    }
    
    // Throttle to respect Yahoo rate limits
    Utilities.sleep(150);
  }

  const outputSheetName = `_HIST_ROSTERS_${yearRequested}_W${week}`;
  writeToData(outputSheetName, rosterData);
  
  // Log the completion and timestamp the Primary workbook
  updateTimestamp('UPDATE_HISTORICAL_ROSTERS');
  Logger.log(`Successfully wrote rosters to ${outputSheetName} and updated timestamp.`);
  
  // Flush any new players to the ID Map for manual cleaning
  flushIdMatchingQueue();
}