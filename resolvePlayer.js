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
let _idMatchingQueue = new Map(); 

// ============================================================================
//  MAP LOADER
// ============================================================================

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

  // 1. LOAD OVERRIDES
  if (matchSheet && matchSheet.getLastRow() > 1) {
    const matchData = matchSheet.getDataRange().getValues();
    for (let i = 1; i < matchData.length; i++) {
      const row = matchData[i];
      const primaryId = row[5]?.toString().trim(); 
      if (!primaryId) continue; 
      
      const rawName = row[2]?.toString();
      const rawTeam = _normalizeTeam(row[3]); 
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

  // 2. LOAD PRIMARY DICTIONARY
  if (mapSheet && mapSheet.getLastRow() > 1) {
    const data = mapSheet.getDataRange().getValues();
    
    // FIX: Clean headers by stripping spaces and special chars to prevent mapping failures
    const headers = data[0].map(h => h.toString().toUpperCase().replace(/[^A-Z0-9]/g, ''));
    
    const getIdx = (...names) => {
      for (let n of names) {
        let cleanN = n.toUpperCase().replace(/[^A-Z0-9]/g, '');
        let idx = headers.indexOf(cleanN);
        if (idx !== -1) return idx;
      }
      return -1;
    };

    const idxPrimaryId = getIdx('IDPLAYER', 'ID', 'PRIMARYID');
    const idxName      = getIdx('PLAYER', 'PLAYERNAME', 'NAME', 'FULLNAME');
    const idxTeam      = getIdx('TEAM', 'TM', 'TEAMNAME');
    const idxMlb       = getIdx('MLBID', 'MLB_ID');
    const idxFg        = getIdx('IDFANGRAPHS', 'FGID');
    const idxPlatform  = getIdx(cacheKey, cacheKey.replace('ID', '')); 

    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      const primaryId = idxPrimaryId > -1 ? row[idxPrimaryId]?.toString().trim() : null;
      if (!primaryId) continue;

      const pId   = idxPlatform > -1 ? row[idxPlatform]?.toString().trim() : null;
      const mId   = idxMlb > -1 ? row[idxMlb]?.toString().trim() : null;
      const fId   = idxFg > -1 ? row[idxFg]?.toString().trim() : null;
      const pName = idxName > -1 ? row[idxName]?.toString() : null;
      const pTeam = idxTeam > -1 ? _normalizeTeam(row[idxTeam]) : null;

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
//  RESOLUTION ENGINE
// ============================================================================

function resolvePrimaryId(maps, platformId, mlbId, fgId, name, source, team) {
  if (!name && !platformId && !mlbId && !fgId) return "";
  
  const pId = platformId?.toString().trim();
  const mId = mlbId?.toString().trim();
  const fId = fgId?.toString().trim();
  const rawName = name || "";
  const cleanName = _normalizePlayerName(rawName);
  const cleanTeam = _normalizeTeam(team);

  if (mId && maps.overrides.mlbMap[mId]) return maps.overrides.mlbMap[mId];
  if (pId && maps.primaryIdHeader === 'YAHOOID' && maps.overrides.yahooMap[pId]) return maps.overrides.yahooMap[pId];
  if (fId && maps.overrides.fgMap[fId]) return maps.overrides.fgMap[fId];
  if (pId && maps.primaryIdHeader === 'IDFANGRAPHS' && maps.overrides.fgMap[pId]) return maps.overrides.fgMap[pId];

  if (pId) {
    const platformKey = `${maps.primaryIdHeader}_${pId}`;
    if (maps.overrides.platformMap[platformKey]) return maps.overrides.platformMap[platformKey];
  }

  if (cleanName && cleanTeam && maps.overrides.nameTeamMap[`${cleanName}_${cleanTeam}`]) {
    return maps.overrides.nameTeamMap[`${cleanName}_${cleanTeam}`];
  }
  if (cleanName && maps.overrides.nameMap[cleanName]) return maps.overrides.nameMap[cleanName];

  if (pId && maps.primary.idMap[pId]) return maps.primary.idMap[pId];
  if (mId && maps.primary.mlbMap[mId]) return maps.primary.mlbMap[mId];
  if (fId && maps.primary.fgMap[fId]) return maps.primary.fgMap[fId];

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

function _normalizePlayerName(rawName) {
  if (!rawName) return "";
  let name = rawName.toString().toLowerCase().trim();
  name = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  name = name.replace(/\b(jr|sr|ii|iii|iv)\b/g, '');
  // FIX: Aggressively strip all punctuation and spacing (handles hyphens, dots, spaces)
  name = name.replace(/[^a-z0-9]/g, '');
  return name;
}

function _normalizeTeam(team) {
  if (!team) return "";
  const t = team.toString().toUpperCase().trim();
  const aliasMap = {
    'WAS': 'WSN', 'WSH': 'WSN',
    'CHW': 'CWS', 'CHA': 'CWS',
    'TB': 'TBA', 'RAY': 'TBA',
    'KC': 'KCA',
    'SF': 'SFG',
    'SD': 'SDP',
    'NYY': 'NYA',
    'NYM': 'NYN',
    'LAD': 'LAN',
    'CHC': 'CHN',
    'STL': 'SLN'
  };
  return aliasMap[t] || t;
}

function _addToIdMatchingQueue(name, team, source, mlbId, platformId, fgId, platformHeader) {
  if (!name) return; // If name is completely blank, it bails out here. The helper fix guarantees names aren't blank anymore.
  const key = `${name}_${team}`;
  
  if (!_idMatchingQueue.has(key)) {
    const teamLogoFormula = team 
      ? `=IFERROR(INDEX(MLB_TEAM_LOGOS, ROUNDUP(MATCH("${team}", TOCOL(MLB_TEAM_CODES), 0) / COLUMNS(MLB_TEAM_CODES)), MATCH(CURRENT_YEAR, MLB_TEAM_YEARS, 0)), "${team}")` 
      : "";

    _idMatchingQueue.set(key, [
      "=ICON_FAIL",         
      new Date(),           
      name,                 
      teamLogoFormula,      
      source || "System",   
      "",                   
      mlbId || "",          
      platformHeader === 'YAHOOID' ? platformId : "", 
      fgId || (platformHeader === 'IDFANGRAPHS' ? platformId : ""), 
      "",                   
      "",                   
      "System Missing Link" 
    ]);
  }
}

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