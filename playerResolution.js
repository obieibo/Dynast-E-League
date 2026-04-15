/**
 * FILE: playerResolution.gs
 * PURPOSE: Universal player ID resolution system. Fetches and maintains
 * the Smart Fantasy Baseball ID map, builds lookup tables,
 * and resolves any platform ID or player name to the master
 * BBREF ID (IDPLAYER) used throughout the system.
 *
 * Also manages the ID Matching sheet in the master workbook,
 * which serves two purposes:
 * 1. OVERRIDE INPUT — user-maintained rows that force specific
 * resolution for ambiguous or incorrectly mapped players.
 * Replaces the old _IDPLAYER_OVERRIDES sheet in the Data WB.
 * 2. RESOLUTION MONITOR — script-written rows tracking players
 * that fell through to name fallback or were unresolvable.
 * Each row shows Status (PASS/FAIL), Source, and Notes so
 * you can identify and fix resolution gaps over time.
 *
 * READS FROM: Smart Fantasy Baseball CSV (external)
 * _IDPLAYER_CSV (Data WB)
 * _IDPLAYER_MAP (Data WB)
 * ID Matching (Master WB) — override entries + monitoring
 * Named ranges: ICON_PASS, ICON_FAIL
 * WRITES TO:  _IDPLAYER_CSV (Data WB)
 * _IDPLAYER_MAP (Data WB)
 * ID Matching (Master WB) — monitoring rows
 * CALLED BY:  All scripts that resolve player IDs
 * triggerGroups.gs (weekly refresh + flush after each group)
 * DEPENDENCIES: helperFunctions.gs, yahooAuthentication.gs
 *
 * ID RESOLUTION ORDER (most to least reliable):
 * 1. Override name map    — ID Matching sheet, preserves qualifiers
 * 2. Override MLBAM map   — ID Matching sheet, MLBID column
 * 2b. Override platform   — ID Matching sheet, ID Header + Platform ID
 * 3. Platform ID map      — _IDPLAYER_MAP, keyed by primaryIdHeader
 * 4. MLBAM map            — _IDPLAYER_MAP, co-primary key
 * 5. Name fallback        — last resort, queues player for ID Matching
 *
 * ID MATCHING SHEET STRUCTURE (Master WB):
 * Row 1 — Title
 * Row 2 — Blank
 * Row 3 — Headers:
 * A: Status | B: Date | C: Player Name (Raw) | D: Source |
 * E: IDPLAYER | F: MLBID | G: ID Header | H: Platform ID | I: Notes
 * Row 4+ — Data
 *
 * STATUS VALUES:
 * ICON_FAIL — player resolving via name fallback.
 * Add MLBID or Platform ID to improve.
 * ICON_PASS — player previously failed, now resolves
 * correctly via override data.
 *
 * FLUSH PATTERN:
 * resolveMasterId() accumulates entries in _idMatchingQueue.
 * triggerGroups.gs calls flushIdMatchingQueue() after each trigger
 * group so all entries from all scripts are written in one pass.
 * Individual scripts do NOT call flushIdMatchingQueue directly.
 */


// ============================================================
//  CONSTANTS — SFBB SOURCE
// ============================================================

const SFBB_CSV_URL       = 'https://www.smartfantasybaseball.com/PLAYERIDMAPCSV';
const SHEET_IDPLAYER_CSV = '_IDPLAYER_CSV';
const SHEET_IDPLAYER_MAP = '_IDPLAYER_MAP';

// Canonical column order for _IDPLAYER_MAP
const IDPLAYER_MAP_HEADERS = [
  'IDPLAYER', 'PLAYERNAME', 'BIRTHDATE', 'FIRSTNAME', 'LASTNAME',
  'MLBID', 'IDFANGRAPHS', 'YAHOOID', 'CBSID', 'RETROID', 'BREFID',
  'FANGRAPHSNAME', 'MLBNAME', 'CBSNAME', 'FANTPROSNAME', 'LG', 'POS', 'TEAM'
];

// Maps IDPLAYER_MAP_HEADERS to SFBB CSV column names
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

const ID_MATCHING_SHEET      = 'ID Matching';  // Lives in master workbook
const ID_MATCHING_DATA_START = 4;              // Data begins at row 4
const ID_MATCHING_HEADER_ROW = 3;              // Headers are on row 3

// Column indices (0-based) — must match ID_MATCHING_HEADERS order below
const IDM_COL_STATUS      = 0;  // A — ICON_PASS or ICON_FAIL
const IDM_COL_DATE        = 1;  // B — date record was first created
const IDM_COL_RAW_NAME    = 2;  // C — Player Name (Raw) as it appeared in source
const IDM_COL_SOURCE      = 3;  // D — which script/source produced this player
const IDM_COL_IDPLAYER    = 4;  // E — IDPLAYER — user fills in to create override
const IDM_COL_MLBID       = 5;  // F — MLBID — user fills in for MLBAM override
const IDM_COL_ID_HEADER   = 6;  // G — ID Header — e.g. IDFANGRAPHS, YAHOOID
const IDM_COL_PLATFORM_ID = 7;  // H — Platform ID — the platform-native ID value
const IDM_COL_NOTES       = 8;  // I — resolution detail from script log
const IDM_NUM_COLS        = 9;

const IDM_STATUS_FAIL = '=ICON_FAIL';
const IDM_STATUS_PASS = '=ICON_PASS';

const ID_MATCHING_HEADERS = [
  'STATUS', 'DATE', 'PLAYER NAME (RAW)', 'SOURCE',
  'IDPLAYER', 'MLBID', 'ID HEADER', 'PLATFORM ID', 'NOTES'
];


// ============================================================
//  IN-MEMORY CACHE
//  Persists for the lifetime of a single script execution only.
// ============================================================

let _playerMapsCache = {};  // Keyed by primaryIdHeader
let _idMatchingQueue = [];  // Accumulated during execution, flushed by triggerGroups


// ============================================================
//  REFRESH PLAYER ID MAP
// ============================================================

/**
 * Main entry point for refreshing the player ID map.
 * Fetches the Smart Fantasy Baseball CSV, writes it to _IDPLAYER_CSV,
 * then rebuilds _IDPLAYER_MAP. Run manually or via weekly trigger.
 *
 * If the fetch fails, existing _IDPLAYER_CSV and _IDPLAYER_MAP are
 * preserved unchanged — a failed refresh never corrupts live data.
 *
 * On success: stamps UPDATE_ID_MAP timestamp and busts the maps cache
 * so subsequent calls in the same execution get fresh data.
 */
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

  writeToData(SHEET_IDPLAYER_CSV, csvData);
  Logger.log('refreshPlayerIdMap: wrote ' + (csvData.length - 1) + ' rows to ' + SHEET_IDPLAYER_CSV);

  _buildPlayerIdMap(csvData);

  const tsRange = getMasterSS().getRangeByName('UPDATE_ID_MAP');
  if (tsRange) tsRange.setValue(new Date());

  bustPlayerMapsCache();
  Logger.log('refreshPlayerIdMap: complete.');
}


/**
 * Builds _IDPLAYER_MAP from a raw parsed CSV array.
 * Normalizes to IDPLAYER_MAP_HEADERS column order.
 * Skips rows without a valid IDPLAYER (BBREF ID).
 * ID Matching overrides are handled separately via _buildOverrideMap()
 * and are not merged here — this function is SFBB source data only.
 *
 * @param {Array[]} csvData - Raw parsed CSV including header row
 */
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

    if (!mappedRow[0]) continue; // Skip rows without BBREF ID
    outputRows.push(mappedRow);
  }

  writeToData(SHEET_IDPLAYER_MAP, outputRows);
  Logger.log('_buildPlayerIdMap: ' + (outputRows.length - 1) + ' players mapped.');
}


// ============================================================
//  PLAYER MAP LOADING
// ============================================================

/**
 * Builds and returns all in-memory lookup maps for player ID resolution.
 * Cached per primaryIdHeader for the current script execution lifetime.
 *
 * Returned object contains:
 * idMap              — platformId  → IDPLAYER (keyed by primaryIdHeader column)
 * mlbamMap           — MLBAM ID    → IDPLAYER (always built, co-primary)
 * nameMap            — normalized name → IDPLAYER (last resort, strips qualifiers)
 * overrideNameMap    — normalized override name → IDPLAYER (preserves qualifiers)
 * overrideMlbamMap   — MLBID override → IDPLAYER
 * overridePlatformMap — 'ID_HEADER|ID' → IDPLAYER
 * primaryIdHeader    — stored for step 2b key building in resolveMasterId()
 *
 * @param  {string} primaryIdHeader - Column in _IDPLAYER_MAP to use as platform key.
 * e.g. 'YAHOOID', 'IDFANGRAPHS', 'MLBID'
 * @returns {Object}
 */
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


/**
 * Builds three override lookup maps from the ID Matching sheet
 * in the master workbook. Only rows with IDPLAYER populated
 * create overrides — monitoring rows without IDPLAYER are skipped.
 *
 * nameMap      — _normalizeOverrideName(Player Name Raw) → IDPLAYER
 * Preserves parenthetical qualifiers so 'Max Muncy (LAD) (B)'
 * and 'Max Muncy (ATH) (B)' remain distinct keys.
 *
 * mlbamMap     — MLBID (string) → IDPLAYER
 * Most reliable disambiguation for same-name players.
 *
 * platformMap  — 'ID_HEADER|PLATFORM_ID' (string) → IDPLAYER
 * For platform IDs mapped incorrectly in SFBB CSV.
 *
 * @returns {{ nameMap: Object, mlbamMap: Object, platformMap: Object }}
 */
function _buildOverrideMap() {
  const ss    = getMasterSS();
  const sheet = ss.getSheetByName(ID_MATCHING_SHEET);

  if (!sheet || sheet.getLastRow() < ID_MATCHING_DATA_START) {
    return { nameMap: {}, mlbamMap: {}, platformMap: {} };
  }

  const allData = sheet.getDataRange().getValues();

  // Find header row dynamically — look for 'STATUS' in col A within first 5 rows
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
    if (!idPlayer) return; // Only rows with IDPLAYER create overrides

    const rawName  = row[IDM_COL_RAW_NAME]    ? row[IDM_COL_RAW_NAME].toString().trim()    : '';
    const mlbId    = row[IDM_COL_MLBID]        ? row[IDM_COL_MLBID].toString().trim()        : '';
    const idHeader = row[IDM_COL_ID_HEADER]   ? row[IDM_COL_ID_HEADER].toString().trim().toUpperCase() : '';
    const platId   = row[IDM_COL_PLATFORM_ID]  ? row[IDM_COL_PLATFORM_ID].toString().trim() : '';

    if (rawName)              nameMap[_normalizeOverrideName(rawName)] = idPlayer;
    if (mlbId)                mlbamMap[mlbId]                          = idPlayer;
    if (idHeader && platId)   platformMap[idHeader + '|' + platId]     = idPlayer;
  });

  return { nameMap, mlbamMap, platformMap };
}


// ============================================================
//  ID RESOLUTION
// ============================================================

/**
 * Resolves any combination of platform ID, MLBAM ID, or player name
 * to the master IDPLAYER (BBREF ID) used throughout the system.
 *
 * Resolution order:
 * 1. Override name map   — overrideNameMap, preserves qualifiers (ID Matching)
 * 2. Override MLBAM map  — overrideMlbamMap (ID Matching)
 * 2b. Override platform  — overridePlatformMap (ID Matching)
 * 3. Platform ID map     — idMap from _IDPLAYER_MAP
 * 4. MLBAM co-primary    — mlbamMap from _IDPLAYER_MAP
 * 5. Name fallback       — strips qualifiers, last resort, queues for ID Matching
 *
 * Pass null for any parameter not available from the calling source.
 * Never pass undefined. Source parameter should be the calling script
 * name as a string (e.g. 'updateDraft', 'getFanGraphsBat').
 * Defaults to 'Unknown' for backward compatibility.
 *
 * @param  {Object}      maps       - Result of getPlayerMaps()
 * @param  {string|null} platformId - Platform-native ID (Yahoo ID, FG ID, etc.)
 * @param  {string|null} mlbamId    - MLBAM ID
 * @param  {string|null} playerName - Player display name from source data
 * @param  {string}      [source]   - Calling script name for ID Matching logging
 * @returns {string} IDPLAYER or '' if unresolvable
 */
function resolveMasterId(maps, platformId, mlbamId, playerName, source) {
  const src = source || 'Unknown';

  // 1. Override name map — preserves qualifiers via _normalizeOverrideName
  if (playerName) {
    const key = _normalizeOverrideName(playerName);
    if (maps.overrideNameMap[key]) return maps.overrideNameMap[key];
  }

  // 2. Override MLBAM map
  if (mlbamId) {
    const key = mlbamId.toString().trim();
    if (maps.overrideMlbamMap[key]) return maps.overrideMlbamMap[key];
  }

  // 2b. Override platform ID map
  if (platformId && maps.primaryIdHeader) {
    const key = maps.primaryIdHeader + '|' + platformId.toString().trim();
    if (maps.overridePlatformMap[key]) return maps.overridePlatformMap[key];
  }

  // 3. Platform-specific ID
  if (platformId) {
    const key = platformId.toString().trim();
    if (maps.idMap[key]) return maps.idMap[key];
  }

  // 4. MLBAM co-primary
  if (mlbamId) {
    const key = mlbamId.toString().trim();
    if (maps.mlbamMap[key]) return maps.mlbamMap[key];
  }

  // 5. Name fallback — strips qualifiers, last resort
  if (playerName) {
    const clean = _normalizeName(playerName);
    if (maps.nameMap[clean]) {
      _idMatchingQueue.push({
        playerName: playerName,
        source:     src,
        idPlayer:   maps.nameMap[clean],
        notes:      `Resolved "${playerName}" via name fallback. Add MLBID or Platform ID to improve resolution.`
      });
      return maps.nameMap[clean];
    }
  }

  // Unresolved
  if (playerName || platformId || mlbamId) {
    _idMatchingQueue.push({
      playerName: playerName || '',
      source:     src,
      idPlayer:   '',
      notes:      `Unresolved — platformId=${platformId}, mlbamId=${mlbamId}, name=${playerName}`
    });
  }

  return '';
}


// ============================================================
//  ID MATCHING QUEUE MANAGEMENT
// ============================================================

/**
 * Writes all accumulated _idMatchingQueue entries to the ID Matching
 * sheet in the master workbook. Called by triggerGroups.gs at the
 * end of each trigger group — NOT by individual scripts directly.
 *
 * Behavior:
 * - Reads existing ID Matching rows to build deduplication set
 * - Skips entries whose Player Name (Raw) already exists in the sheet
 * - Deduplication uses _normalizeName() for matching against existing names
 * - New entries are written with ICON_FAIL status + today's date
 * formatted as MM/dd/yyyy string to avoid setValues() Date object errors
 * - All rows (existing + new) are sorted: FAIL first, Date ASC, Name ASC
 * - Clears queue after writing
 *
 * If queue is empty or ID Matching sheet is unavailable, returns immediately.
 */
function flushIdMatchingQueue() {
  if (_idMatchingQueue.length === 0) return;

  const ss    = getMasterSS();
  const sheet = _getIdMatchingSheet(ss);
  if (!sheet) {
    Logger.log('flushIdMatchingQueue: ID Matching sheet unavailable. Queue not flushed.');
    return;
  }

  const iconFail = IDM_STATUS_FAIL;

  // Format date as string — Date objects cause setValues() Service errors
  const today = Utilities.formatDate(
    new Date(),
    Session.getScriptTimeZone(),
    'MM/dd/yyyy'
  );

  // Load existing rows and build dedup set
  const existingRows  = _readIdMatchingDataRows(sheet);
  const existingNames = new Set();
  
  existingRows.forEach(row => {
    const name = row[IDM_COL_RAW_NAME] ? row[IDM_COL_RAW_NAME].toString().trim() : '';
    const notes = row[IDM_COL_NOTES] ? row[IDM_COL_NOTES].toString().trim() : '';
    
    // Deduplicate by normalized name, or fallback to exact notes if name is 'Unknown Player'
    const dedupKey = _normalizeName(name) || notes;
    if (dedupKey) existingNames.add(dedupKey);
  });

  // Build new rows, deduplicating within queue and against existing
  const queuedNames = new Set();
  const newRows     = [];

  _idMatchingQueue.forEach(entry => {
    // If Yahoo didn't provide a name, label them as Unknown
    const rawName = entry.playerName || 'Unknown Player';
    
    // Deduplicate by normalized name, or fallback to notes
    const dedupKey = _normalizeName(rawName) || entry.notes;

    // Skip if we already logged this exact failure
    if (existingNames.has(dedupKey) || queuedNames.has(dedupKey)) return;

    queuedNames.add(dedupKey);

    const row = new Array(IDM_NUM_COLS).fill('');
    row[IDM_COL_STATUS]   = iconFail;
    row[IDM_COL_DATE]     = today;       // String, not Date object
    row[IDM_COL_RAW_NAME] = rawName;
    row[IDM_COL_SOURCE]   = entry.source;
    row[IDM_COL_IDPLAYER] = entry.idPlayer;
    row[IDM_COL_NOTES]    = entry.notes;
    newRows.push(row);
  });

  if (newRows.length > 0) {
    const allRows = [...existingRows, ...newRows];
    const sorted  = _sortIdMatchingRows(allRows, iconFail);
    _writeIdMatchingRows(sheet, sorted);
    Logger.log('flushIdMatchingQueue: wrote ' + newRows.length + ' new entries to ID Matching.');
  }

  _idMatchingQueue = [];
}


/**
 * Reviews all FAIL-status rows in the ID Matching sheet and updates
 * their status to ICON_PASS if they would now resolve
 * without name fallback using the current override maps.
 *
 * A FAIL row is promoted to PASS when ANY of these are true:
 * - Its Player Name (Raw) exists in current overrideNameMap
 * - Its MLBID exists in current overrideMlbamMap
 * - Its ID Header + Platform ID exists in current overridePlatformMap
 *
 * Call after refreshPlayerIdMap() or after adding override data to
 * ID Matching to immediately reflect updated resolution status.
 * Called from weeklyUpdates() in triggerGroups.gs.
 */
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
    const mlbId    = row[IDM_COL_MLBID]        ? row[IDM_COL_MLBID].toString().trim()        : '';
    const idHeader = row[IDM_COL_ID_HEADER]   ? row[IDM_COL_ID_HEADER].toString().trim().toUpperCase() : '';
    const platId   = row[IDM_COL_PLATFORM_ID]  ? row[IDM_COL_PLATFORM_ID].toString().trim() : '';

    const passViaName     = rawName  && overrides.nameMap[_normalizeOverrideName(rawName)];
    const passViaMlbam    = mlbId    && overrides.mlbamMap[mlbId];
    const passViaPlatform = idHeader && platId && overrides.platformMap[idHeader + '|' + platId];

    if (passViaName || passViaMlbam || passViaPlatform) {
      row[IDM_COL_STATUS] = iconPass;
      updates++;
    }
  });

  if (updates > 0) {
    const sorted = _sortIdMatchingRows(rows, iconFail);
    _writeIdMatchingRows(sheet, sorted);
    Logger.log('updateIdMatchingStatuses: updated ' + updates + ' rows to PASS.');
  } else {
    Logger.log('updateIdMatchingStatuses: no status changes needed.');
  }
}


/**
 * Sorts ID Matching data rows in memory.
 * Sort order: FAIL first → Date ASC → Player Name (Raw) ASC.
 * Comparison uses iconFail value to distinguish status without
 * depending on alphabetical ordering of icon values.
 *
 * @param  {Array[]} rows     - Data rows (no header row)
 * @param  {string}  iconFail - ICON_FAIL value for comparison
 * @returns {Array[]} Sorted copy of rows
 */
function _sortIdMatchingRows(rows, iconFail) {
  return rows.slice().sort((a, b) => {
    // Status: FAIL first
    const aFail = a[IDM_COL_STATUS] === iconFail ? 0 : 1;
    const bFail = b[IDM_COL_STATUS] === iconFail ? 0 : 1;
    if (aFail !== bFail) return aFail - bFail;

    // Date: ascending
    const aDate = a[IDM_COL_DATE] ? new Date(a[IDM_COL_DATE]).getTime() : 0;
    const bDate = b[IDM_COL_DATE] ? new Date(b[IDM_COL_DATE]).getTime() : 0;
    if (aDate !== bDate) return aDate - bDate;

    // Player Name: ascending
    return (a[IDM_COL_RAW_NAME] || '').toString().toLowerCase()
      .localeCompare((b[IDM_COL_RAW_NAME] || '').toString().toLowerCase());
  });
}


/**
 * Writes sorted data rows to the ID Matching sheet starting at
 * ID_MATCHING_DATA_START. Inserts rows if the sheet does not
 * have enough to accommodate all data.
 * Clears the existing data area before writing.
 *
 * @param {Sheet}   sheet - The ID Matching sheet
 * @param {Array[]} rows  - Sorted data rows (no header row)
 */
function _writeIdMatchingRows(sheet, rows) {
  if (rows.length === 0) return;

  const needed = ID_MATCHING_DATA_START + rows.length - 1;

  // Insert rows if the sheet does not have enough capacity
  // Without this, setValues() throws a Service error when the
  // data range exceeds the sheet's current maximum row count
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


/**
 * Returns the ID Matching sheet from the master workbook.
 * Creates it with the correct header structure if it does not exist.
 *
 * Created structure:
 * Row 1 — 'ID Matching' title
 * Row 2 — blank
 * Row 3 — column headers
 * Row 4+ — data (empty on creation)
 *
 * @param  {Spreadsheet} ss - Master spreadsheet
 * @returns {Sheet}
 */
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


/**
 * Reads all data rows from the ID Matching sheet starting at
 * ID_MATCHING_DATA_START. Returns empty array if no data yet.
 *
 * The STATUS column is read using getFormulas() rather than
 * getValues() so that formula strings like '=ICON_FAIL'
 * are returned for comparison rather than their evaluated CellImage
 * results. All other columns are read using getDisplayValues() to
 * avoid CellImage objects in non-status columns.
 *
 * @param  {Sheet} sheet - The ID Matching sheet
 * @returns {Array[]} Data rows (no header rows)
 */
function _readIdMatchingDataRows(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < ID_MATCHING_DATA_START) return [];

  const numRows = lastRow - ID_MATCHING_DATA_START + 1;
  const range   = sheet.getRange(ID_MATCHING_DATA_START, 1, numRows, IDM_NUM_COLS);

  // Read display values for all columns
  const displayValues = range.getDisplayValues();

  // Read formulas for status column only (col A = column 1)
  const statusFormulas = sheet
    .getRange(ID_MATCHING_DATA_START, IDM_COL_STATUS + 1, numRows, 1)
    .getFormulas();

  // Merge: replace status display value with its formula string
  // so comparison logic works against '=ICON_FAIL' etc.
  return displayValues.map((row, i) => {
    const merged = [...row];
    const formula = statusFormulas[i][0];
    merged[IDM_COL_STATUS] = formula || row[IDM_COL_STATUS];
    return merged;
  });
}

// ============================================================
//  NAME NORMALIZATION
// ============================================================

/**
 * Normalizes a player name for MAIN nameMap lookups (step 5 fallback).
 * Strips parenthetical qualifiers so 'Shohei Ohtani (Batter)' falls
 * back to match 'Shohei Ohtani' in the main _IDPLAYER_MAP.
 *
 * Do NOT use for override nameMap keys. Use _normalizeOverrideName()
 * which preserves qualifiers so 'Max Muncy (LAD) (B)' and
 * 'Max Muncy (ATH) (B)' remain distinct keys.
 *
 * @param  {string} nameStr
 * @returns {string}
 */
function _normalizeName(nameStr) {
  if (!nameStr) return '';
  return nameStr.toString()
    .split('(')[0].trim()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv)\b\.?/g, '')
    .replace(/[^a-z0-9]/g, '');
}


/**
 * Normalizes a player name for OVERRIDE nameMap keys and lookups.
 * Identical to _normalizeName() except parenthetical qualifiers are
 * PRESERVED so qualified variants remain distinct keys.
 *
 * 'Max Muncy (LAD) (B)' → 'maxmuncyladb'        (distinct)
 * 'Max Muncy (ATH) (B)' → 'maxmuncyathb'        (distinct)
 * 'Shohei Ohtani (Batter)' → 'shoheiohtanibatter'
 * 'José Ramírez'          → 'joseramirez'
 *
 * @param  {string} nameStr
 * @returns {string}
 */
function _normalizeOverrideName(nameStr) {
  if (!nameStr) return '';
  return nameStr.toString().trim()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv)\b\.?/g, '')
    .replace(/[^a-z0-9]/g, '');  // No split('(')[0] — qualifiers preserved
}


// ============================================================
//  UTILITIES
// ============================================================

/**
 * Clears the in-memory player maps cache and ID Matching queue.
 * Call before any operation that modifies _IDPLAYER_MAP or the
 * ID Matching sheet mid-execution to force fresh reads.
 */
function bustPlayerMapsCache() {
  _playerMapsCache = {};
  _idMatchingQueue = [];
}