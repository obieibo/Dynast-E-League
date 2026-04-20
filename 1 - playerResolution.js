/**
 * FILE: playerResolution.gs
 * PRIORITY: ID Matching Overrides > Direct Master ID Check > Master Map > Name Match
 */

let _playerMapsCache = {};

function getPlayerMaps(primaryIdHeader) {
  if (_playerMapsCache[primaryIdHeader]) return _playerMapsCache[primaryIdHeader];

  const dataSS = getDataSS();
  
  // 1. Robust Sheet Lookup: Check for "_MAP" first, fallback to "_IDPLAYER_MAP"
  let mapSheet = dataSS ? dataSS.getSheetByName("_MAP") : null;
  if (!mapSheet && dataSS) {
    mapSheet = dataSS.getSheetByName("_IDPLAYER_MAP");
  }
  
  const matchSheet = dataSS ? dataSS.getSheetByName("ID Matching") : null;

  const maps = {
    master: { idMap: {}, mlbamMap: {}, fgMap: {}, nameMap: {}, masterIds: new Set() },
    overrides: { idMap: {}, mlbamMap: {}, fgMap: {}, nameMap: {} },
    primaryIdHeader: primaryIdHeader ? primaryIdHeader.toUpperCase() : "YAHOO_ID"
  };

  // 2. Load OVERRIDES from 'ID Matching' (Check this FIRST)
  if (matchSheet && matchSheet.getLastRow() > 1) {
    const matchData = matchSheet.getDataRange().getValues();
    for (let i = 1; i < matchData.length; i++) {
      const row = matchData[i];
      const resId = row[3]?.toString().trim(); // Col D: IDPLAYER
      if (!resId) continue;
      
      const mlb = row[4]?.toString().trim();   // Col E: MLBID
      const yahoo = row[5]?.toString().trim(); // Col F: YAHOOID
      const fg = row[6]?.toString().trim();    // Col G: IDFANGRAPHS
      
      // Clean name for safer matching
      const name = row[0]?.toString().toLowerCase().trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

      if (yahoo) maps.overrides.idMap[yahoo] = resId;
      if (mlb)   maps.overrides.mlbamMap[mlb] = resId;
      if (fg)    maps.overrides.fgMap[fg] = resId;
      if (name)  maps.overrides.nameMap[name] = resId;
    }
  }

  // 3. Load MASTER from map sheet
  if (mapSheet && mapSheet.getLastRow() > 1) {
    const data = mapSheet.getDataRange().getValues();
    
    // Normalize headers to uppercase for safe matching
    const headers = data[0].map(h => h.toString().trim().toUpperCase());
    
    // Helper to find column indices even if header names slightly vary
    const getHeaderIdx = (...possibleNames) => {
      for (let name of possibleNames) {
        const idx = headers.indexOf(name);
        if (idx !== -1) return idx;
      }
      return -1;
    };

    // Find columns using flexible names
    const idxMaster = getHeaderIdx('IDPLAYER', 'ID');
    const idxName = getHeaderIdx('PLAYER', 'PLAYERNAME', 'NAME');
    const idxMlb = getHeaderIdx('MLB_ID', 'MLBID');
    const idxFg = getHeaderIdx('IDFANGRAPHS', 'FANGRAPHS_ID', 'FANGRAPHSID');
    const idxPrimary = getHeaderIdx(maps.primaryIdHeader, 'YAHOOID', 'YAHOO_ID');

    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      const masterId = idxMaster > -1 ? row[idxMaster]?.toString().trim() : null;
      if (!masterId) continue;

      maps.master.masterIds.add(masterId);

      if (idxPrimary > -1 && row[idxPrimary]) maps.master.idMap[row[idxPrimary].toString().trim()] = masterId;
      if (idxMlb > -1 && row[idxMlb])         maps.master.mlbamMap[row[idxMlb].toString().trim()] = masterId;
      if (idxFg > -1 && row[idxFg])           maps.master.fgMap[row[idxFg].toString().trim()] = masterId;
      
      if (idxName > -1 && row[idxName]) {
        // Strip accents and special characters so "Acuña" safely matches "Acuna"
        const cleanName = row[idxName].toString().toLowerCase().trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        maps.master.nameMap[cleanName] = masterId;
      }
    }
  }

  _playerMapsCache[primaryIdHeader] = maps;
  return maps;
}

function resolveMasterId(maps, platformId, mlbId, name, source, team, fgId) {
  if (!name) return "";
  
  // Safely clean name exactly as we did in the map builder
  const cleanName = name.toLowerCase().trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const pId = platformId?.toString().trim();
  const mId = mlbId?.toString().trim();
  const fId = fgId?.toString().trim();

  // CHECK OVERRIDES (ID Matching Sheet)
  if (fId && maps.overrides.fgMap[fId]) return maps.overrides.fgMap[fId];
  if (pId && maps.overrides.idMap[pId]) return maps.overrides.idMap[pId];
  if (maps.overrides.nameMap[cleanName]) return maps.overrides.nameMap[cleanName];

  // DIRECT MASTER ID CHECK
  if (fId && maps.master.masterIds.has(fId)) return fId;

  // CHECK MASTER MAP
  if (fId && maps.master.fgMap[fId]) return maps.master.fgMap[fId];
  if (pId && maps.master.idMap[pId]) return maps.master.idMap[pId];
  if (mId && maps.master.mlbamMap[mId]) return maps.master.mlbamMap[mId];
  if (maps.master.nameMap[cleanName]) return maps.master.nameMap[cleanName];

  addToIdMatchingQueue(name, team, source, null, mlbId, platformId, fgId, maps.primaryIdHeader);
  return "";
}

let _idMatchingQueue = [];
function addToIdMatchingQueue(name, team, source, idPlayer, mlbId, yahooId, fgId, platformHeader) {
  // Columns: PlayerName, Team, Source, IDPLAYER, MLBID, YAHOOID, IDFANGRAPHS, Platform, PlatformID, Notes
  _idMatchingQueue.push([
    name, team || "", source || "", idPlayer || "", mlbId || "", 
    yahooId || "", fgId || "", platformHeader || "", yahooId || "", "System Missing Link"
  ]);
}

function flushIdMatchingQueue() {
  if (_idMatchingQueue.length === 0) return;
  const dataSS = getDataSS();
  const sheet = dataSS.getSheetByName("ID Matching");
  if (!sheet) return;
  
  sheet.getRange(sheet.getLastRow() + 1, 1, _idMatchingQueue.length, _idMatchingQueue[0].length).setValues(_idMatchingQueue);
  _idMatchingQueue = [];
}