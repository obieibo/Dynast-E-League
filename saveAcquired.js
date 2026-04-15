/**
 * FILE: saveAcquired.gs
 * PURPOSE: Reads the current _ROSTERS snapshot and maintains a
 *          persistent acquisition log in _ACQUIRED. Tracks how
 *          each player was acquired by their current fantasy team
 *          (Draft, Free Agency, Waivers, Trade) and when.
 *
 *          _ACQUIRED is the source of truth for ACQUIRED_VIA and
 *          ACQUIRED_DATE in _ROSTERS. updateRosters.gs reads this
 *          file to enrich roster rows — saveAcquired.gs writes it.
 *          This separation means acquisition history survives across
 *          roster changes within a season.
 *
 *          The core problem this solves: if a player is traded mid-
 *          season, their most recent transaction becomes the trade.
 *          Without _ACQUIRED we lose the knowledge that they were
 *          originally drafted in round 3 and not added off waivers.
 *          _ACQUIRED stores the acquisition at the moment a player
 *          first appears on a roster and preserves it until they
 *          leave that roster.
 *
 * READS FROM: _ROSTERS (Data WB) — current roster snapshot
 *             _ACQUIRED (Data WB) — existing acquisition history
 * WRITES TO:  _ACQUIRED (Data WB)
 * CALLED BY:  commonUpdates() in triggerGroups.gs
 *             Must run AFTER updateRosters() — reads _ROSTERS output
 * DEPENDENCIES: helperFunctions.gs
 *
 * OUTPUT SCHEMA (_ACQUIRED):
 *   Col A  YEAR         — Season year
 *   Col B  IDPLAYER     — Master BBREF ID
 *   Col C  PLAYER       — Player display name
 *   Col D  MLB_TEAM     — MLB team abbreviation
 *   Col E  ELIGIBILITY  — Full eligibility string
 *   Col F  POSITION     — Clean eligibility string (IL/NA stripped)
 *   Col G  IL           — TRUE if player has IL eligibility
 *   Col H  NA           — TRUE if player has NA eligibility
 *   Col I  STATUS       — 'Rostered'
 *   Col J  TEAM_ID      — Yahoo fantasy team ID
 *   Col K  MANAGER_ID   — Yahoo manager ID
 *   Col L  ROSTER       — Fantasy team display name
 *   Col M  TRANSACTION  — Transaction type at time of acquisition
 *   Col N  TRANS_DATE   — Transaction date at time of acquisition
 *   Col O  KEEPER       — 'K' if keeper, '' if not
 *   Col P  ROUND        — Draft round at time of acquisition
 *   Col Q  ACQUIRED_VIA — How player was acquired
 *   Col R  ACQUIRED_DATE — When player was acquired
 *
 * MERGE STRATEGY:
 *   _ACQUIRED is keyed by YEAR + IDPLAYER + TEAM_ID (composite key).
 *   On each run:
 *     - Players already in _ACQUIRED for the current year are skipped —
 *       their original acquisition record is preserved unchanged.
 *     - Players in _ROSTERS who have no _ACQUIRED record are added
 *       as new entries using the acquisition data from _ROSTERS.
 *     - Prior year rows are always preserved unchanged.
 *
 *   This means: once a player appears in _ACQUIRED, their record
 *   is frozen until they leave that roster. If they are traded and
 *   then re-acquired by a different team, the new team gets a new
 *   record (different TEAM_ID) while the old team's record remains.
 *
 * SORT ORDER:
 *   Year DESC → Team ID ASC → Player name ASC
 */


// ============================================================
//  CONSTANTS
// ============================================================

const ACQUIRED_SHEET   = '_ACQUIRED';
const ACQUIRED_HEADERS = [
  'YEAR', 'IDPLAYER', 'PLAYER', 'MLB_TEAM',
  'TEAM_ID', 'MANAGER_ID', 'ROSTER', 'KEEPER', 'ROUND',
  'ACQUIRED_VIA', 'ACQUIRED_DATE'
];

// Column indices for _ROSTERS source data (0-based, matches ROSTERS_HEADERS)
// Used when extracting values from _ROSTERS rows
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
const RST_COL_ACQUIRED_VIA = 15;
const RST_COL_ACQUIRED_DATE = 16;


// ============================================================
//  MAIN FUNCTION
// ============================================================

/**
 * Reads the current _ROSTERS snapshot and merges new acquisition
 * records into _ACQUIRED. Existing records for the current year
 * are preserved — only players with no existing record are added.
 *
 * Execution steps:
 *   1. Read CURRENT_YEAR from master Settings
 *   2. Load current _ROSTERS data
 *   3. Load existing _ACQUIRED data and build composite key set
 *   4. Identify new players (in _ROSTERS but not in _ACQUIRED)
 *   5. Merge new records with existing, sort, and write back
 */
function saveAcquired() {
  const ss = getMasterSS();

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

  // Step 2 — Load _ROSTERS
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

  // Step 3 — Load existing _ACQUIRED and build composite key set
  const { existingRows, existingKeys } = _loadExistingAcquired(dataSS, currentYear);

  // Step 4 — Identify new players not yet in _ACQUIRED
  const newRows = [];

  for (let i = 1; i < rosterData.length; i++) {
    const row      = rosterData[i];
    const idPlayer = row[RST_COL_IDPLAYER] ? row[RST_COL_IDPLAYER].toString().trim() : '';
    const teamId   = row[RST_COL_TEAM_ID]  ? row[RST_COL_TEAM_ID].toString().trim()  : '';

    if (!idPlayer) continue;

    // Composite key: YEAR|IDPLAYER|TEAM_ID
    // TEAM_ID is included so a player traded to a new team gets a
    // fresh record on the new team while the old team's record is preserved
    const key = `${currentYear}|${idPlayer}|${teamId}`;
    if (existingKeys.has(key)) continue; // Already recorded — skip

    newRows.push([
      currentYear,
      idPlayer,
      row[RST_COL_PLAYER]        || '',
      row[RST_COL_MLB_TEAM]      || '',
      teamId,
      row[RST_COL_MANAGER_ID]    || '',
      row[RST_COL_ROSTER]        || '',
      row[RST_COL_KEEPER]        || '',
      row[RST_COL_ROUND]         || '',
      row[RST_COL_ACQUIRED_VIA]  || '',
      row[RST_COL_ACQUIRED_DATE] || ''
    ]);
  }

  if (newRows.length === 0) {
    Logger.log('saveAcquired: no new acquisition records to add.');
    return;
  }

  // Step 5 — Merge new rows with existing, sort, and write
  const allRows = [...existingRows, ...newRows];

  allRows.sort((a, b) => {
    // Year DESC
    if (b[0] !== a[0]) return b[0] - a[0];
    // Team ID ASC
    const tA = parseInt(a[9]) || 0;
    const tB = parseInt(b[9]) || 0;
    if (tA !== tB) return tA - tB;
    // Player name ASC
    return (a[2] || '').toString().toLowerCase()
      .localeCompare((b[2] || '').toString().toLowerCase());
  });

  writeToData(ACQUIRED_SHEET, [ACQUIRED_HEADERS, ...allRows]);
  Logger.log('saveAcquired: added ' + newRows.length + ' new records. Total: ' + allRows.length + '.');
}


// ============================================================
//  EXISTING DATA LOADER
// ============================================================

/**
 * Reads the current _ACQUIRED sheet and returns all data rows
 * plus a Set of composite deduplication keys.
 *
 * Composite key format: 'YEAR|IDPLAYER|TEAM_ID'
 * This allows a player who is traded and re-acquired by a new
 * team to have a fresh record on the new team while preserving
 * the original team's record.
 *
 * Returns empty structures if _ACQUIRED does not exist yet —
 * first run will populate it entirely from _ROSTERS.
 *
 * Prior year rows (year !== currentYear) are always included in
 * existingRows so they are preserved in the output — only current
 * year keys are added to existingKeys for deduplication since we
 * only skip records that already exist for the current year.
 *
 * @param  {Spreadsheet} dataSS      - Data workbook
 * @param  {number}      currentYear - Current season year
 * @returns {{ existingRows: Array[], existingKeys: Set }}
 */
function _loadExistingAcquired(dataSS, currentYear) {
  const sheet = dataSS.getSheetByName(ACQUIRED_SHEET);

  if (!sheet || sheet.getLastRow() < 2) {
    Logger.log('_loadExistingAcquired: _ACQUIRED empty or missing. Starting fresh.');
    return { existingRows: [], existingKeys: new Set() };
  }

  const data    = sheet.getDataRange().getValues();
  const headers = data[0].map(h => h.toString().trim().toUpperCase());

  const iYear   = headers.indexOf('YEAR');
  const iId     = headers.indexOf('IDPLAYER');
  const iTeamId = headers.indexOf('TEAM_ID');

  if (iId === -1) {
    Logger.log('_loadExistingAcquired: IDPLAYER column missing from _ACQUIRED.');
    return { existingRows: [], existingKeys: new Set() };
  }

  const existingRows = [];
  const existingKeys = new Set();

  for (let i = 1; i < data.length; i++) {
    const row    = data[i];
    const year   = iYear   !== -1 ? row[iYear]   : '';
    const id     = iId     !== -1 ? row[iId]     : '';
    const teamId = iTeamId !== -1 ? row[iTeamId] : '';

    if (!id) continue;

    existingRows.push(row);

    // Only build dedup keys for current year rows —
    // prior year keys are not checked during deduplication
    if (parseInt(year) === parseInt(currentYear)) {
      existingKeys.add(`${currentYear}|${id.toString().trim()}|${teamId.toString().trim()}`);
    }
  }

  Logger.log('_loadExistingAcquired: loaded ' + existingRows.length + ' rows, ' +
             existingKeys.size + ' current year keys.');
  return { existingRows, existingKeys };
}