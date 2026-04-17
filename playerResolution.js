/**
 * FILE: playerResolution.gs
 * PURPOSE: Universal player ID resolution system. Fetches and maintains
 * the Smart Fantasy Baseball ID map, builds lookup tables,
 * and resolves any platform ID or player name to the master
 * BBREF ID (IDPLAYER) used throughout the system.
 */

// ============================================================
//  CONSTANTS — SFBB SOURCE
// ============================================================

const SFBB_CSV_URL       = 'https://www.smartfantasybaseball.com/PLAYERIDMAPCSV';
const SHEET_IDPLAYER_CSV = '_IDPLAYER_CSV';
const SHEET_IDPLAYER_MAP = '_IDPLAYER_MAP';

const IDPLAYER_MAP_HEADERS = [
  'IDPLAYER', 'PLAYERNAME', 'BIRTHDATE', 'FIRSTNAME', 'LASTNAME',
  'MLBID', 'IDFANGRAPHS', 'YAHOOID', 'CBSID', 'RETROID', 'BREFID',
  'FANGRAPHSNAME', 'MLBNAME', 'CBSNAME', 'FANTPROSNAME', 'LG', 'POS', 'TEAM'
];

const SFBB_COLUMN_MAP = {
  'IDPLAYER': 'IDPLAYER', 'PLAYERNAME': 'PLAYERNAME', 'BIRTHDATE': 'BIRTHDATE',
  'FIRSTNAME': 'FIRSTNAME', 'LASTNAME': 'LASTNAME', 'MLBID': 'MLBID',
  'IDFANGRAPHS': 'IDFANGRAPHS', 'YAHOOID': 'YAHOOID', 'CBSID': 'CBSID',
  'RETROID': 'RETROID', 'BREFID': 'BREFID', 'FANGRAPHSNAME': 'FANGRAPHSNAME',
  'MLBNAME': 'MLBNAME', 'CBSNAME': 'CBSNAME', 'FANTPROSNAME': 'FANTPROSNAME',
  'LG': 'LG', 'POS': 'POS', 'TEAM': 'TEAM'
};

// ============================================================
//  CONSTANTS — ID MATCHING SHEET
// ============================================================

const ID_MATCHING_SHEET      = 'ID Matching';  
const ID_MATCHING_DATA_START = 4;              
const ID_MATCHING_HEADER_ROW = 3;              

// Column indices (0-based) 
const IDM_COL_STATUS      = 0;  // A 
const IDM_COL_DATE        = 1;  // B 
const IDM_COL_RAW_NAME    = 2;  // C 
const IDM_COL_TEAM        = 3;  // D 
const IDM_COL_SOURCE      = 4;  // E 
const IDM_COL_IDPLAYER    = 5;  // F 
const IDM_COL_MLBID       = 6;  // G — NEW: Auto-populates if available
const IDM_COL_PLATFORM    = 7;  // H — UPDATED HEADER: e.g. YAHOOID
const IDM_COL_PLATFORM_ID = 8;  // I — NEW: Auto-populates if available
const IDM_COL_NOTES       = 9;  // J 
const IDM_NUM_COLS        = 10;

const IDM_STATUS_FAIL = '=ICON_FAIL';
const IDM_STATUS_PASS = '=ICON_PASS';

const ID_MATCHING_HEADERS = [
  'Status', 'Date', 'Player Name', 'Team', 'Source',
  'IDPLAYER', 'MLBID', 'Platform', 'Platform ID', 'Notes'
];

// ============================================================
//  IN-MEMORY CACHE
// ============================================================

let _playerMapsCache = {};  
let _idMatchingQueue = [];  

// ============================================================
//  REFRESH PLAYER ID MAP
// ============================================================

function refreshPlayerIdMap() {
  Logger.log('refreshPlayerIdMap: fetching SFBB CSV...');

  const response = UrlFetchApp.fetch(SFBB_CSV_URL, { muteHttpExceptions: true });

  if (response.getResponseCode() !== 200) {
    Logger.log('refreshPlayerIdMap: fetch failed (' + response.getResponseCode() + '). Map not updated.');
    return;
  }

  const csvData = Utilities.parseCsv(response.getContentText());

  if (!csvData || csvData.length < 2) {
    Logger.log('refreshPlayerIdMap: CSV empty or malformed. Map not updated.');
    return;
  }

  const headers = csvData[0].map(h => h.toString().trim().toUpperCase());
  const activeIdx = headers.indexOf('ACTIVE');
  
  const activePlayersData = [csvData[0]]; 
  
  if (activeIdx !== -1) {
    for (let i = 1; i < csvData.length; i++) {
      const row = csvData[i];
      if (row[activeIdx] && row[activeIdx].toString().trim().toUpperCase() === 'Y') {
        activePlayersData.push(row);
      }
    }
  } else {
    Logger.log('refreshPlayerIdMap: ACTIVE column not found in SFBB CSV. Proceeding without filter.');
    activePlayersData.push(...csvData.slice(1));
  }

  writeToData(SHEET_IDPLAYER_CSV, activePlayersData);
  Logger.log('refreshPlayerIdMap: wrote ' + (activePlayersData.length - 1) + ' active players to ' + SHEET_IDPLAYER_CSV);

  _buildPlayerIdMap(activePlayersData);

  const tsRange = getMasterSS().getRangeByName('UPDATE_ID_MAP');
  if (tsRange) tsRange.setValue(new Date());

  bustPlayerMapsCache();
  Logger.log('refreshPlayerIdMap: complete.');
}

function _buildPlayerIdMap(csvData) {
  const srcHdrs = csvData[0].map(h => h.toString().trim().toUpperCase());

  const srcIdx = {};
  IDPLAYER_MAP_HEADERS.forEach(col => {
    srcIdx[col] = srcHdrs.indexOf(SFBB_COLUMN_MAP[col]);
  });

  const outputRows = [IDPLAYER_MAP_HEADERS];

  for (let i = 1; i < csvData.length; i++) {
    const row = csvData[i];
    if (!row || row.every(cell => !cell)) continue;

    const mappedRow = IDPLAYER_MAP_HEADERS.map(col => {
      const idx = srcIdx[col];
      if (idx === -1 || idx === undefined) return '';
      const val = row[idx];
      return (val !== null && val !== undefined) ? val.toString().trim() : '';
    });

    if (!mappedRow[0]) continue; 
    outputRows.push(mappedRow);
  }

  writeToData(SHEET_IDPLAYER_MAP, outputRows);
  Logger.log('_buildPlayerIdMap: ' + (outputRows.length - 1) + ' players mapped.');
}

// ============================================================
//  PLAYER MAP LOADING
// ============================================================

function getPlayerMaps(primaryIdHeader) {
  if (_playerMapsCache[primaryIdHeader]) return _playerMapsCache[primaryIdHeader];

  const dataSS   = getDataSS();
  const mapSheet = dataSS ? dataSS.getSheetByName(SHEET_IDPLAYER_MAP) : null;

  if (!mapSheet || mapSheet.getLastRow() < 2) {
    Logger.log('getPlayerMaps: _IDPLAYER_MAP empty or missing. Run refreshPlayerIdMap() first.');
    return {
      idMap: {}, mlbamMap: {}, nameMap: {},
      overrideNameMap: {}, overrideMlbamMap: {}, overridePlatformMap: {},
      primaryIdHeader: primaryIdHeader.toUpperCase()
    };
  }

  const data    = mapSheet.getDataRange().getValues();
  const headers = data[0].map(h => h.toString().trim().toUpperCase());

  const iMaster  = headers.indexOf('IDPLAYER');
  const iPrimary = headers.indexOf(primaryIdHeader.toUpperCase());
  const iMlbam   = headers.indexOf('MLBID');

  const nameIndices = [];
  headers.forEach((h, idx) => { if (h.includes('NAME')) nameIndices.push(idx); });

  const idMap = {}, mlbamMap = {}, nameMap = {};

  for (let i = 1; i < data.length; i++) {
    const row      = data[i];
    const masterId = row[iMaster] ? row[iMaster].toString().trim() : '';
    if (!masterId) continue;

    if (iPrimary !== -1 && row[iPrimary]) idMap[row[iPrimary].toString().trim()] = masterId;
    if (iMlbam   !== -1 && row[iMlbam])  mlbamMap[row[iMlbam].toString().trim()] = masterId;

    nameIndices.forEach(nIdx => {
      if (row[nIdx]) {
        const clean = _normalizeName(row[nIdx].toString());
        if (clean && !nameMap[clean]) nameMap[clean] = masterId;
      }
    });
  }

  const overrides = _buildOverrideMap();

  const result = {
    idMap, mlbamMap, nameMap,
    overrideNameMap:     overrides.nameMap,
    overrideMlbamMap:    overrides.mlbamMap,
    overridePlatformMap: overrides.platformMap,
    primaryIdHeader:     primaryIdHeader.toUpperCase()
  };

  _playerMapsCache[primaryIdHeader] = result;
  return result;
}

function _buildOverrideMap() {
  const ss    = getMasterSS();
  const sheet = ss.getSheetByName(ID_MATCHING_SHEET);

  if (!sheet || sheet.getLastRow() < ID_MATCHING_DATA_START) {
    return { nameMap: {}, mlbamMap: {}, platformMap: {} };
  }

  const allData = sheet.getDataRange().getValues();

  let headerRowIdx = -1;
  for (let i = 0; i < Math.min(5, allData.length); i++) {
    if (allData[i][IDM_COL_STATUS]?.toString().trim().toUpperCase() === 'STATUS') {
      headerRowIdx = i;
      break;
    }
  }

  if (headerRowIdx === -1) {
    Logger.log('_buildOverrideMap: ID Matching header row not found. No overrides loaded.');
    return { nameMap: {}, mlbamMap: {}, platformMap: {} };
  }

  const dataRows    = allData.slice(headerRowIdx + 1);
  const nameMap     = {};
  const mlbamMap    = {};
  const platformMap = {};

  dataRows.forEach(row => {
    const idPlayer = row[IDM_COL_IDPLAYER] ? row[IDM_COL_IDPLAYER].toString().trim() : '';
    if (!idPlayer) return; 

    const rawName  = row[IDM_COL_RAW_NAME]    ? row[IDM_COL_RAW_NAME].toString().trim()    : '';
    const mlbId    = row[IDM_COL_MLBID]       ? row[IDM_COL_MLBID].toString().trim()        : '';
    const platform = row[IDM_COL_PLATFORM]    ? row[IDM_COL_PLATFORM].toString().trim().toUpperCase() : '';
    const platId   = row[IDM_COL_PLATFORM_ID] ? row[IDM_COL_PLATFORM_ID].toString().trim() : '';

    if (rawName)              nameMap[_normalizeOverrideName(rawName)] = idPlayer;
    if (mlbId)                mlbamMap[mlbId]                          = idPlayer;
    if (platform && platId)   platformMap[platform + '|' + platId]     = idPlayer;
  });

  return { nameMap, mlbamMap, platformMap };
}

// ============================================================
//  ID RESOLUTION
// ============================================================

function resolveMasterId(maps, platformId, mlbamId, playerName, source, teamInfo) {
  const src = source || 'Unknown';
  
  const errorYear = new Date().getFullYear(); 
  
  let tm = '';
  if (typeof teamInfo === 'string' && teamInfo.trim() !== '') {
    const cleanTeam = teamInfo.trim().toUpperCase();
    tm = `=IFERROR(INDEX(MLB_TEAM_LOGOS, ROUNDUP(MATCH("${cleanTeam}", TOCOL(MLB_TEAM_CODES), 0) / COLUMNS(MLB_TEAM_CODES)), MATCH(${errorYear}, MLB_TEAM_YEARS, 0)), "${cleanTeam}")`;
  } else if (teamInfo && typeof teamInfo === 'object') {
    if (teamInfo.sheetName && teamInfo.nameCol && teamInfo.logoCol && playerName) {
      tm = `=IFERROR(INDEX('${teamInfo.sheetName}'!${teamInfo.logoCol}:${teamInfo.logoCol}, MATCH("${playerName}", '${teamInfo.sheetName}'!${teamInfo.nameCol}:${teamInfo.nameCol}, 0)), "")`;
    }
  }

  if (playerName) {
    const key = _normalizeOverrideName(playerName);
    if (maps.overrideNameMap[key]) return maps.overrideNameMap[key];
  }

  if (mlbamId) {
    const key = mlbamId.toString().trim();
    if (maps.overrideMlbamMap[key]) return maps.overrideMlbamMap[key];
  }

  if (platformId && maps.primaryIdHeader) {
    const key = maps.primaryIdHeader + '|' + platformId.toString().trim();
    if (maps.overridePlatformMap[key]) return maps.overridePlatformMap[key];
  }

  if (platformId) {
    const key = platformId.toString().trim();
    if (maps.idMap[key]) return maps.idMap[key];
  }

  if (mlbamId) {
    const key = mlbamId.toString().trim();
    if (maps.mlbamMap[key]) return maps.mlbamMap[key];
  }

  if (playerName) {
    const clean = _normalizeName(playerName);
    if (maps.nameMap[clean]) {
      return maps.nameMap[clean];
    }
  }

  // Unresolved - Extracting MLBID and PLATFORM details to push directly into columns
  if ((playerName || platformId || mlbamId) && source !== 'updatePlayers' && source !== 'getFantasyPros') {
    _idMatchingQueue.push({
      playerName: playerName || '',
      team:       tm,
      source:     src,
      idPlayer:   '',
      mlbamId:    mlbamId || '',
      platform:   platformId ? (maps.primaryIdHeader || '') : '',
      platformId: platformId || '',
      notes:      `Unresolved — platformId=${platformId}, mlbamId=${mlbamId}, name=${playerName}`
    });
  }

  return '';
}

// ============================================================
//  ID MATCHING QUEUE MANAGEMENT
// ============================================================

function flushIdMatchingQueue() {
  if (_idMatchingQueue.length === 0) return;

  const ss    = getMasterSS();
  const sheet = _getIdMatchingSheet(ss);
  if (!sheet) {
    Logger.log('flushIdMatchingQueue: ID Matching sheet unavailable. Queue not flushed.');
    return;
  }

  const iconFail = IDM_STATUS_FAIL;
  const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'MM/dd/yyyy');

  const existingRows  = _readIdMatchingDataRows(sheet);
  const existingNames = new Set();
  
  existingRows.forEach(row => {
    const name = row[IDM_COL_RAW_NAME] ? row[IDM_COL_RAW_NAME].toString().trim() : '';
    const notes = row[IDM_COL_NOTES] ? row[IDM_COL_NOTES].toString().trim() : '';
    
    const dedupKey = _normalizeName(name) || notes;
    if (dedupKey) existingNames.add(dedupKey);
  });

  const queuedNames = new Set();
  const newRows     = [];

  _idMatchingQueue.forEach(entry => {
    const rawName = entry.playerName || 'Unknown Player';
    const dedupKey = _normalizeName(rawName) || entry.notes;

    if (existingNames.has(dedupKey) || queuedNames.has(dedupKey)) return;
    queuedNames.add(dedupKey);

    const row = new Array(IDM_NUM_COLS).fill('');
    row[IDM_COL_STATUS]      = iconFail;
    row[IDM_COL_DATE]        = today;       
    row[IDM_COL_RAW_NAME]    = rawName;
    row[IDM_COL_TEAM]        = entry.team; 
    row[IDM_COL_SOURCE]      = entry.source;
    row[IDM_COL_IDPLAYER]    = entry.idPlayer;
    row[IDM_COL_MLBID]       = entry.mlbamId;     // NEW: Writes MLBID to Col G
    row[IDM_COL_PLATFORM]    = entry.platform;    // NEW: Writes Platform Header to Col H
    row[IDM_COL_PLATFORM_ID] = entry.platformId;  // NEW: Writes Platform ID to Col I
    row[IDM_COL_NOTES]       = entry.notes;
    newRows.push(row);
  });

  if (newRows.length > 0) {
    const allRows = [...existingRows, ...newRows];
    const sorted  = _sortIdMatchingRows(allRows, iconFail, IDM_STATUS_PASS);
    _writeIdMatchingRows(sheet, sorted);
    Logger.log('flushIdMatchingQueue: wrote ' + newRows.length + ' new entries to ID Matching.');
  }

  _idMatchingQueue = [];
}

function updateIdMatchingStatuses() {
  const ss    = getMasterSS();
  const sheet = _getIdMatchingSheet(ss);
  if (!sheet) return;

  const iconFail = IDM_STATUS_FAIL;
  const iconPass = IDM_STATUS_PASS;
  const overrides = _buildOverrideMap();
  const rows      = _readIdMatchingDataRows(sheet);

  if (rows.length === 0) return;

  let updates = 0;

  rows.forEach(row => {
    if (row[IDM_COL_STATUS]?.toString() !== iconFail) return;

    const rawName  = row[IDM_COL_RAW_NAME]    ? row[IDM_COL_RAW_NAME].toString().trim()    : '';
    const mlbId    = row[IDM_COL_MLBID]       ? row[IDM_COL_MLBID].toString().trim()        : '';
    const platform = row[IDM_COL_PLATFORM]    ? row[IDM_COL_PLATFORM].toString().trim().toUpperCase() : '';
    const platId   = row[IDM_COL_PLATFORM_ID] ? row[IDM_COL_PLATFORM_ID].toString().trim() : '';

    const passViaName     = rawName  && overrides.nameMap[_normalizeOverrideName(rawName)];
    const passViaMlbam    = mlbId    && overrides.mlbamMap[mlbId];
    const passViaPlatform = platform && platId && overrides.platformMap[platform + '|' + platId];

    if (passViaName || passViaMlbam || passViaPlatform) {
      row[IDM_COL_STATUS] = iconPass;
      updates++;
    }
  });

  if (updates > 0) {
    const sorted = _sortIdMatchingRows(rows, iconFail, iconPass);
    _writeIdMatchingRows(sheet, sorted);
    Logger.log('updateIdMatchingStatuses: updated ' + updates + ' rows to PASS.');
  } else {
    Logger.log('updateIdMatchingStatuses: no status changes needed.');
  }
}

function _sortIdMatchingRows(rows, iconFail, iconPass) {
  return rows.slice().sort((a, b) => {
    const getStatusRank = (status) => {
      if (status === iconFail) return 0;
      if (status === iconPass) return 2;
      return 1; 
    };
    
    const aStatusRank = getStatusRank(a[IDM_COL_STATUS]);
    const bStatusRank = getStatusRank(b[IDM_COL_STATUS]);
    if (aStatusRank !== bStatusRank) return aStatusRank - bStatusRank;

    const aDate = a[IDM_COL_DATE] ? new Date(a[IDM_COL_DATE]).getTime() : 0;
    const bDate = b[IDM_COL_DATE] ? new Date(b[IDM_COL_DATE]).getTime() : 0;
    if (aDate !== bDate) return aDate - bDate;

    const aSource = (a[IDM_COL_SOURCE] || '').toString().toLowerCase();
    const bSource = (b[IDM_COL_SOURCE] || '').toString().toLowerCase();
    const sourceCmp = aSource.localeCompare(bSource);
    if (sourceCmp !== 0) return sourceCmp;

    return (a[IDM_COL_RAW_NAME] || '').toString().toLowerCase()
      .localeCompare((b[IDM_COL_RAW_NAME] || '').toString().toLowerCase());
  });
}

function _writeIdMatchingRows(sheet, rows) {
  if (rows.length === 0) return;

  const needed = ID_MATCHING_DATA_START + rows.length - 1;

  if (sheet.getMaxRows() < needed) {
    sheet.insertRowsAfter(sheet.getMaxRows(), needed - sheet.getMaxRows());
    SpreadsheetApp.flush();
  }

  const lastRow = sheet.getLastRow();
  if (lastRow >= ID_MATCHING_DATA_START) {
    sheet.getRange(ID_MATCHING_DATA_START, 1,
      lastRow - ID_MATCHING_DATA_START + 1, IDM_NUM_COLS).clearContent();
  }

  sheet.getRange(ID_MATCHING_DATA_START, 1, rows.length, IDM_NUM_COLS).setValues(rows);
}

function _getIdMatchingSheet(ss) {
  let sheet = ss.getSheetByName(ID_MATCHING_SHEET);

  if (!sheet) {
    sheet = ss.insertSheet(ID_MATCHING_SHEET);
    sheet.getRange(1, 1).setValue('ID Matching');
    sheet.getRange(ID_MATCHING_HEADER_ROW, 1, 1, IDM_NUM_COLS)
      .setValues([ID_MATCHING_HEADERS]);
    Logger.log('_getIdMatchingSheet: created ID Matching sheet.');
  }

  return sheet;
}

function _readIdMatchingDataRows(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < ID_MATCHING_DATA_START) return [];

  const numRows = lastRow - ID_MATCHING_DATA_START + 1;
  const range   = sheet.getRange(ID_MATCHING_DATA_START, 1, numRows, IDM_NUM_COLS);

  const displayValues = range.getDisplayValues();
  const formulas = range.getFormulas();

  return displayValues.map((row, i) => {
    const merged = [...row];
    for (let col = 0; col < IDM_NUM_COLS; col++) {
      if (formulas[i][col]) {
        merged[col] = formulas[i][col];
      }
    }
    return merged;
  });
}

function _normalizeName(nameStr) {
  if (!nameStr) return '';
  return nameStr.toString()
    .split('(')[0].trim()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv)\b\.?/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function _normalizeOverrideName(nameStr) {
  if (!nameStr) return '';
  return nameStr.toString().trim()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv)\b\.?/g, '')
    .replace(/[^a-z0-9]/g, ''); 
}

function bustPlayerMapsCache() {
  _playerMapsCache = {};
  _idMatchingQueue = [];
}