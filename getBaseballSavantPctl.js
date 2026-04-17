/**
 * FILE: getBaseballSavantPctl.gs
 * PURPOSE: Fetches Baseball Savant percentile rankings for batters
 *          and pitchers from the Statcast leaderboard CSV endpoint.
 *          Maintains current year data in the Data workbook and
 *          archives the prior year on first run of a new season.
 *
 * READS FROM: Baseball Savant CSV endpoints (2 fetches)
 *             Archive workbook — to detect whether prior year exists
 *             _IDPLAYER_MAP (Data WB) via getPlayerMaps()
 * WRITES TO:  _BS_B (Data WB) — batter percentile rankings
 *             _BS_P (Data WB) — pitcher percentile rankings
 *             Archive workbook — prior year snapshots on rollover
 * CALLED BY:  occasionalUpdates() in triggerGroups.gs
 * DEPENDENCIES: helperFunctions.gs, playerResolution.gs
 *
 * OUTPUT SCHEMA (_BS_B and _BS_P):
 *   Col A   IDPLAYER      — Master BBREF ID (prepended)
 *   Col B+  [SAVANT COLS] — All columns from the Savant CSV as-is,
 *                           except player_id which is replaced by
 *                           IDPLAYER in col A. Column names and
 *                           count vary as Savant updates their data.
 *
 * ARCHIVE PATTERN:
 *   On each run, the prior year is checked in the Archive workbook.
 *   If the prior year data is missing or stale, it is fetched and
 *   archived before the current year data is written. This ensures
 *   a full prior year snapshot exists even if the script was not
 *   run at the end of the prior season.
 */


// ============================================================
//  CONSTANTS
// ============================================================

const SAVANT_ENDPOINTS = [
  {
    sheetName: '_BS_B',
    url:       'https://baseballsavant.mlb.com/leaderboard/percentile-rankings?type=batter&team=&csv=true'
  },
  {
    sheetName: '_BS_P',
    url:       'https://baseballsavant.mlb.com/leaderboard/percentile-rankings?type=pitcher&team=&csv=true'
  }
];


// ============================================================
//  MAIN FUNCTION
// ============================================================

/**
 * Fetches batter and pitcher percentile rankings from Baseball Savant.
 * Archives prior year data if not already present, then writes
 * current year data to the Data workbook.
 */
function getBaseballSavantPctl() {
  const ss          = getMasterSS();
  const archiveSS   = getArchiveSS();
  const currentYear = parseInt(ss.getRangeByName('CURRENT_YEAR')?.getValue(), 10);
  const prevYear    = currentYear - 1;

  if (!currentYear) {
    Logger.log('getBaseballSavantPctl: CURRENT_YEAR not found. Aborting.');
    return;
  }
  if (!archiveSS) {
    Logger.log('getBaseballSavantPctl: Archive workbook unavailable. Aborting.');
    return;
  }

  const maps = getPlayerMaps('MLBID');

  SAVANT_ENDPOINTS.forEach(endpoint => {
    // Archive prior year if not already present
    const archiveSheet = archiveSS.getSheetByName(endpoint.sheetName);
    const prevYearData = _readSavantYearFromSheet(archiveSheet);

    if (prevYearData !== prevYear) {
      Logger.log('getBaseballSavantPctl: archiving ' + prevYear + ' for ' + endpoint.sheetName);
      const prevData = _fetchSavantData(endpoint.url, prevYear, maps);
      if (prevData && prevData.length > 1) {
        writeToArchive(endpoint.sheetName, prevData);
      }
    }

    // Fetch and write current year
    const currentData = _fetchSavantData(endpoint.url, currentYear, maps);
    if (currentData && currentData.length > 1) {
      writeToData(endpoint.sheetName, currentData);
      Logger.log('getBaseballSavantPctl: wrote ' + (currentData.length - 1) +
                 ' rows to ' + endpoint.sheetName);
    }
  });

  updateTimestamp('UPDATE_BS');
}


// ============================================================
//  FETCH HELPER
// ============================================================

/**
 * Fetches the Savant percentile CSV for a given year and returns
 * a 2D array with IDPLAYER prepended to each row.
 *
 * The Savant CSV includes a player_id column containing MLBAM IDs.
 * This column is used for resolution but replaced in the output by
 * IDPLAYER (BBREF ID) in column A to match the system master key.
 * The player_id column itself is dropped from the output.
 *
 * @param  {string} baseUrl - Savant endpoint URL (without year param)
 * @param  {number} year    - Season year to fetch
 * @param  {Object} maps    - Player resolution maps (keyed by MLBID)
 * @returns {Array[]|null} 2D array with headers, or null on failure
 */
function _fetchSavantData(baseUrl, year, maps) {
  const url      = `${baseUrl}&year=${year}`;
  const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });

  if (response.getResponseCode() !== 200) {
    Logger.log('_fetchSavantData: HTTP ' + response.getResponseCode() + ' for year ' + year);
    return null;
  }

  const csvData = Utilities.parseCsv(response.getContentText());
  if (!csvData || csvData.length <= 1) {
    Logger.log('_fetchSavantData: empty or malformed CSV for year ' + year);
    return null;
  }

  const rawHeaders  = csvData[0];
  const iPlayerId   = rawHeaders.indexOf('player_id');
  const iPlayerName = rawHeaders.indexOf('player_name');
  const iFirstName  = rawHeaders.indexOf('first_name');
  const iLastName   = rawHeaders.indexOf('last_name');

  // Build output headers — replace player_id with IDPLAYER at front
  const outputHeaders = ['IDPLAYER'];
  rawHeaders.forEach((h, idx) => {
    if (idx !== iPlayerId) outputHeaders.push(h);
  });

  const outputRows = [outputHeaders];

  for (let i = 1; i < csvData.length; i++) {
    const row = csvData[i];

    const mlbId   = iPlayerId   !== -1 ? row[iPlayerId]   : null;
    let   fullName = '';
    if (iPlayerName !== -1) {
      fullName = row[iPlayerName];
    } else if (iFirstName !== -1 && iLastName !== -1) {
      fullName = `${row[iFirstName]} ${row[iLastName]}`;
    }

    const masterId = resolveMasterId(maps, null, mlbId, fullName, 'getBaseballSavantPctl');

    const newRow = [masterId];
    row.forEach((val, idx) => {
      if (idx !== iPlayerId) newRow.push(val);
    });

    outputRows.push(newRow);
  }

  return outputRows;
}


// ============================================================
//  ARCHIVE YEAR READER
// ============================================================

/**
 * Reads the year value from row 2 of a Savant archive sheet to
 * determine which year of data it contains. Returns 0 if the
 * sheet is missing, empty, or the year cannot be parsed.
 *
 * Savant CSVs include a 'year' column — row 2 of the archive
 * sheet is the first data row and its 'year' cell identifies
 * the season. This is used to avoid re-fetching prior year
 * data that is already correctly archived.
 *
 * @param  {Sheet|null} sheet - The archive sheet, or null if not found
 * @returns {number} Year found in the sheet, or 0
 */
function _readSavantYearFromSheet(sheet) {
  if (!sheet || sheet.getLastRow() < 2) return 0;

  const headers  = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const yearIdx  = headers.indexOf('year');
  if (yearIdx === -1) return 0;

  return parseInt(sheet.getRange(2, yearIdx + 1).getValue(), 10) || 0;
}