/**
 * @file resolvePlayer.gs
 * @description Universal player ID resolution engine. Maps platform-specific IDs 
 * (Yahoo, FanGraphs, MLBAM) to the Primary ID (IDPLAYER).
 * @dependencies _helpers.gs
 * @writesTo 'ID Matching' (flushes unresolved players to the sheet queue)
 */

// ============================================================================
//  GLOBAL CACHES
// ============================================================================
let _playerMapsCache = {};
let _idMatchingQueue = new Map(); // De-duplicates missing players by Name+Team

// ============================================================================
//  MAP LOADER
// ============================================================================

/**
 * Loads the Primary Map and Overrides Map into memory.
 * @param {string} primaryIdHeader - The native platform ID to prioritize (e.g., 'YAHOOID').
 * @returns {Object} Structured object containing both maps.
 */
function getPlayerMaps(primaryIdHeader) {
  const cacheKey = primaryIdHeader ? primaryIdHeader.toUpperCase() : "DEFAULT";
  if (_playerMapsCache[cacheKey]) return _playerMapsCache[cacheKey];

  const dataSS = getDataSS();
  if (!dataSS) {
    _logError('resolvePlayer.gs', 'Data workbook not found.', 'CRITICAL');
    return null;
  }
  
  let mapSheet = dataSS.getSheetByName("_MAP");
  const matchSheet = dataSS.getSheetByName("ID Matching");

  const maps = {
    primaryIdHeader: cacheKey,
    overrides: { mlbMap: {}, yahooMap: {}, fgMap: {}, platformMap: {}, nameTeamMap: {}, nameMap: {} },
    primary: { idMap: {}, mlbMap: {}, fgMap: {}, nameTeamMap: {}, nameMap: {} }
  };

  // 1. LOAD OVERRIDES ('ID Matching' Sheet)
  if (matchSheet && matchSheet.getLastRow() > 1) {
    const matchData = matchSheet.getDataRange().getValues();
    // Schema: Status, Date, Name, Team, Source, IDPLAYER, MLBID, YAHOOID, IDFANGRAPHS, Platform Header, Platform ID, Notes
    for (let i = 1; i < matchData.length; i++) {
      const row = matchData[i];
      const primaryId = row[5]?.toString().trim(); 
      if (!primaryId) continue; // Skip unresolved queue items
      
      const rawName = row[2]?.toString();
      const rawTeam = row[3]?.toString().trim().toUpperCase();
      const mlb     = row[6]?.toString().trim();
      const yahoo   = row[7]?.toString().trim();
      const fg      = row[8]?.toString().trim();
      const pHeader = row[9]?.toString().trim().toUpperCase();
      const pId     = row[10]?.toString().trim();
      
      if (mlb)   maps.overrides.mlbMap[mlb] = primaryId;
      if (yahoo) maps.overrides.yahooMap[yahoo] = primaryId;
      if (fg)    maps.overrides.fgMap[fg] = primaryId;
      if (pHeader && pId) maps.overrides.platformMap[`${pHeader}_${pId}`] = primaryId;
      
      if (rawName) {
        const cleanName = _normalizePlayerName(rawName);
        maps.overrides.nameMap[cleanName] = primaryId;
        if (rawTeam) maps.overrides.nameTeamMap[`${cleanName}_${rawTeam}`] = primaryId;
      }
    }
  }

  // 2. LOAD PRIMARY DICTIONARY ('_MAP' Sheet)
  if (mapSheet && mapSheet.getLastRow() > 1) {
    const data = mapSheet.getDataRange().getValues();
    const headers = data[0].map(h => h.toString().trim().toUpperCase());
    
    const getIdx = (...names) => {
      for (let n of names) {
        let idx = headers.indexOf(n);
        if (idx !== -1) return idx;
      }
      return -1;
    };

    const idxPrimaryId = getIdx('IDPLAYER', 'ID');
    const idxName      = getIdx('PLAYER');
    const idxTeam      = getIdx('TEAM');
    const idxMlb       = getIdx('MLBID', 'MLB_ID');
    const idxFg        = getIdx('IDFANGRAPHS');
    const idxPlatform  = getIdx(cacheKey);

    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      const primaryId = idxPrimaryId > -1 ? row[idxPrimaryId]?.toString().trim() : null;
      if (!primaryId) continue;

      const pId   = idxPlatform > -1 ? row[idxPlatform]?.toString().trim() : null;
      const mId   = idxMlb > -1 ? row[idxMlb]?.toString().trim() : null;
      const fId   = idxFg > -1 ? row[idxFg]?.toString().trim() : null;
      const pName = idxName > -1 ? row[idxName]?.toString() : null;
      const pTeam = idxTeam > -1 ? row[idxTeam]?.toString().trim().toUpperCase() : null;

      if (pId) maps.primary.idMap[pId] = primaryId;
      if (mId) maps.primary.mlbMap[mId] = primaryId;
      if (fId) maps.primary.fgMap[fId] = primaryId;
      
      if (pName) {
        const cleanName = _normalizePlayerName(pName);
        maps.primary.nameMap[cleanName] = primaryId;
        if (pTeam) maps.primary.nameTeamMap[`${cleanName}_${pTeam}`] = primaryId;
      }
    }
  }

  _playerMapsCache[cacheKey] = maps;
  return maps;
}

// ============================================================================
//  RESOLUTION ENGINE (7-STEP PATH)
// ============================================================================

/**
 * Core engine to resolve a player to their IDPLAYER primary key.
 * Follows the strict 7-step path defined in the architectural blueprint.
 * @param {Object} maps - Dictionary object from getPlayerMaps().
 * @param {string} platformId - Primary ID from the scraping source.
 * @param {string} mlbId - Secondary MLBAM ID.
 * @param {string} fgId - IDFANGRAPHS (if provided by the source).
 * @param {string} name - Player's raw name.
 * @param {string} source - Script name (for logging).
 * @param {string} team - Player's raw team abbreviation.
 * @returns {string} The IDPLAYER string, or empty string if unresolved.
 */
function resolvePrimaryId(maps, platformId, mlbId, fgId, name, source, team) {
  if (!name && !platformId && !mlbId && !fgId) return "";
  
  // STEP 1: NORMALIZATION
  const pId = platformId?.toString().trim();
  const mId = mlbId?.toString().trim();
  const fId = fgId?.toString().trim();
  const rawName = name || "";
  const cleanName = _normalizePlayerName(rawName);
  const cleanTeam = team?.toString().trim().toUpperCase() || "";

  // STEP 2: CHECK MANUAL OVERRIDES (ID Matching)
  // 2.1 - 2.3
  if (mId && maps.overrides.mlbMap[mId]) return maps.overrides.mlbMap[mId];
  if (pId && maps.primaryIdHeader === 'YAHOOID' && maps.overrides.yahooMap[pId]) return maps.overrides.yahooMap[pId];
  if (fId && maps.overrides.fgMap[fId]) return maps.overrides.fgMap[fId];
  if (pId && maps.primaryIdHeader === 'IDFANGRAPHS' && maps.overrides.fgMap[pId]) return maps.overrides.fgMap[pId];

  // 2.4 & 2.5 Platform Specific Match (Fallback to Name+Team if header mismatches)
  if (pId) {
    const platformKey = `${maps.primaryIdHeader}_${pId}`;
    if (maps.overrides.platformMap[platformKey]) return maps.overrides.platformMap[platformKey];
  }

  // 2.6 & 2.7
  if (cleanName && cleanTeam && maps.overrides.nameTeamMap[`${cleanName}_${cleanTeam}`]) {
    return maps.overrides.nameTeamMap[`${cleanName}_${cleanTeam}`];
  }
  if (cleanName && maps.overrides.nameMap[cleanName]) return maps.overrides.nameMap[cleanName];

  // STEP 3: CHECK PRIMARY PLATFORM ID (_MAP)
  if (pId && maps.primary.idMap[pId]) return maps.primary.idMap[pId];

  // STEP 4: CHECK SECONDARY ID (_MAP)
  if (mId && maps.primary.mlbMap[mId]) return maps.primary.mlbMap[mId];
  if (fId && maps.primary.fgMap[fId]) return maps.primary.fgMap[fId];

  // STEP 5: CHECK NAME + TEAM (_MAP)
  if (cleanName && cleanTeam && maps.primary.nameTeamMap[`${cleanName}_${cleanTeam}`]) {
    return maps.primary.nameTeamMap[`${cleanName}_${cleanTeam}`];
  }

  // STEP 6: CHECK NAME ONLY (_MAP)
  if (cleanName && maps.primary.nameMap[cleanName]) return maps.primary.nameMap[cleanName];

  // STEP 7: PUSH TO QUEUE
  _addToIdMatchingQueue(rawName, cleanTeam, source, mId, pId, fId, maps.primaryIdHeader);
  return "";
}

// ============================================================================
//  UTILITIES & QUEUE
// ============================================================================

/**
 * Standardizes a player name for dictionary matching.
 * @param {string} rawName 
 * @returns {string} Normalized string (lowercase, no accents, no suffixes, no spaces).
 */
function _normalizePlayerName(rawName) {
  if (!rawName) return "";
  let name = rawName.toString().toLowerCase().trim();
  name = name.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); // Remove accents
  name = name.replace(/[.,']/g, ''); // Remove punctuation
  name = name.replace(/\s+(jr|sr|ii|iii|iv)$/g, ''); // Remove suffixes
  name = name.replace(/\s+/g, ''); // Remove all spaces
  return name;
}

/**
 * Adds an unresolved player to the in-memory Map to prevent duplicates.
 */
function _addToIdMatchingQueue(name, team, source, mlbId, platformId, fgId, platformHeader) {
  if (!name) return;
  const key = `${name}_${team}`;
  
  if (!_idMatchingQueue.has(key)) {
    // Dynamic logo lookup formula
    const teamLogoFormula = team 
      ? `=IFERROR(INDEX(MLB_TEAM_LOGOS, ROUNDUP(MATCH("${team}", TOCOL(MLB_TEAM_CODES), 0) / COLUMNS(MLB_TEAM_CODES)), MATCH(CURRENT_YEAR, MLB_TEAM_YEARS, 0)), "${team}")` 
      : "";

    // Schema: Status, Date, Name, Team, Source, IDPLAYER, MLBID, YAHOOID, IDFANGRAPHS, Platform Header, Platform ID, Notes
    _idMatchingQueue.set(key, [
      "=ICON_FAIL",         // Col 1: Status
      new Date(),           // Col 2: Date
      name,                 // Col 3: Player Name
      teamLogoFormula,      // Col 4: Team (Logo Formula)
      source || "System",   // Col 5: Source
      "",                   // Col 6: IDPLAYER (Left blank)
      mlbId || "",          // Col 7: MLBID
      platformHeader === 'YAHOOID' ? platformId : "", // Col 8: YAHOOID
      fgId || (platformHeader === 'IDFANGRAPHS' ? platformId : ""), // Col 9: IDFANGRAPHS
      "",                   // Col 10: Platform (ID Header) - User input
      "",                   // Col 11: Platform ID - User input
      "System Missing Link" // Col 12: Notes
    ]);
  }
}

/**
 * Writes all queued missing players to the ID Matching sheet.
 * Called at the end of trigger group execution.
 */
function flushIdMatchingQueue() {
  if (_idMatchingQueue.size === 0) return;
  
  const dataSS = getDataSS();
  if (!dataSS) return;
  
  const sheet = dataSS.getSheetByName("ID Matching");
  if (!sheet) return;
  
  const newRows = Array.from(_idMatchingQueue.values());
  sheet.getRange(sheet.getLastRow() + 1, 1, newRows.length, newRows[0].length).setValues(newRows);
  
  Logger.log(`flushIdMatchingQueue: Written ${newRows.length} unresolved players.`);
  _idMatchingQueue.clear();
}