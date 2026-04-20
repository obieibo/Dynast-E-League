/**
 * FILE: saveAcquired.gs
 * PURPOSE: Reads the current _ROSTERS snapshot and maintains a
 * persistent acquisition log in _ACQUIRED. Tracks how
 * each player was acquired by their current fantasy team
 * (Draft, Free Agency, Waivers, Trade) and when.
 *
 * _ACQUIRED is the source of truth for ACQUIRED and
 * DATE in _ROSTERS. updateRosters.gs reads this
 * file to enrich roster rows — saveAcquired.gs writes it.
 * This separation means acquisition history survives across
 * roster changes within a season.
 *
 * MODIFIED: Now acts as a strict 1-to-1 mirror of _ROSTERS.
 * Maintains EXACTLY ONE record per rostered player based on 
 * their current Team ID. If a player is traded or dropped, 
 * their old record is automatically purged.
 */


// ============================================================
//  CONSTANTS
// ============================================================

const ACQUIRED_SHEET   = '_ACQUIRED';
const ACQUIRED_HEADERS = [
  'YEAR', 'IDPLAYER', 'PLAYER', 'MLB_TEAM',
  'TEAM_ID', 'MANAGER_ID', 'ROSTER', 'KEEPER', 'ROUND',
  'ACQUIRED', 'DATE'
];

// Column indices for _ROSTERS source data (0-based, matches ROSTERS_HEADERS)
const RST_COL_IDPLAYER     = 0;
const RST_COL_PLAYER       = 1;
const RST_COL_MLB_TEAM     = 2;
const RST_COL_ELIGIBILITY  = 3;
const RST_COL_POSITION     = 4;
const RST_COL_IL           = 5;
const RST_COL_NA           = 6;
const RST_COL_STATUS       = 7;
const RST_COL_TEAM_ID      = 8;
const RST_COL_MANAGER_ID   = 9;
const RST_COL_ROSTER       = 10;
const RST_COL_TRANSACTION  = 11;
const RST_COL_TRANS_DATE   = 12;
const RST_COL_KEEPER       = 13;
const RST_COL_ROUND        = 14;
const RST_COL_ACQUIRED     = 15;
const RST_COL_DATE         = 16;


// ============================================================
//  MAIN FUNCTION
// ============================================================

function saveAcquired() {
  const ss = getPrimarySS();

  const currentYearRange = ss.getRangeByName('CURRENT_YEAR');
  if (!currentYearRange) {
    Logger.log('saveAcquired: CURRENT_YEAR named range not found. Aborting.');
    return;
  }

  const currentYear = currentYearRange.getValue();
  const dataSS      = getDataSS();
  if (!dataSS) {
    Logger.log('saveAcquired: Data workbook unavailable. Aborting.');
    return;
  }

  // Load _ROSTERS
  const rosterSheet = dataSS.getSheetByName(ROSTERS_SHEET);
  if (!rosterSheet || rosterSheet.getLastRow() < 2) {
    Logger.log('saveAcquired: _ROSTERS empty or missing. Run updateRosters() first.');
    return;
  }

  const rosterData = rosterSheet.getDataRange().getValues();
  if (rosterData.length <= 1) {
    Logger.log('saveAcquired: _ROSTERS has no data rows.');
    return;
  }

  // Load existing _ACQUIRED and build map keyed by Player + Team
  const { existingMap } = _loadExistingAcquired(dataSS);

  const finalRows = [];
  const addedKeys = new Set();

  // Iterate strictly over _ROSTERS to build the new dataset
  for (let i = 1; i < rosterData.length; i++) {
    const row      = rosterData[i];
    const idPlayer = row[RST_COL_IDPLAYER] ? row[RST_COL_IDPLAYER].toString().trim() : '';
    const teamId   = row[RST_COL_TEAM_ID]  ? row[RST_COL_TEAM_ID].toString().trim()  : '';

    if (!idPlayer) continue;

    // Key is strictly IDPLAYER + TEAM_ID. 
    // If a player is traded, the team ID changes, so the old record is naturally dropped!
    const key = `${idPlayer}|${teamId}`;
    if (addedKeys.has(key)) continue;

    if (existingMap.has(key)) {
      // Pull the existing record
      const existingRow = existingMap.get(key);
      
      // Update the Year to the current year to keep the log fresh
      existingRow[0] = currentYear;
      
      // OVERWRITE the Acquired and Date columns with the freshest data from _ROSTERS
      existingRow[9]  = row[RST_COL_ACQUIRED] || '';
      existingRow[10] = row[RST_COL_DATE]     || '';
      
      finalRows.push(existingRow);
    } else {
      // Create an entirely new record
      finalRows.push([
        currentYear,
        idPlayer,
        row[RST_COL_PLAYER]        || '',
        row[RST_COL_MLB_TEAM]      || '',
        teamId,
        row[RST_COL_MANAGER_ID]    || '',
        row[RST_COL_ROSTER]        || '',
        row[RST_COL_KEEPER]        || '',
        row[RST_COL_ROUND]         || '',
        row[RST_COL_ACQUIRED]      || '', 
        row[RST_COL_DATE]          || ''  
      ]);
    }
    addedKeys.add(key);
  }

  if (finalRows.length === 0) {
    Logger.log('saveAcquired: no acquisition records to add/preserve.');
    return;
  }

  // Sort and write back
  finalRows.sort((a, b) => {
    // Year DESC
    if (b[0] !== a[0]) return b[0] - a[0];
    
    // Team ID ASC (Index 4 is TEAM_ID)
    const tA = parseInt(a[4]) || 0;
    const tB = parseInt(b[4]) || 0;
    if (tA !== tB) return tA - tB;
    
    // Player name ASC
    return (a[2] || '').toString().toLowerCase()
      .localeCompare((b[2] || '').toString().toLowerCase());
  });

  writeToData(ACQUIRED_SHEET, [ACQUIRED_HEADERS, ...finalRows]);
  Logger.log('saveAcquired: retained/added ' + finalRows.length + ' total records. Old duplicates purged.');
}


// ============================================================
//  EXISTING DATA LOADER
// ============================================================

function _loadExistingAcquired(dataSS) {
  const sheet = dataSS.getSheetByName(ACQUIRED_SHEET);

  if (!sheet || sheet.getLastRow() < 2) {
    return { existingMap: new Map() };
  }

  const data    = sheet.getDataRange().getValues();
  const headers = data[0].map(h => h.toString().trim().toUpperCase());

  const iId     = headers.indexOf('IDPLAYER');
  const iTeamId = headers.indexOf('TEAM_ID');

  if (iId === -1) {
    Logger.log('_loadExistingAcquired: IDPLAYER column missing from _ACQUIRED.');
    return { existingMap: new Map() };
  }

  const existingMap = new Map();

  for (let i = 1; i < data.length; i++) {
    const row    = data[i];
    const id     = iId     !== -1 ? row[iId]     : '';
    const teamId = iTeamId !== -1 ? row[iTeamId] : '';

    if (!id) continue;

    // Build map using strict composite key: IDPLAYER|TEAM_ID (No Year!)
    const key = `${id.toString().trim()}|${teamId.toString().trim()}`;
    existingMap.set(key, row);
  }

  return { existingMap };
}