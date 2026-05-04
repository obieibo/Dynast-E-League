/**
 * @file resolvePlayer.gs
 * @description Universal player ID resolution engine. Maps platform-specific IDs 
 * (Yahoo, FanGraphs, MLBAM) to the Primary ID (IDPLAYER).
 * @dependencies _helpers.gs
 * @writesTo 'ID Matching' (flushes unresolved players to the sheet queue in the Primary Workbook)
 */

// ============================================================================
//  CONFIGURATION
// ============================================================================

/** * Sources listed here will NOT be written to the 'ID Matching' sheet if 
 * they fail to resolve. Add the exact source string passed into resolvePrimaryId.
 * (e.g., 'updateFanGraphsProspects', 'Savant__BS_B', 'updateYahooPlayers')
 */
const EXCLUDED_QUEUE_SOURCES = [
  'updateYahooPlayers',
  'updateFantasyProsRankings',
  'updateFanGraphsStats_bat',
  'updateFanGraphsStats_pit',
  'updateFanGraphsProspects', 
  'Savant__BS_B',
  'Savant__BS_P',
  'Savant__BS_RAW_B',
  'Savant__BS_RAW_P'
];


// ============================================================================
//  GLOBAL CACHES & QUEUES
// ============================================================================
let _playerMapsCache = {};
let _idMatchingQueue = new Map(); 
let _usedOverrideRows = new Set(); 


// ============================================================================
//  MAP LOADER
// ============================================================================

/**
 * Builds and caches dictionaries for ID resolution based on the requested primary platform.
 * Implements an advanced "Duplicate Name Trap" that stores all conflicting candidates.
 */
function getPlayerMaps(primaryIdHeader) {
  const cacheKey = primaryIdHeader ? primaryIdHeader.toUpperCase() : "DEFAULT";
  if (_playerMapsCache[cacheKey]) return _playerMapsCache[cacheKey];

  const dataSS = getDataSS();
  const primarySS = getPrimarySS();
  
  if (!dataSS || !primarySS) {
    _logError('resolvePlayer.gs', 'Required workbook(s) not found.', 'CRITICAL');
    return null;
  }
  
  const mapSheet = dataSS.getSheetByName("_MAP");
  const matchSheet = primarySS.getSheetByName("ID Matching");

  const maps = {
    primaryIdHeader: cacheKey,
    overrides: { mlbMap: {}, yahooMap: {}, fgMap: {}, platformMap: {}, nameMap: {} },
    primary: { mlbMap: {}, fgMap: {}, yahooMap: {}, nameMap: {} }
  };

  // 1. LOAD OVERRIDES (ID Matching sheet)
  if (matchSheet && matchSheet.getLastRow() > 1) {
    const matchData = matchSheet.getDataRange().getValues();
    for (let i = 1; i < matchData.length; i++) {
      const row = matchData[i];
      // With Col B added, IDPLAYER is perfectly positioned at index 5 (Column F)
      const primaryId = row[5]?.toString().trim(); 
      if (!primaryId) continue; 
      
      const overrideData = { id: primaryId, rowIdx: i + 1 };
      const rawName = row[2]?.toString(); // Column C
      const mlb     = row[6]?.toString().trim(); // Column G
      const yahoo   = row[7]?.toString().trim(); // Column H
      const fg      = row[8]?.toString().trim(); // Column I
      
      if (mlb)   maps.overrides.mlbMap[mlb] = overrideData;
      if (yahoo) maps.overrides.yahooMap[yahoo] = overrideData;
      if (fg)    maps.overrides.fgMap[fg] = overrideData;
      
      if (rawName) {
        const cleanName = _normalizePlayerName(rawName);
        maps.overrides.nameMap[cleanName] = overrideData;
      }
    }
  }

  // 2. LOAD PRIMARY DICTIONARY (_MAP sheet)
  if (mapSheet && mapSheet.getLastRow() > 1) {
    const data = mapSheet.getDataRange().getValues();
    const headers = data[0].map(h => h.toString().toUpperCase().replace(/[^A-Z0-9]/g, ''));
    
    const getIdx = (name) => headers.indexOf(name.toUpperCase().replace(/[^A-Z0-9]/g, ''));

    const idxIdPlayer = getIdx('IDPLAYER');
    const idxMlb      = getIdx('MLBID');
    const idxFg       = getIdx('IDFANGRAPHS');
    const idxYahoo    = getIdx('YAHOOID');
    const idxTeam     = getIdx('TEAM'); // Grabbing Team to store in Duplicate trap

    // Identify all name columns (everything after TEAM)
    const nameIndices = [];
    if (idxTeam !== -1) {
      for (let j = idxTeam + 1; j < headers.length; j++) {
        nameIndices.push(j);
      }
    } else if (idxYahoo !== -1) {
      for (let j = idxYahoo + 1; j < headers.length; j++) {
        nameIndices.push(j);
      }
    }

    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      const primaryId = row[idxIdPlayer]?.toString().trim();
      if (!primaryId) continue;

      const mId = row[idxMlb]?.toString().trim();
      const fId = row[idxFg]?.toString().trim();
      const yId = row[idxYahoo]?.toString().trim();
      const pTeam = idxTeam !== -1 ? _normalizeTeam(row[idxTeam]) : "";

      if (mId) maps.primary.mlbMap[mId] = primaryId;
      if (fId) maps.primary.fgMap[fId] = primaryId;
      if (yId) maps.primary.yahooMap[yId] = primaryId;
      
      // Load all name variants and build duplicate trap
      for (let nIdx of nameIndices) {
        let rawNameVariant = row[nIdx];
        if (rawNameVariant) {
          let cleanName = _normalizePlayerName(rawNameVariant);
          
          if (!maps.primary.nameMap[cleanName]) {
            // First time seeing this name
            maps.primary.nameMap[cleanName] = {
              id: primaryId,
              isDuplicate: false,
              candidates: [{ id: primaryId, team: pTeam }]
            };
          } else if (maps.primary.nameMap[cleanName].id !== primaryId) {
            // Duplicate name detected from a different player ID!
            maps.primary.nameMap[cleanName].isDuplicate = true;
            // Add to candidates array if not already present
            if (!maps.primary.nameMap[cleanName].candidates.some(c => c.id === primaryId)) {
              maps.primary.nameMap[cleanName].candidates.push({ id: primaryId, team: pTeam });
            }
          }
        }
      }
    }
  }

  _playerMapsCache[cacheKey] = maps;
  return maps;
}


// ============================================================================
//  RESOLUTION ENGINE
// ============================================================================

/**
 * Waterfall resolution based on requested order.
 * If a duplicate name is found, it queues both the failed request AND all 
 * potential candidates from the _MAP so the user can easily select the right one.
 */
function resolvePrimaryId(maps, platformId, mlbId, fgId, name, source, team) {
  if (!name && !platformId && !mlbId && !fgId) return "";
  
  const mId = mlbId?.toString().trim();
  const fId = fgId?.toString().trim();
  const yId = platformId?.toString().trim(); 
  const cleanName = _normalizePlayerName(name || "");

  const checkOverride = (map, key) => {
    if (key && map[key]) {
      _usedOverrideRows.add(map[key].rowIdx);
      return map[key].id;
    }
    return null;
  };

  // --- STEP 1: OVERRIDES ---
  let ovr = checkOverride(maps.overrides.mlbMap, mId);
  if (!ovr) ovr = checkOverride(maps.overrides.fgMap, fId);
  if (!ovr) ovr = checkOverride(maps.overrides.yahooMap, yId);
  if (!ovr) ovr = checkOverride(maps.overrides.nameMap, cleanName);
  if (ovr) return ovr;

  // --- STEP 2: PRIMARY MLBID ---
  if (mId && maps.primary.mlbMap[mId]) return maps.primary.mlbMap[mId];

  // --- STEP 3: PRIMARY IDFANGRAPHS ---
  if (fId && maps.primary.fgMap[fId]) return maps.primary.fgMap[fId];

  // --- STEP 4: PRIMARY YAHOOID ---
  if (yId && maps.primary.yahooMap[yId]) return maps.primary.yahooMap[yId];

  // --- STEP 5: NAME FALLBACK & DUPLICATE TRAP ---
  const nameMatch = maps.primary.nameMap[cleanName];
  if (nameMatch) {
    if (!nameMatch.isDuplicate) {
      return nameMatch.id;
    } else {
      // IT'S A DUPLICATE!
      // Write the incoming unresolved player to the queue
      _addToIdMatchingQueue(name, team, source, mId, yId, fId, maps.primaryIdHeader);

      // Write ALL the candidates found in the _MAP as "Hints" underneath it
      nameMatch.candidates.forEach(candidate => {
        _addToIdMatchingQueue(
          `${name} (Candidate)`, 
          candidate.team, 
          `Candidate ID: ${candidate.id}`, // Put the IDPLAYER in the Source column for easy copying
          '', '', '', 
          maps.primaryIdHeader
        );
      });

      return "";
    }
  }

  // --- STEP 6: NOT FOUND, FAIL TO QUEUE ---
  _addToIdMatchingQueue(name, team, source, mId, yId, fId, maps.primaryIdHeader);
  return "";
}


// ============================================================================
//  UTILITIES & QUEUE
// ============================================================================

function _normalizePlayerName(rawName) {
  if (!rawName) return "";
  let name = rawName.toString().toLowerCase().trim();
  name = name.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); 
  name = name.replace(/\b(jr|sr|ii|iii|iv)\b/g, ''); 
  name = name.replace(/[^a-z0-9]/g, '');
  return name;
}

function _normalizeTeam(team) {
  if (!team) return "";
  const t = team.toString().toUpperCase().trim();
  const aliasMap = {
    'WAS': 'WSH', 'WSN': 'WSH', 'CHW': 'CWS', 'CHA': 'CWS',
    'TB': 'TBR', 'RAY': 'TBR', 'TBA': 'TBR', 'KC': 'KCR', 'KCA': 'KCR',
    'SF': 'SFG', 'SD': 'SDP', 'NYY': 'NYY', 'NYA': 'NYY',
    'NYM': 'NYM', 'NYN': 'NYM', 'LAD': 'LAD', 'LAN': 'LAD',
    'CHC': 'CHC', 'CHN': 'CHC', 'STL': 'STL', 'SLN': 'STL',
    'MIA': 'MIA', 'FLO': 'MIA', 'LAA': 'LAA', 'ANA': 'LAA',
    'FA': 'FA', 'FREE AGENT': 'FA'
  };
  return aliasMap[t] || t;
}

/**
 * Builds the player array to be logged on the 'ID Matching' sheet.
 * Now accepts an optional hintId parameter to place bracketed text in Column F.
 */
function _addToIdMatchingQueue(name, team, source, mlbId, platformId, fgId, platformHeader, hintId = "") {
  if (!name) return; 

  // --- Abort if the source is in the exclusion list ---
  if (source && EXCLUDED_QUEUE_SOURCES.includes(source)) {
    return;
  }

  // Added a small timestamp or randomizer to the key so candidates don't overwrite each other if they share a team
  const key = `${name}_${team}_${platformHeader}_${Math.random()}`;
  
  if (!_idMatchingQueue.has(key)) {
    const cleanTeam = _normalizeTeam(team);
    const teamLogoFormula = cleanTeam && cleanTeam !== 'FA'
      ? `=IFERROR(INDEX(MLB_TEAM_LOGOS, ROUNDUP(MATCH("${cleanTeam}", TOCOL(MLB_TEAM_CODES), 0) / COLUMNS(MLB_TEAM_CODES)), MATCH(CURRENT_YEAR, MLB_TEAM_YEARS, 0) + IF(INDIRECT("B"&ROW()) = "Active", 1, 0)), "${cleanTeam}")` 
      : cleanTeam;

    _idMatchingQueue.set(key, [
      `=IF(INDIRECT("B"&ROW())="Active", ICON_PASS, IF(INDIRECT("B"&ROW())="Pending", ICON_MINUS, ICON_FAIL))`, // Col A: Status Icon
      
      // UPDATED FORMULA: Checks if Col F starts with "[" to display "Check ID"
      `=IF(INDIRECT("F"&ROW())="", "Missing ID", IF(LEFT(INDIRECT("F"&ROW()), 1)="[", "Check ID", "Pending"))`, // Col B: Status Text
      
      name,                                                   // Col C: Player
      teamLogoFormula,                                        // Col D: Team Logo
      source || "System",                                     // Col E: Source
      hintId ? `[${hintId}]` : "",                            // Col F: Output column (Now writes Hint here)
      mlbId || "",                                            // Col G: MLBID
      platformHeader === 'YAHOOID' ? platformId : "",         // Col H: YAHOOID
      fgId || (platformHeader === 'IDFANGRAPHS' ? platformId : ""), // Col I: IDFANGRAPHS
    ]);
  }
}

/**
 * Flushes missing players to the sheet. 
 * Finds the true last row of data to prevent writing to the absolute bottom of a formatted sheet.
 */
function flushIdMatchingQueue() {
  const primarySS = getPrimarySS();
  if (!primarySS) return;
  
  let sheet = primarySS.getSheetByName("ID Matching");
  if (!sheet) {
    sheet = primarySS.insertSheet("ID Matching");
    sheet.appendRow(["Status", "State", "Player", "Team Logo", "Source", "IDPLAYER", "MLBID", "YAHOOID", "IDFANGRAPHS"]);
    sheet.getRange('A1:I1').setFontWeight('bold');
  }

  if (_usedOverrideRows.size > 0) {
    _usedOverrideRows.forEach(rowIdx => {
      // Logic handled via text: writing "Active" to Col B updates Col A's formula automatically
      sheet.getRange(rowIdx, 2).setValue("Active");
    });
    _usedOverrideRows.clear();
  }

  if (_idMatchingQueue.size === 0) return;
  
  // --- FIND TRUE LAST ROW ---
  const maxRows = sheet.getMaxRows();
  const colCValues = sheet.getRange("C1:C" + maxRows).getValues();
  let trueLastRow = 1;
  for (let i = colCValues.length - 1; i >= 0; i--) {
    if (colCValues[i][0] !== "") {
      trueLastRow = i + 1;
      break;
    }
  }
  
  const existingNames = new Set();
  if (trueLastRow > 1) {
    const data = sheet.getRange("C2:C" + trueLastRow).getValues();
    data.forEach(r => { if (r[0]) existingNames.add(r[0].toString().trim().toLowerCase()); });
  }

  const newRows = [];
  for (let [key, rowData] of _idMatchingQueue.entries()) {
    const queuePlayer = rowData[2]?.toString().trim().toLowerCase();
    
    // Allow candidates to bypass the strict existingNames check so they always print
    if (!existingNames.has(queuePlayer) || queuePlayer.includes("(candidate)")) {
      newRows.push(rowData);
      existingNames.add(queuePlayer);
    }
  }
  
  if (newRows.length > 0) {
    const startRow = trueLastRow + 1;
    sheet.getRange(startRow, 1, newRows.length, newRows[0].length).setValues(newRows);
  }
  
  _idMatchingQueue.clear();
}


// ============================================================================
//  MAP SYNC ENGINE
// ============================================================================

/**
 * @description Synchronizes the _MAP sheet by pulling data from external URLs 
 * or internal fallbacks. Now correctly targets the Data Spreadsheet and includes TEAM.
 */
function syncMapSheet() {
  const dataSS = getDataSS(); 
  const primarySS = getPrimarySS(); 
  
  if (!dataSS) {
    Logger.log("Error: Could not find Data Spreadsheet. Check SHEET_DATA_ID.");
    return;
  }

  const mapSheet = dataSS.getSheetByName("_MAP");
  
  const notify = (msg, title = "Sync Status") => {
    try {
      const ui = SpreadsheetApp.getUi();
      if (ui) ui.alert(msg);
    } catch (e) {
      Logger.log(`${title}: ${msg}`);
    }
  };

  const showToast = (msg, title) => {
    try {
      primarySS.toast(msg, title);
    } catch (e) {
      Logger.log(`${title}: ${msg}`);
    }
  };

  if (!mapSheet) {
    notify("Error: _MAP sheet not found in the Data Spreadsheet. Please create it first.", "Error");
    return;
  }

  // ADDED "TEAM" TO TARGET HEADERS SO THE ENGINE CAN PULL IT
  const targetHeaders = [
    "IDPLAYER", "MLBID", "IDFANGRAPHS", "YAHOOID", "TEAM", "FANGRAPHSNAME", "PLAYERNAME", 
    "MLBNAME", "CBSNAME", "NFBCNAME", "ESPNNAME", "YAHOONAME", "MSTRBLLNAME", 
    "FANTPROSNAME", "LASTCOMMAFIRST", "FANDUELNAME", "DRAFTKINGSNAME", 
    "RAZZBALLNAME", "FANTRAXNAME", "ROTOWIRENAME", "NFBCLASTFIRST", "FGSPECIALCHAR"
  ];

  let rawData = null;

  // --- SOURCE 1: Google Published CSV ---
  const url1 = "https://docs.google.com/spreadsheets/d/1JgczhD5VDQ1EiXqVG-blttZcVwbZd5_Ne_mefUGwJnk/export?format=csv&gid=0";
  try {
    const response = UrlFetchApp.fetch(url1);
    if (response.getResponseCode() === 200) {
      rawData = Utilities.parseCsv(response.getContentText());
      Logger.log("Source 1: Success");
    }
  } catch (e) {
    Logger.log("Source 1: Failed - " + e.message);
  }

  // --- SOURCE 2: Smart Fantasy Baseball CSV ---
  if (!rawData) {
    const url2 = "https://www.smartfantasybaseball.com/PLAYERIDMAPCSV";
    try {
      const response = UrlFetchApp.fetch(url2);
      if (response.getResponseCode() === 200) {
        rawData = Utilities.parseCsv(response.getContentText());
        Logger.log("Source 2: Success");
      }
    } catch (e) {
      Logger.log("Source 2: Failed - " + e.message);
    }
  }

  if (!rawData || rawData.length < 2) {
    notify("Critical Error: Unable to fetch data from any source.", "Failure");
    return;
  }

  // --- MAPPING LOGIC ---
  const sourceHeaders = rawData[0].map(h => h.toString().toUpperCase().replace(/[^A-Z0-9]/g, ''));
  const finalOutput = [targetHeaders];

  const colMap = targetHeaders.map(target => {
    // Check if the target is 'TEAM', SFB maps use 'TEAMNAMEABB'
    if (target === "TEAM") {
      let idx = sourceHeaders.indexOf("TEAMNAMEABB");
      if (idx === -1) idx = sourceHeaders.indexOf("TEAM");
      return idx;
    }
    const cleanTarget = target.toUpperCase().replace(/[^A-Z0-9]/g, '');
    return sourceHeaders.indexOf(cleanTarget);
  });

  for (let i = 1; i < rawData.length; i++) {
    const sourceRow = rawData[i];
    const reorderedRow = colMap.map(idx => (idx !== -1 ? sourceRow[idx] : ""));
    finalOutput.push(reorderedRow);
  }

  mapSheet.clear(); 
  mapSheet.getRange(1, 1, finalOutput.length, targetHeaders.length).setValues(finalOutput);

  showToast("Resolution Map synchronized successfully!", "Success");
}