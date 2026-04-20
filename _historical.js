/**
 * @file _historical.gs
 * @description Master historical engine. Consolidates all-time records into single
 * database-style sheets in the Archive Workbook. 
 * @dependencies _helpers.gs, _auth.gs, resolvePlayer.gs
 * @writesTo Archive Workbook (_TEAM_STATS, _ROSTERS, _DRAFTS)
 */

// ============================================================================
//  HISTORICAL TEAM STATS (CONSOLIDATED)
// ============================================================================

/**
 * Fetches final season stats and appends them to a master historical sheet.
 * @param {number|string} year - Optional. Target year. Defaults to current year - 1.
 */
function updateHistoricalTeamStats(year) {
  const ss = getPrimarySS();
  const targetYear = year || parseInt(ss.getRangeByName("CURRENT_YEAR").getValue()) - 1;
  const keysRange = ss.getRangeByName("LEAGUE_KEYS_HISTORY");

  if (!keysRange) {
    _logError('_historical.gs', 'Missing Named Range: LEAGUE_KEYS_HISTORY', 'HIGH');
    return;
  }

  const keysData = keysRange.getValues();
  const row = keysData.find(r => r && String(r[0]) === String(targetYear));
  
  if (!row || !row[2]) {
    _logError('_historical.gs', `No league key found for year ${targetYear}.`, 'HIGH');
    return;
  }

  const leagueKey = row[2].toString().trim();
  const urls = [
    `https://fantasysports.yahooapis.com/fantasy/v2/league/${leagueKey}/settings?format=json`,
    `https://fantasysports.yahooapis.com/fantasy/v2/league/${leagueKey}/teams/stats?format=json`
  ];
  
  const [settingsData, statsData] = _fetchAllYahooAPI(urls);
  if (!settingsData || !statsData) return;

  const categories = settingsData.fantasy_content?.league?.[1]?.settings?.[0]?.stat_categories?.stats;
  const statMap = {};
  if (categories) categories.forEach(s => statMap[s.stat.stat_id] = s.stat.display_name);

  const teamsDict = statsData.fantasy_content?.league?.[1]?.teams;
  if (!teamsDict) return;

  const firstTeamStats = teamsDict['0']?.team?.find(item => item?.team_stats)?.team_stats?.stats || [];
  const statHeaders = firstTeamStats.map(s => statMap[s.stat.stat_id] || `Stat_${s.stat.stat_id}`);
  
  const newHeader = ['YEAR', 'TEAM_ID', 'MANAGER_ID', 'ROSTER', ...statHeaders];
  const newRows = [];

  for (let i = 0; i < teamsDict.count; i++) {
    const t = teamsDict[i.toString()]?.team;
    if (!t) continue;

    const meta = t[0];
    const teamId = meta.find(item => item?.team_id)?.team_id || '';
    const rosterName = meta.find(item => item?.name)?.name || '';
    const mId = meta.find(item => item?.managers)?.managers?.[0]?.manager?.manager_id || '';
    const statVals = t.find(item => item?.team_stats)?.team_stats.stats.map(s => s.stat.value || '0') || [];
    
    newRows.push([targetYear, teamId, mId, rosterName, ...statVals]);
  }

  // Consolidation Logic: Load existing archive and merge
  const archiveSS = getArchiveSS();
  let sheet = archiveSS.getSheetByName('_TEAM_STATS');
  let masterData = [];

  if (sheet && sheet.getLastRow() > 0) {
    masterData = sheet.getDataRange().getValues();
    // Remove existing rows for this year to prevent duplicates on re-run
    masterData = masterData.filter(r => String(r[0]) !== String(targetYear));
  } else {
    masterData.push(newHeader);
  }

  masterData.push(...newRows);
  writeToArchive('_TEAM_STATS', masterData);
  _updateTimestamp('UPDATE_HISTORICAL_TEAM_STATS');
}

// ============================================================================
//  HISTORICAL ROSTERS (CONSOLIDATED MASTER)
// ============================================================================

/**
 * Fetches rosters and appends them to a single master database sheet.
 * SCHEMA: YEAR, WEEK, TEAM_ID, ROSTER, IDPLAYER, YAHOOID, PLAYER, POSITION
 */
function updateHistoricalRosters(backfillYear, backfillWeek) {
  const ss = getPrimarySS();
  const dataSS = getDataSS();
  
  const targetYear = backfillYear || parseInt(ss.getRangeByName("CURRENT_YEAR").getValue(), 10);
  const targetWeek = backfillWeek || 16; 
  const masterSheetName = '_ROSTERS';

  // 1. Determine League Key & Fetch Team Names
  let leagueKey;
  const teamNamesMap = {};

  if (backfillYear) {
    const keysRange = ss.getRangeByName("LEAGUE_KEYS_HISTORY");
    const row = keysRange.getValues().find(r => r && String(r[0]) === String(backfillYear));
    if (!row || !row[2]) return;
    leagueKey = row[2].toString().trim();
  } else {
    const leagueInfoSheet = dataSS.getSheetByName("_LEAGUE_INFO");
    if (!leagueInfoSheet) return;
    const currentWeekRow = leagueInfoSheet.getDataRange().getValues().find(r => r[1] === "current_week");
    if (currentWeekRow && parseInt(currentWeekRow[2]) <= targetWeek) return; 
    leagueKey = _getLeagueKey();
  }

  // Get Roster Names for this specific year
  const teamsData = _fetchYahooAPI(`https://fantasysports.yahooapis.com/fantasy/v2/league/${leagueKey}/teams?format=json`);
  if (teamsData?.fantasy_content?.league?.[1]?.teams) {
    const teams = teamsData.fantasy_content.league[1].teams;
    for (let i = 0; i < teams.count; i++) {
      const t = teams[i.toString()]?.team?.[0];
      const tid = t?.find(item => item?.team_id)?.team_id;
      const tname = t?.find(item => item?.name)?.name;
      if (tid) teamNamesMap[tid] = tname;
    }
  }

  const maps = getPlayerMaps("YAHOOID");
  const newRosterRows = [];

  // 2. Fetch rosters for all 12 teams
  for (let tId = 1; tId <= 12; tId++) {
    const url = `https://fantasysports.yahooapis.com/fantasy/v2/team/${leagueKey}.t.${tId}/roster;week=${targetWeek}?format=json`;
    const json = _fetchYahooAPI(url);
    
    if (json?.fantasy_content?.team) {
      const players = json.fantasy_content.team[1].roster["0"].players;
      Object.keys(players).forEach(key => {
        if (key === "count") return;
        const p = _parseYahooPlayer(players[key].player);
        const primaryId = resolvePrimaryId(maps, p.pId, null, null, p.name, 'updateHistoricalRosters', p.team);
        
        // NEW SCHEMA: YEAR (A), WEEK (B), TEAM_ID (C), ROSTER (D), IDPLAYER (E), YAHOOID (F), PLAYER (G), POSITION (H)
        newRosterRows.push([
          targetYear, 
          targetWeek, 
          tId, 
          teamNamesMap[tId] || '', 
          primaryId, 
          p.pId, 
          p.name, 
          p.positions
        ]);
      });
    }
    Utilities.sleep(200); 
  }

  // 3. Consolidate into Archive
  const archiveSS = getArchiveSS();
  let sheet = archiveSS.getSheetByName(masterSheetName);
  let masterRosterData = [];
  const header = ['YEAR', 'WEEK', 'TEAM_ID', 'ROSTER', 'IDPLAYER', 'YAHOOID', 'PLAYER', 'POSITION'];

  if (sheet && sheet.getLastRow() > 0) {
    masterRosterData = sheet.getDataRange().getValues();
    // Remove previous entries for this year/week to allow clean re-runs
    masterRosterData = masterRosterData.filter(r => !(String(r[0]) === String(targetYear) && String(r[1]) === String(targetWeek)));
  } else {
    masterRosterData.push(header);
  }

  masterRosterData.push(...newRosterRows);
  writeToArchive(masterSheetName, masterRosterData);
  
  _updateTimestamp('UPDATE_HISTORICAL_ROSTERS');
  flushIdMatchingQueue();
  Logger.log(`Consolidated rosters for ${targetYear} Week ${targetWeek} into ${masterSheetName}`);
}

/**
 * Utility to run backfills for any historical year
 */
function runBackfillManual() {
  const years = [2023, 2024]; // Add any years you need to backfill
  years.forEach(yr => {
    updateHistoricalRosters(yr, 16);
  });
}

// ============================================================================
//  SEASON ARCHIVE (END OF YEAR ROLLOVER)
// ============================================================================

/**
 * Vaults the current season's Draft and resets the Data engine.
 */
function archiveSeason() {
  const ss = getPrimarySS();
  const dataSS = getDataSS();
  const archiveSS = getArchiveSS();
  const currentYear = ss.getRangeByName('CURRENT_YEAR').getValue();

  // 1. Vault Draft to master historical draft sheet
  const engineSheet = dataSS.getSheetByName('_DRAFT');
  if (engineSheet && engineSheet.getLastRow() > 1) {
    const engineData = engineSheet.getDataRange().getValues();
    let archiveSheet = archiveSS.getSheetByName('_DRAFTS');
    
    if (!archiveSheet) {
      archiveSheet = archiveSS.insertSheet('_DRAFTS');
      archiveSheet.appendRow(['YEAR', ...engineData[0]]);
    }
    
    // Check if year already exists to prevent duplicates
    let existingArchive = archiveSheet.getDataRange().getValues();
    let filteredArchive = existingArchive.filter(r => String(r[0]) !== String(currentYear));
    
    const rowsToArchive = engineData.slice(1).map(row => [currentYear, ...row]);
    filteredArchive.push(...rowsToArchive);
    
    writeToArchive('_DRAFTS', filteredArchive);
    engineSheet.deleteRows(2, engineSheet.getLastRow() - 1);
  }

  // 2. Clear current Transactions
  const transSheet = dataSS.getSheetByName('_TRANSACTIONS');
  if (transSheet && transSheet.getLastRow() > 1) {
    transSheet.deleteRows(2, transSheet.getLastRow() - 1);
  }

  // 3. Clear the visual Draft board
  const displaySheet = ss.getSheetByName('Draft');
  if (displaySheet && displaySheet.getLastRow() >= 4) {
    displaySheet.getRange(4, 1, displaySheet.getLastRow() - 3, displaySheet.getMaxColumns()).clearContent();
  }
  
  Logger.log(`Season ${currentYear} successfully archived.`);
}