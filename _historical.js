/**
 * @file _historical.gs
 * @description Master historical engine. Consolidates all-time records into single
 * database-style sheets in the Archive Workbook. 
 * @dependencies _helpers.gs, _auth.gs, resolvePlayer.gs
 * @writesTo Archive Workbook (_TEAM_STATS, _ROSTERS, _DRAFTS)
 */

// ============================================================================
//  HISTORICAL YAHOO TEAM STATS (CONSOLIDATED)
// ============================================================================

function updateHistoricalYahooTeamStats(year) {
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
//  HISTORICAL YAHOO ROSTERS (CONSOLIDATED MASTER)
// ============================================================================

function updateHistoricalYahooRosters(backfillYear, backfillWeek) {
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

  for (let tId = 1; tId <= 12; tId++) {
    const url = `https://fantasysports.yahooapis.com/fantasy/v2/team/${leagueKey}.t.${tId}/roster;week=${targetWeek}?format=json`;
    const json = _fetchYahooAPI(url);
    
    if (json?.fantasy_content?.team) {
      const players = json.fantasy_content.team[1].roster["0"].players;
      Object.keys(players).forEach(key => {
        if (key === "count") return;
        const p = _parseYahooPlayer(players[key].player);
        const primaryId = resolvePrimaryId(maps, p.pId, null, null, p.name, 'updateHistoricalRosters', p.team);
        
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

  const archiveSS = getArchiveSS();
  let sheet = archiveSS.getSheetByName(masterSheetName);
  let masterRosterData = [];
  const header = ['YEAR', 'WEEK', 'TEAM_ID', 'ROSTER', 'IDPLAYER', 'YAHOOID', 'PLAYER', 'POSITION'];

  if (sheet && sheet.getLastRow() > 0) {
    masterRosterData = sheet.getDataRange().getValues();
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

function runBackfillManual() {
  const years = [2023, 2024]; 
  years.forEach(yr => {
    updateHistoricalYahooRosters(yr, 16);
  });
}

// ============================================================================
//  SEASON ARCHIVE (END OF YEAR ROLLOVER)
// ============================================================================

function archiveSeason() {
  const ss = getPrimarySS();
  const dataSS = getDataSS();
  const archiveSS = getArchiveSS();
  const currentYear = ss.getRangeByName('CURRENT_YEAR').getValue();

  const engineSheet = dataSS.getSheetByName('_DRAFT');
  if (engineSheet && engineSheet.getLastRow() > 1) {
    const engineData = engineSheet.getDataRange().getValues();
    let archiveSheet = archiveSS.getSheetByName('_DRAFTS');
    
    if (!archiveSheet) {
      archiveSheet = archiveSS.insertSheet('_DRAFTS');
      archiveSheet.appendRow(['YEAR', ...engineData[0]]);
    }
    
    let existingArchive = archiveSheet.getDataRange().getValues();
    let filteredArchive = existingArchive.filter(r => String(r[0]) !== String(currentYear));
    
    const rowsToArchive = engineData.slice(1).map(row => [currentYear, ...row]);
    filteredArchive.push(...rowsToArchive);
    
    writeToArchive('_DRAFTS', filteredArchive);
    engineSheet.deleteRows(2, engineSheet.getLastRow() - 1);
  }

  const transSheet = dataSS.getSheetByName('_TRANSACTIONS');
  if (transSheet && transSheet.getLastRow() > 1) {
    transSheet.deleteRows(2, transSheet.getLastRow() - 1);
  }

  const displaySheet = ss.getSheetByName('Draft');
  if (displaySheet && displaySheet.getLastRow() >= 4) {
    displaySheet.getRange(4, 1, displaySheet.getLastRow() - 3, displaySheet.getMaxColumns()).clearContent();
  }
  
  Logger.log(`Season ${currentYear} successfully archived.`);
}

// ============================================================================
//  JSON PAYLOAD IMPORT TOOL
// ============================================================================

function runPayloadImport() {
  const targetYear = 2025;         
  const systemName = "OOPSY";    
  const playerType = "Pitcher";    
  
  const driveFileId = "1hAH8QDkTug8IyHIj9wLK5t7bf-2RIzqp"; 
  
  Logger.log(`Starting JSON Payload import for ${systemName} ${targetYear} (${playerType}s)...`);
  
  _processJsonPayload(systemName, targetYear, playerType, driveFileId);
}

function _processJsonPayload(systemName, year, type, fileId) {
  const archiveSS = getArchiveSS();
  if (!archiveSS) return;

  let rawJsonString;
  try {
    const file = DriveApp.getFileById(fileId);
    rawJsonString = file.getBlob().getDataAsString();
  } catch (e) {
    Logger.log(`ERROR: Failed to load file from Drive. Check your File ID. Error: ${e.message}`);
    return;
  }

  let jsonData;
  try {
    jsonData = JSON.parse(rawJsonString);
  } catch (e) {
    Logger.log(`ERROR: Failed to parse JSON. Make sure the file is valid JSON text. Error: ${e.message}`);
    return;
  }

  const playerList = Array.isArray(jsonData) ? jsonData : (jsonData.data || []);
  
  if (playerList.length === 0) {
    Logger.log("No players found in the JSON payload.");
    return;
  }

  const excludeKeys = new Set([
    'playerid', 'playerids', 'xmlbamid', 'playername', 'team', 'shortname', 
    'league', 'upurl', 'teamid', 'minpos', 'name'
  ]);

  const statHeaders = [];
  const firstPlayer = playerList[0];
  Object.keys(firstPlayer).forEach(key => {
    if (!excludeKeys.has(key.toLowerCase())) {
      statHeaders.push(key);
    }
  });

  const finalHeaders = ["IDPLAYER", "IDFANGRAPHS", "YEAR", "PROJECTIONS", "TYPE", "PLAYERNAME", "TEAM", ...statHeaders];
  const formattedRows = [];
  const maps = getPlayerMaps('IDFANGRAPHS');

  playerList.forEach(player => {
    const fgId = (player.playerid || player.playerids || "").toString().trim();
    const mlbId = (player.xMLBAMID || "").toString().trim();
    const pName = (player.PlayerName || player.Name || "").toString().trim();
    const team = (player.Team || "").toString().trim();

    if (!fgId || !pName) return;

    // FIX: Passed null for Yahoo ID 
    const primaryId = resolvePrimaryId(maps, null, mlbId, fgId, pName, `payloadImport_${systemName}`, team);

    const newRow = [
      primaryId,
      fgId,
      year,
      systemName,
      "Pre-Season", 
      pName,
      team
    ];

    statHeaders.forEach(statKey => {
      newRow.push(player[statKey] !== undefined && player[statKey] !== null ? player[statKey] : "");
    });

    formattedRows.push(newRow);
  });

  if (formattedRows.length === 0) return;

  const archiveSheetName = type === "Batter" ? '_ARCHIVE_PROJ_B' : '_ARCHIVE_PROJ_P';
  let archiveSheet = archiveSS.getSheetByName(archiveSheetName);
  
  if (!archiveSheet) {
    archiveSheet = archiveSS.insertSheet(archiveSheetName);
    archiveSheet.appendRow(finalHeaders);
  } else if (archiveSheet.getLastRow() === 0) {
    archiveSheet.appendRow(finalHeaders);
  }

  const startRow = archiveSheet.getLastRow() + 1;
  archiveSheet.getRange(startRow, 1, formattedRows.length, formattedRows[0].length).setValues(formattedRows);
  
  Logger.log(`Successfully imported ${formattedRows.length} ${type}s for ${systemName} ${year}.`);
  flushIdMatchingQueue(); 
}

function backfillFanGraphsActuals(year = 2025) {
  const maps = getPlayerMaps('IDFANGRAPHS');
  const ss = getPrimarySS();
  
  ss.toast(`Fetching ${year} FanGraphs Batting Actuals...`, "Backfilling", -1);
  Logger.log(`Fetching ${year} FanGraphs Batting Actuals...`);
  const batData = _fetchAndMergeFanGraphs(year, maps, 'bat', FG_BAT_TYPES, FG_BAT_COLUMNS);
  
  if (batData && batData.length > 1) {
    writeToArchive('_FG_B', batData);
    Logger.log(`${year} Batting archived successfully.`);
  }

  ss.toast(`Fetching ${year} FanGraphs Pitching Actuals...`, "Backfilling", -1);
  Logger.log(`Fetching ${year} FanGraphs Pitching Actuals...`);
  const pitData = _fetchAndMergeFanGraphs(year, maps, 'pit', FG_PITCH_TYPES, FG_PITCH_COLUMNS);
  
  if (pitData && pitData.length > 1) {
    writeToArchive('_FG_P', pitData);
    Logger.log(`${year} Pitching archived successfully.`);
  }
  
  ss.toast(`${year} FanGraphs Actuals have been successfully vaulted.`, "Complete", 5);
}