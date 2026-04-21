/**
 * @file dataFanGraphs.gs
 * @description Centralized engine for fetching all FanGraphs data.
 * Includes cumulative season stats (Batting & Pitching), Projections, and Prospects.
 * @dependencies _helpers.gs, resolvePlayer.gs
 * @writesTo _FG_B, _FG_P, _FG_PROJ_B, _FG_PROJ_P, _FG_PROSP, and Archive workbook
 */

// ============================================================================
//  CONSTANTS & TARGET SCHEMAS
// ============================================================================

const FG_LEADERBOARD_BASE = 'https://www.fangraphs.com/api/leaders/major-league/data?pos=all&lg=all&qual=0&month=0&hand=&team=0&pageitems=2000000&pagenum=1&ind=0&rost=0&players=&sortdir=default&sortstat=WAR';

const FG_BAT_TYPES = [8, 1, 2, 7, 5, 24, 6]; 
const FG_PITCH_TYPES = [0, 1, 2, 23, 24, 36, 44]; 

const FG_BAT_COLUMNS = [
  "IDPLAYER", "IDFANGRAPHS", "YEAR", "PlayerName", "TeamNameAbb", "Age", "G", "AB", "PA", "H", "1B", "2B", "3B", "HR", "R", "RBI", "BB", "SO", "HBP", "SF", "SH", "SB", "CS", "AVG", "BB%", "K%", "BB/K", "OBP", "SLG", "OPS", "ISO", "BABIP", "GB/FB", "LD%", "GB%", "FB%", "IFFB%", "HR/FB", "wOBA", "wRAA", "wRC", "Batting", "BaseRunning", "Positional", "Offense", "Spd", "wRC+", "wBsR", "O-Swing%", "Z-Swing%", "Swing%", "O-Contact%", "Z-Contact%", "Contact%", "Zone%", "F-Strike%", "SwStr%", "CStr%", "C+SwStr%", "Pull%", "Cent%", "Oppo%", "Soft%", "Med%", "Hard%", "AVG+", "BB%+", "K%+", "OBP+", "SLG+", "ISO+", "BABIP+", "LD%+", "GB%+", "FB%+", "HRFB%+", "Pull%+", "Cent%+", "Oppo%+", "Soft%+", "Med%+", "Hard%+", "xwOBA", "xAVG", "xSLG", "XBR", "AvgBatSpeed", "FastSwing%", "SwingLength", "SquaredUpContact%", "SquaredUpSwing%", "BlastContact%", "BlastSwing%", "Tilt", "AttackAngle", "AttackDirection", "IdealAttackAngle%", "EV", "LA", "Barrel%", "maxEV", "HardHit%", "EV90"
];

const FG_PITCH_COLUMNS = [
  "IDPLAYER", "IDFANGRAPHS", "YEAR", "Name", "Team", "Age", "W", "L", "ERA", "G", "GS", "QS", "CG", "SV", "HLD", "BS", "IP", "TBF", "H", "R", "ER", "HR", "BB", "IBB", "HBP", "SO", "K/9", "BB/9", "K/BB", "HR/9", "K%", "BB%", "K-BB%", "WHIP", "BABIP", "FIP", "E-F", "xFIP", "SIERA", "GB/FB", "LD%", "GB%", "FB%", "IFFB%", "HR/FB", "EV", "EV90", "LA", "Barrel%", "HardHit%", "xERA", "sp_stuff", "sp_location", "sp_pitching"
];

// ============================================================================
//  BATTING STATS
// ============================================================================

function updateFanGraphsBatting() {
  const ss = getPrimarySS();
  const currentYear = parseInt(ss.getRangeByName('CURRENT_YEAR')?.getValue(), 10);
  if (!currentYear) return;

  const prevYear = currentYear - 1;
  const maps = getPlayerMaps('IDFANGRAPHS');
  
  const archiveSS = getArchiveSS();
  if (archiveSS) {
    const archiveSheet = archiveSS.getSheetByName('_FG_B');
    if (_readFgYear(archiveSheet) !== prevYear) {
      const prevData = _fetchAndMergeFanGraphs(prevYear, maps, 'bat', FG_BAT_TYPES, FG_BAT_COLUMNS);
      if (prevData && prevData.length > 1) writeToArchive('_FG_B', prevData);
    }
  }

  const currentData = _fetchAndMergeFanGraphs(currentYear, maps, 'bat', FG_BAT_TYPES, FG_BAT_COLUMNS);
  if (currentData && currentData.length > 1) {
    try {
      writeToData('_FG_B', currentData);
      _updateTimestamp('UPDATE_FG_BAT');
    } catch (e) {
      Logger.log(`Failed to write FG Batting: ${e.message}`);
    }
  }
}

// ============================================================================
//  PITCHING STATS
// ============================================================================

function updateFanGraphsPitching() {
  const ss = getPrimarySS();
  const currentYear = parseInt(ss.getRangeByName('CURRENT_YEAR')?.getValue(), 10);
  if (!currentYear) return;

  const prevYear = currentYear - 1;
  const maps = getPlayerMaps('IDFANGRAPHS');
  
  const archiveSS = getArchiveSS();
  if (archiveSS) {
    const archiveSheet = archiveSS.getSheetByName('_FG_P');
    if (_readFgYear(archiveSheet) !== prevYear) {
      const prevData = _fetchAndMergeFanGraphs(prevYear, maps, 'pit', FG_PITCH_TYPES, FG_PITCH_COLUMNS);
      if (prevData && prevData.length > 1) writeToArchive('_FG_P', prevData);
    }
  }

  const currentData = _fetchAndMergeFanGraphs(currentYear, maps, 'pit', FG_PITCH_TYPES, FG_PITCH_COLUMNS);
  if (currentData && currentData.length > 1) {
    try {
      writeToData('_FG_P', currentData);
      _updateTimestamp('UPDATE_FG_PITCH');
    } catch(e) {
      Logger.log(`Failed to write FG Pitching: ${e.message}`);
    }
  }
}

// ============================================================================
//  INTERNAL MERGE ENGINE
// ============================================================================

function _fetchAndMergeFanGraphs(year, maps, statType, typeArray, targetSchema) {
  const urls = typeArray.map(t => `${FG_LEADERBOARD_BASE}&stats=${statType}&season=${year}&season1=${year}&type=${t}`);
  const responses = _fetchAllYahooAPI(urls); 
  
  const playerMap = {};
  let anyData = false;

  const schemaKeys = new Set(targetSchema);

  responses.forEach(resp => {
    if (!resp || !resp.data || resp.data.length === 0) return;
    anyData = true;

    resp.data.forEach(row => {
      const fgIdRaw = row.playerid || row.playerids || row.PlayerId;
      const fgId = fgIdRaw ? fgIdRaw.toString() : null;
      if (!fgId) return;

      if (!playerMap[fgId]) playerMap[fgId] = {};
      
      Object.keys(row).forEach(key => {
        if (schemaKeys.has(key) || key === 'PlayerName' || key === 'Name' || key === 'Team' || key === 'TeamNameAbb' || key === 'xMLBAMID') {
          playerMap[fgId][key] = row[key];
        }
      });
    });
  });

  if (!anyData) return null;

  const outputRows = [targetSchema];

  Object.values(playerMap).forEach(row => {
    const fgIdRaw = row.playerid || row.playerids || row.PlayerId;
    const fgId = fgIdRaw ? fgIdRaw.toString() : "";
    
    // SAFE MLB ID CHECK: Correctly extracts mlbamid and assigns it to 'mlbId' variable to prevent ReferenceErrors
    const mlbIdRaw = row.xMLBAMID || row.MLBAMID || row.mlbamid;
    const mlbId = mlbIdRaw ? mlbIdRaw.toString() : null;
    
    const pNameRaw = row.PlayerName || row.Name || row.playerName || "";
    const pTeamRaw = row.TeamNameAbb || row.Team || row.team || "";
    const pName = pNameRaw.toString().replace(/<[^>]+>/g, '').trim();
    const teamAbbr = pTeamRaw.toString().replace(/<[^>]+>/g, '').trim();
    
    // Calls resolver using strictly 'mlbId' (never mlbamId)
    const primaryId = resolvePrimaryId(maps, fgId, mlbId, fgId, pName, 'updateFanGraphsStats', teamAbbr);

    const dataRow = targetSchema.map(col => {
      if (col === "IDPLAYER") return primaryId;
      if (col === "IDFANGRAPHS") return fgId;
      if (col === "YEAR") return year;
      
      let val = row[col];
      if (typeof val === 'string') val = val.replace(/<[^>]+>/g, '').trim();
      return (val !== null && val !== undefined) ? val : "";
    });

    outputRows.push(dataRow);
  });

  return outputRows;
}

function _readFgYear(sheet) {
  if (!sheet || sheet.getLastRow() < 2) return 0;
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const yearIdx = headers.indexOf('YEAR');
  if (yearIdx === -1) return 0;
  return parseInt(sheet.getRange(2, yearIdx + 1).getValue(), 10) || 0;
}

// ============================================================================
//  PROJECTIONS CONSTANTS
// ============================================================================

const FG_PROJ_BASE_URL = 'https://www.fangraphs.com/api/projections';

const FG_BAT_PROJ_GROUPS = {
  "ATC":          [{ id: "atc", type: "Pre-Season" }, { id: "ratcdc", type: "ROS" }],
  "Depth Charts": [{ id: "fangraphsdc", type: "Pre-Season" }, { id: "rfangraphsdc", type: "ROS" }],
  "OOPSY":        [{ id: "oopsy", type: "Pre-Season" }, { id: "roopsydc", type: "ROS" }],
  "Steamer":      [{ id: "steamer", type: "Pre-Season" }, { id: "steamerr", type: "ROS" }],
  "THE BAT":      [{ id: "thebat", type: "Pre-Season" }, { id: "rthebat", type: "ROS" }],
  "THE BAT X":    [{ id: "thebatx", type: "Pre-Season" }, { id: "rthebatx", type: "ROS" }],
  "ZiPS":         [{ id: "zips", type: "Pre-Season" }, { id: "rzips", type: "ROS" }],
  "ZiPS DC":      [{ id: "zipsdc", type: "Pre-Season" }, { id: "rzipsdc", type: "ROS" }]

};

const FG_PITCH_PROJ_GROUPS = {
  "ATC":          [{ id: "atc", type: "Pre-Season" }, { id: "ratcdc", type: "ROS" }],
  "Depth Charts": [{ id: "fangraphsdc", type: "Pre-Season" }, { id: "rfangraphsdc", type: "ROS" }],
  "OOPSY":        [{ id: "oopsy", type: "Pre-Season" }, { id: "roopsydc", type: "ROS" }],
  "Steamer":      [{ id: "steamer", type: "Pre-Season" }, { id: "steamerr", type: "ROS" }],
  "THE BAT":      [{ id: "thebat", type: "Pre-Season" }, { id: "rthebat", type: "ROS" }],
  "THE BAT X":    [{ id: "thebatx", type: "Pre-Season" }, { id: "rthebatx", type: "ROS" }],
  "ZiPS":         [{ id: "zips", type: "Pre-Season" }, { id: "rzips", type: "ROS" }],
  "ZiPS DC":      [{ id: "zipsdc", type: "Pre-Season" }, { id: "rzipsdc", type: "ROS" }]
};

// ============================================================================
//  PROJECTIONS ENGINE
// ============================================================================

function updateFanGraphsBattingProjections() {
  _updateFanGraphsProjections(FG_BAT_PROJ_GROUPS, 'bat', '_FG_PROJ_B', 'B');
}

function updateFanGraphsPitchingProjections() {
  _updateFanGraphsProjections(FG_PITCH_PROJ_GROUPS, 'pit', '_FG_PROJ_P', 'P');
}

function _updateFanGraphsProjections(projGroups, statType, outputSheet, typeSuffix) {
  const ss = getPrimarySS();
  const currentYear = parseInt(ss.getRangeByName('CURRENT_YEAR')?.getValue(), 10);
  if (!currentYear) return;

  const maps = getPlayerMaps('IDFANGRAPHS');
  const idCache = {}; 
  const requestQueue = [];
  const metaQueue = [];

  for (let groupName in projGroups) {
    projGroups[groupName].forEach(variant => {
      let rangeName = `UPDATE_${groupName.toUpperCase()}`;
      if (variant.type === 'ROS') rangeName += '_ROS';
      rangeName += `_${typeSuffix}`;
      
      requestQueue.push(`${FG_PROJ_BASE_URL}?pos=all&stats=${statType}&type=${variant.id}&team=0&players=0&lg=all`);
      metaQueue.push({ groupName, sysType: variant.type, rangeName });
      
      _setStatusIcon(ss, rangeName, '=ICON_UPDATE');
    });
  }
  
  SpreadsheetApp.flush();

  const options = { muteHttpExceptions: true, headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } };
  const requests = requestQueue.map(url => ({ url: url, ...options }));
  
  let responses;
  try { 
    responses = UrlFetchApp.fetchAll(requests); 
  } catch (e) { 
    _logError('dataFanGraphs.gs', `Projection Fetch Error: ${e.message}`, 'CRITICAL'); 
    metaQueue.forEach(meta => _setStatusIcon(ss, meta.rangeName, '=ICON_FAIL'));
    return; 
  }

  const allObjects = [];
  const allKeys = new Set();
  const systemStatuses = {}; 
  let hasValidDataToWrite = false;

  responses.forEach((response, idx) => {
    const meta = metaQueue[idx];
    const rName = meta.rangeName;
    
    if (!response || response.getResponseCode() !== 200) {
      Logger.log(`Skipped ${meta.groupName}|${meta.sysType} - Bad Response Code`);
      systemStatuses[rName] = '=ICON_FAIL';
      return;
    }

    let json;
    try { 
      json = JSON.parse(response.getContentText()); 
    } catch (e) { 
      Logger.log(`Skipped ${meta.groupName}|${meta.sysType} - Failed to parse JSON.`);
      systemStatuses[rName] = '=ICON_FAIL';
      return; 
    }
    
    const data = Array.isArray(json) ? json : (json?.data || []);
    if (data.length > 0) {
      let validPlayerCount = 0;
      
      data.forEach(row => {
        const fgIdRaw = row.playerids || row.playerid || row.PlayerId || row.PLAYERID;
        const fgId = fgIdRaw ? fgIdRaw.toString() : "";
        if (!fgId) return; 
        
        validPlayerCount++;
        
        // Ensure mlbId is defined identically to avoid ReferenceError
        const mlbIdRaw = row.xMLBAMID || row.MLBAMID || row.mlbamid;
        const mlbId = mlbIdRaw ? mlbIdRaw.toString() : null;
        
        const pNameRaw = row.PlayerName || row.name || row.playerName || "";
        const pName = pNameRaw.toString().replace(/<[^>]+>/g, '').trim();
        
        const teamRaw = row.Team || row.TeamNameAbb || row.team || "";
        const teamAbbr = teamRaw.toString().replace(/<[^>]+>/g, '').trim();
        
        const cacheKey = `${fgId}_${mlbId}_${pName}`;
        if (!idCache[cacheKey]) {
          idCache[cacheKey] = resolvePrimaryId(maps, fgId, mlbId, fgId, pName, `updateFGProj_${statType}`, teamAbbr);
        }

        row["IDPLAYER"]    = idCache[cacheKey];
        row["IDFANGRAPHS"] = fgId;
        row["YEAR"]        = currentYear;
        row["Projections"] = meta.groupName;
        row["Type"]        = meta.sysType;
        
        Object.keys(row).forEach(key => allKeys.add(key));
        allObjects.push(row);
      });

      if (validPlayerCount > 0) {
        systemStatuses[rName] = '=ICON_PASS';
        hasValidDataToWrite = true;
      } else {
        systemStatuses[rName] = '=ICON_FAIL';
      }
    } else {
      systemStatuses[rName] = '=ICON_PASS_LIGHT';
    }
  });

  if (hasValidDataToWrite && allObjects.length > 0) {
    allKeys.delete("IDPLAYER");
    allKeys.delete("IDFANGRAPHS");
    allKeys.delete("YEAR");
    allKeys.delete("Projections");
    allKeys.delete("Type");
    
    const headers = ["IDPLAYER", "IDFANGRAPHS", "YEAR", "Projections", "Type", ...Array.from(allKeys)];
    const outputData = [headers];
    
    allObjects.forEach(rowObj => {
      outputData.push(headers.map(key => rowObj.hasOwnProperty(key) ? rowObj[key] : ""));
    });
    
    try {
      writeToData(outputSheet, outputData);
      _updateTimestamp(`UPDATE_FG_PROJECTIONS_${typeSuffix}`);
      Object.entries(systemStatuses).forEach(([rName, icon]) => _setStatusIcon(ss, rName, icon));
    } catch(e) {
      Object.entries(systemStatuses).forEach(([rName, icon]) => {
        if (icon === '=ICON_PASS') _setStatusIcon(ss, rName, '=ICON_FAIL');
        else _setStatusIcon(ss, rName, icon);
      });
    }
  } else {
    Object.entries(systemStatuses).forEach(([rName, icon]) => _setStatusIcon(ss, rName, icon));
  }
}

function _setStatusIcon(ss, rangeName, iconFormula) {
  try {
    const range = ss.getRangeByName(rangeName);
    if (range) {
      range.setFormula(iconFormula);
    }
  } catch (e) {
    Logger.log(`Error setting status for ${rangeName}: ${e.message}`);
  }
}

// ============================================================================
//  PROSPECTS
// ============================================================================

const FG_PROSP_COLUMNS = [
  "IDPLAYER", "IDFANGRAPHS", "Type", "Season", "playerName", "Age", "Height", "Weight", "Bats", "Throws", 
  "Team", "llevel", "mlevel", "Position", "Ovr_Rank", "Org_Rank", "FV_Current", "ETA_Current", 
  "School", "Summary", "pHit", "fHit", "pGame", "fGame", "pRaw", "fRaw", "pSpd", "fSpd", 
  "pFld", "fFld", "pArm", "Variance", "BirthDate", "TLDR", "Athleticism", "Frame", 
  "Performer", "Dist_Raw", "Player_Type", "Amateur_Rk", "Signed_Yr", "Signed_Mkt", 
  "Signed_Org", "Draft_Rnd", "School_Type", "Country", "Pitch_Sel", "Bat_Ctrl", 
  "Fantasy_Redraft", "Fantasy_Dynasty", "HardHit%", "Levers", "Versatility", "Contact_Style", 
  "Vel", "pFB", "fFB", "pSL", "fSL", "pCB", "fCB", "pCH", "fCH", "pCT", "fCT", "pCMD", "fCMD", 
  "Range", "Touch", "Delivery", "FBType", "pSPL", "fSPL", "bRPM", "fRPM", "TJDate"
];

function updateFanGraphsProspects() {
  const ss = getPrimarySS();
  const currentYear = parseInt(ss.getRangeByName("CURRENT_YEAR")?.getValue(), 10);
  if (!currentYear) return;

  const prevYear = currentYear - 1;
  const maps = getPlayerMaps('IDFANGRAPHS');
  const archiveSS = getArchiveSS();

  if (archiveSS) {
    const archiveSheet = archiveSS.getSheetByName('_FG_PROSP');
    if (_readFgYear(archiveSheet) !== prevYear) {
      const prevData = _fetchProspectData(prevYear, maps);
      if (prevData && prevData.length > 1) writeToArchive('_FG_PROSP', prevData);
    }
  }

  const currentData = _fetchProspectData(currentYear, maps);
  if (currentData && currentData.length > 1) {
    try {
      writeToData('_FG_PROSP', currentData);
      _updateTimestamp('UPDATE_FG_PROSP');
    } catch(e) {
      Logger.log(`Failed to write FG Prospects: ${e.message}`);
    }
  }
}

function _fetchProspectData(year, maps) {
  const outputData = [FG_PROSP_COLUMNS];
  const boards = [
    { draftId: `${year}prospect`, name: "Prospect_List_Report" },
    { draftId: `${year}updated`,  name: "Prospect_List_Updated" }
  ];

  const requests = boards.map(b => ({
    url: `https://www.fangraphs.com/api/prospects/board/data?draft=${b.draftId}&season=${year}&playerid=&position=&team=&type=0`,
    muteHttpExceptions: true, headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
  }));

  const responses = UrlFetchApp.fetchAll(requests);

  responses.forEach((resp, idx) => {
    if (resp.getResponseCode() !== 200) return;
    
    let data;
    try { data = JSON.parse(resp.getContentText()); } catch (e) { return; }
    
    let playerList = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);

    playerList.forEach(player => {
      player["Type"] = boards[idx].name;
      player["Season"] = year;
      
      const fgIdRaw = player["PlayerId"] || player["playerid"] || player["playerids"];
      const fgId = fgIdRaw ? fgIdRaw.toString() : "";
      
      const mlbIdRaw = player["xMLBAMID"] || player["MLBAMID"] || player["mlbamid"];
      const mlbId = mlbIdRaw ? mlbIdRaw.toString() : null;
      
      const pName = (player["playerName"] || player["Name"] || "").toString().replace(/<[^>]+>/g, '').trim();
      const teamAbbr = (player["Team"] || player["team"] || "").toString().replace(/<[^>]+>/g, '').trim();

      player["IDPLAYER"] = resolvePrimaryId(maps, fgId, mlbId, fgId, pName, 'updateFanGraphsProspects', teamAbbr);
      player["IDFANGRAPHS"] = fgId;

      const rowData = FG_PROSP_COLUMNS.map(key => {
        let val = player[key];
        if (typeof val === 'string') val = val.replace(/<[^>]+>/g, '').trim();
        return (val !== null && val !== undefined) ? val : "";
      });
      outputData.push(rowData);
    });
  });

  return outputData;
}