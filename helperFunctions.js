/**
 * FILE: helperFunctions.gs
 * PURPOSE: Core infrastructure utilities shared across all scripts.
 * Provides workbook access, Yahoo API fetch wrappers (with retry logic),
 * Yahoo player data parsing, sheet write functions (one
 * per workbook), timestamp management, and year rollover
 * handling for projection archiving.
 *
 * READS FROM: Named ranges in master sheet (Settings tab)
 * Yahoo API (via yahooAuthentication.gs)
 * WRITES TO:  Master workbook, Data workbook, Archive workbook
 * (via dedicated write functions below)
 * CALLED BY:  All data fetch and update scripts
 * DEPENDENCIES: yahooAuthentication.gs, playerResolution.gs
 *
 * WORKBOOK ARCHITECTURE:
 * Master   — Display sheets, dashboards, calculation layers.
 * Named ranges for all settings live here.
 * Data     — All raw data written by scripts. Never directly
 * viewed by the user. ID: SHEET_DATA_ID named range.
 * Archive  — Prior year snapshots. Written once per year during
 * rollover. ID: SHEET_ARCHIVE_ID named range.
 *
 * WRITE FUNCTION SUMMARY:
 * writeToSheet(sheetName, data)    → Master workbook
 * writeToData(sheetName, data)     → Data workbook
 * writeToArchive(sheetName, data)  → Archive workbook
 * All three follow identical behavior:
 * - Creates sheet if it does not exist
 * - Clears existing content before writing
 * - Writes data array starting at A1
 */


// ============================================================
//  IN-MEMORY WORKBOOK CACHE
//  Caches open spreadsheet references for the lifetime of a
//  single script execution. Prevents redundant openById calls
//  when multiple functions access the same workbook.
// ============================================================

let _masterSSCache  = null;
let _dataSSCache    = null;
let _archiveSSCache = null;


// ============================================================
//  WORKBOOK ACCESS
// ============================================================

/**
 * Returns the master (active) spreadsheet.
 * This is the spreadsheet the script is bound to.
 * All named ranges (Settings) live here.
 *
 * @returns {Spreadsheet}
 */
function getMasterSS() {
  if (_masterSSCache) return _masterSSCache;
  _masterSSCache = SpreadsheetApp.getActiveSpreadsheet();
  return _masterSSCache;
}


/**
 * Returns the Data workbook.
 * Spreadsheet ID is read from the SHEET_DATA_ID named range
 * in the master sheet Settings tab.
 * All raw script-written data lives here.
 *
 * @returns {Spreadsheet|null} Data workbook, or null if ID not set
 */
function getDataSS() {
  if (_dataSSCache) return _dataSSCache;

  const ss    = getMasterSS();
  const range = ss.getRangeByName('SHEET_DATA_ID');

  if (!range || !range.getValue()) {
    Logger.log('getDataSS: SHEET_DATA_ID named range is missing or empty.');
    return null;
  }

  _dataSSCache = SpreadsheetApp.openById(range.getValue().toString().trim());
  return _dataSSCache;
}


/**
 * Returns the Archive workbook.
 * Spreadsheet ID is read from the SHEET_ARCHIVE_ID named range
 * in the master sheet Settings tab.
 * Prior year data snapshots are written here during year rollover.
 *
 * @returns {Spreadsheet|null} Archive workbook, or null if ID not set
 */
function getArchiveSS() {
  if (_archiveSSCache) return _archiveSSCache;

  const ss    = getMasterSS();
  const range = ss.getRangeByName('SHEET_ARCHIVE_ID');

  if (!range || !range.getValue()) {
    Logger.log('getArchiveSS: SHEET_ARCHIVE_ID named range is missing or empty.');
    return null;
  }

  _archiveSSCache = SpreadsheetApp.openById(range.getValue().toString().trim());
  return _archiveSSCache;
}


/**
 * Clears all cached workbook references.
 * Call at the start of any script that might be affected by a
 * Settings change mid-execution (rare, but possible during setup).
 */
function bustWorkbookCache() {
  _masterSSCache  = null;
  _dataSSCache    = null;
  _archiveSSCache = null;
}


// ============================================================
//  SHEET WRITE FUNCTIONS
//  One function per workbook. All three share identical behavior.
//  Rule: the destination is always explicit — no script decides
//  where to write based on logic; the function name declares it.
// ============================================================

/**
 * Writes data to a named sheet in the MASTER workbook.
 * Use for: display sheets, calculation layers, dashboard data.
 * Creates the sheet if it does not exist.
 * Clears all existing content before writing.
 *
 * @param {string}   sheetName  - Target sheet name
 * @param {Array[]}  dataArray  - 2D array of values, row 0 = headers
 */
function writeToSheet(sheetName, dataArray) {
  _writeToWorkbook(getMasterSS(), sheetName, dataArray, 'Master');
}


/**
 * Writes data to a named sheet in the DATA workbook.
 * Use for: all raw data written by Yahoo, FanGraphs, Savant,
 * FantasyPros, and Prospect Savant scripts.
 * Creates the sheet if it does not exist.
 * Clears all existing content before writing.
 *
 * @param {string}   sheetName  - Target sheet name
 * @param {Array[]}  dataArray  - 2D array of values, row 0 = headers
 */
function writeToData(sheetName, dataArray) {
  const dataSS = getDataSS();
  if (!dataSS) {
    Logger.log('writeToData: Data workbook unavailable. Skipping write to ' + sheetName);
    return;
  }
  _writeToWorkbook(dataSS, sheetName, dataArray, 'Data');
}


/**
 * Writes data to a named sheet in the ARCHIVE workbook.
 * Use for: prior year snapshots during annual rollover.
 * Called by _handleYearRollover() and archive scripts.
 * Creates the sheet if it does not exist.
 * Clears all existing content before writing.
 *
 * @param {string}   sheetName  - Target sheet name
 * @param {Array[]}  dataArray  - 2D array of values, row 0 = headers
 */
function writeToArchive(sheetName, dataArray) {
  const archiveSS = getArchiveSS();
  if (!archiveSS) {
    Logger.log('writeToArchive: Archive workbook unavailable. Skipping write to ' + sheetName);
    return;
  }
  _writeToWorkbook(archiveSS, sheetName, dataArray, 'Archive');
}


/**
 * Internal shared write implementation used by all three public
 * write functions. Do not call directly from data scripts.
 *
 * @param {Spreadsheet} workbook   - Target spreadsheet
 * @param {string}      sheetName  - Target sheet name
 * @param {Array[]}     dataArray  - 2D array of values
 * @param {string}      label      - Workbook label for log messages
 */
function _writeToWorkbook(workbook, sheetName, dataArray, label) {
  if (!dataArray || dataArray.length === 0) {
    Logger.log('_writeToWorkbook [' + label + '/' + sheetName + ']: empty data, skipping.');
    return;
  }

  let sheet = workbook.getSheetByName(sheetName);
  if (!sheet) {
    sheet = workbook.insertSheet(sheetName);
    Logger.log('_writeToWorkbook [' + label + ']: created new sheet ' + sheetName);
  }

  const numCols    = dataArray[0].length;
  const lastRow    = sheet.getLastRow();
  const lastCol    = sheet.getLastColumn();

  if (lastRow > 0 && lastCol > 0) {
    sheet.getRange(1, 1, lastRow, Math.max(numCols, lastCol)).clearContent();
  }

  sheet.getRange(1, 1, dataArray.length, numCols).setValues(dataArray);
  Logger.log('_writeToWorkbook [' + label + '/' + sheetName + ']: wrote ' +
             (dataArray.length - 1) + ' rows, ' + numCols + ' cols.');
}


// ============================================================
//  YAHOO API FETCH WRAPPERS (With Retry Logic)
//  All Yahoo API calls route through these two functions.
//  fetchYahooAPI for a single request.
//  fetchAllYahooAPI for parallel batch requests (faster, preferred).
// ============================================================

/**
 * Fetches a single Yahoo Fantasy Sports API endpoint with exponential backoff.
 * Guards against transient network exceptions (like "Address unavailable")
 * and 5xx server errors from Yahoo.
 * * Returns parsed JSON or null on failure.
 * All callers should null-check the return value before use.
 *
 * @param {string} url - Full Yahoo API URL with format=json
 * @returns {Object|null} Parsed JSON response or null
 */
function fetchYahooAPI(url) {
  if (!hasYahooAccess()) {
    Logger.log('fetchYahooAPI: not authorized. Run getAuthorizationUrl().');
    return null;
  }

  const options = {
    headers: { 'Authorization': 'Bearer ' + getYahooAccessToken() },
    muteHttpExceptions: true
  };

  let attempts = 0;
  const maxAttempts = 3;
  const backoffMs = 2000;

  while (attempts < maxAttempts) {
    try {
      const response = UrlFetchApp.fetch(url, options);
      const responseCode = response.getResponseCode();

      if (responseCode === 200) {
        return JSON.parse(response.getContentText());
      } else if (responseCode >= 500 && responseCode < 600) {
        Logger.log(`fetchYahooAPI: HTTP ${responseCode} (Attempt ${attempts + 1}/${maxAttempts}) for ${url}`);
        // Fall through to the retry block
      } else {
        // For 4xx errors (e.g. 400 Bad Request, 401 Unauthorized), fail immediately
        Logger.log(`fetchYahooAPI: HTTP ${responseCode} for ${url}`);
        return null;
      }
    } catch (e) {
      // Catches hard network errors like "Exception: Address unavailable"
      Logger.log(`fetchYahooAPI: Exception "${e.message}" (Attempt ${attempts + 1}/${maxAttempts}) for ${url}`);
      // Fall through to the retry block
    }

    attempts++;
    if (attempts < maxAttempts) {
      // Exponential backoff: 2s, 4s...
      Utilities.sleep(backoffMs * attempts);
    }
  }

  Logger.log(`fetchYahooAPI: Failed permanently after ${maxAttempts} attempts for ${url}`);
  return null;
}


/**
 * Fetches multiple Yahoo API endpoints in parallel using UrlFetchApp.fetchAll.
 * Implements exponential backoff for the entire batch if any hard network exceptions 
 * ("Address unavailable") or 5xx server errors occur.
 * * Significantly faster than sequential fetchYahooAPI calls for batch operations.
 * Returns an array of parsed JSON responses in the same order as the input URLs.
 * Failed or errored requests return null at their index — callers must handle nulls.
 *
 * Use this for: roster fetches, matchup history, player batch lookups,
 * any operation needing more than 2-3 Yahoo API calls.
 *
 * @param {string[]} urls - Array of Yahoo API URLs
 * @returns {(Object|null)[]} Array of parsed JSON responses, same length as urls
 */
function fetchAllYahooAPI(urls) {
  if (!hasYahooAccess()) {
    Logger.log('fetchAllYahooAPI: not authorized. Run getAuthorizationUrl().');
    return urls.map(() => null);
  }

  if (!urls || urls.length === 0) return [];

  const headers  = { 'Authorization': 'Bearer ' + getYahooAccessToken() };
  const requests = urls.map(url => ({
    url:               url,
    headers:           headers,
    muteHttpExceptions: true
  }));

  let attempts = 0;
  const maxAttempts = 3;
  const backoffMs = 2000;

  while (attempts < maxAttempts) {
    try {
      const responses = UrlFetchApp.fetchAll(requests);
      
      // Check for 5xx errors across the batch. If we hit one, trigger a retry.
      let has5xx = false;
      for (let i = 0; i < responses.length; i++) {
        if (responses[i].getResponseCode() >= 500 && responses[i].getResponseCode() < 600) {
          has5xx = true;
          break;
        }
      }

      if (has5xx && attempts < maxAttempts - 1) {
        Logger.log(`fetchAllYahooAPI: 5xx detected in batch (Attempt ${attempts + 1}/${maxAttempts}). Retrying...`);
        // Fall through to the retry block
      } else {
        // Map and parse the successful batch
        return responses.map((res, i) => {
          if (res.getResponseCode() !== 200) {
            Logger.log(`fetchAllYahooAPI: HTTP ${res.getResponseCode()} for ${urls[i]}`);
            return null;
          }
          try {
            return JSON.parse(res.getContentText());
          } catch (e) {
            Logger.log(`fetchAllYahooAPI: JSON parse error at index ${i} — ${e.message}`);
            return null;
          }
        });
      }
    } catch (e) {
      // Catches hard network errors that break UrlFetchApp.fetchAll completely
      Logger.log(`fetchAllYahooAPI: Exception "${e.message}" in batch (Attempt ${attempts + 1}/${maxAttempts})`);
      // Fall through to the retry block
    }

    attempts++;
    if (attempts < maxAttempts) {
      Utilities.sleep(backoffMs * attempts);
    }
  }

  Logger.log(`fetchAllYahooAPI: Batch failed permanently after ${maxAttempts} attempts`);
  return urls.map(() => null);
}


// ============================================================
//  YAHOO PLAYER PARSER
//  Normalizes the inconsistent Yahoo API player response structure
//  into a flat, predictable object used throughout all scripts.
// ============================================================

/**
 * Parses a Yahoo API player data array into a flat player object.
 * Yahoo returns player data as a nested array of heterogeneous objects
 * rather than a consistent keyed structure — this function normalizes that.
 *
 * Returns a player object with these fields:
 * pKey        — Yahoo player key (e.g. '422.p.8967')
 * pId         — Yahoo player ID (numeric string)
 * edKey       — Editorial player key
 * name        — Full display name
 * team        — MLB team abbreviation (uppercased)
 * positions   — Comma-separated eligibility string (includes IL, NA if present)
 * status      — Injury status string (e.g. 'IL10', 'DTD') or ''
 * injuryNote  — Injury description string or ''
 * keeper      — 'K' if the player is flagged as a keeper, else ''
 *
 * @param {Array} playerDataArray - The raw player array from Yahoo API response
 * @returns {Object} Normalized player object
 */
function parseYahooPlayer(playerDataArray) {
  const p = {
    pKey:       '',
    pId:        '',
    edKey:      '',
    name:       '',
    team:       '',
    positions:  '',
    status:     '',
    injuryNote: '',
    keeper:     ''
  };

  if (!playerDataArray || !Array.isArray(playerDataArray)) return p;

  playerDataArray.forEach(block => {
    if (!Array.isArray(block)) return;

    block.forEach(item => {
      if (!item) return;

      if      (item.player_key)           p.pKey       = item.player_key;
      else if (item.player_id)            p.pId        = item.player_id.toString();
      else if (item.editorial_player_key) p.edKey      = item.editorial_player_key;
      else if (item.name)                 p.name       = item.name.full || '';
      else if (item.editorial_team_abbr)  p.team       = item.editorial_team_abbr.toUpperCase();
      else if (item.status)               p.status     = item.status;
      else if (item.injury_note)          p.injuryNote = item.injury_note;
      else if (item.is_keeper && item.is_keeper.status == 1) p.keeper = 'K';
      else if (item.eligible_positions) {
        p.positions = item.eligible_positions
          .map(pos => pos.position)
          .filter(Boolean)
          .join(', ');
      }
    });
  });

  return p;
}


/**
 * Parses raw Yahoo position eligibility string into structured flags.
 * Strips IL and NA from the clean position string but records them
 * as boolean flags — used across roster, player, waiver, and IL scripts.
 *
 * @param {string} eligibilityString - Comma-separated positions from Yahoo
 * e.g. 'C, 1B, IL' or 'SP, RP, NA'
 * @returns {{ cleanPositions: string, isIL: boolean, isNA: boolean }}
 */
function parsePositions(eligibilityString) {
  if (!eligibilityString) {
    return { cleanPositions: '', isIL: false, isNA: false };
  }

  const parts         = eligibilityString.split(',').map(s => s.trim()).filter(Boolean);
  const isIL          = parts.includes('IL');
  const isNA          = parts.includes('NA');
  const cleanPositions = parts.filter(p => p !== 'IL' && p !== 'NA').join(', ');

  return { cleanPositions, isIL, isNA };
}


// ============================================================
//  TIMESTAMP UTILITIES
// ============================================================

/**
 * Writes the current date/time to a named range in the master sheet.
 * Used by all scripts to record when they last ran successfully.
 * Named ranges follow the UPDATE_* convention defined in Settings.
 *
 * Common named ranges:
 * UPDATE_HOURLY, UPDATE_DAILY, UPDATE_WEEKLY,
 * UPDATE_MANAGERS, UPDATE_LEAGUE, UPDATE_DRAFTS, UPDATE_ID_MAP
 *
 * @param {string} namedRange - The named range to write the timestamp to
 */
function updateTimestamp(namedRange) {
  const ss    = getMasterSS();
  const range = ss.getRangeByName(namedRange);

  if (!range) {
    Logger.log('updateTimestamp: named range ' + namedRange + ' not found.');
    return;
  }

  range.setValue(new Date());
  SpreadsheetApp.flush();
}


// ============================================================
//  CELL COUNT UTILITY
// ============================================================

/**
 * Counts total allocated cells across all three workbooks and
 * writes the counts to their respective named ranges in Settings.
 * Run at the end of each trigger group to monitor Sheets limits.
 *
 * Google Sheets limit: 10,000,000 cells per spreadsheet.
 * Named ranges written:
 * COUNT_CELLS_MASTER   — cell count in master workbook
 * COUNT_CELLS_DATA     — cell count in data workbook
 * COUNT_CELLS_ARCHIVE  — cell count in archive workbook
 *
 * Note: counts allocated cells (rows × cols per sheet), not
 * cells with data. This matches how Google enforces the limit.
 */
function spreadsheetCounts() {
  const ss = getMasterSS();

  const targets = [
    { getter: getMasterSS,  rangeName: 'COUNT_CELLS_MASTER'  },
    { getter: getDataSS,    rangeName: 'COUNT_CELLS_DATA'    },
    { getter: getArchiveSS, rangeName: 'COUNT_CELLS_ARCHIVE' }
  ];

  targets.forEach(target => {
    const workbook = target.getter();
    if (!workbook) return;

    const sheets     = workbook.getSheets();
    const totalCells = sheets.reduce((sum, sheet) => {
      return sum + (sheet.getMaxRows() * sheet.getMaxColumns());
    }, 0);

    const range = ss.getRangeByName(target.rangeName);
    if (range) range.setValue(totalCells);
  });

  SpreadsheetApp.flush();
}


// ============================================================
//  YEAR ROLLOVER
//  Called at the start of projection fetch scripts.
//  When the calendar year advances, copies current-year projection
//  data to the Archive workbook before overwriting with new data.
//  Only the two projection sheets are rolled — stat history and
//  prospect data have their own archiving logic per script.
// ============================================================

/**
 * Detects if the calendar year has advanced since last recorded in
 * CURRENT_YEAR named range. If so, archives projection sheets to
 * the Archive workbook and updates CURRENT_YEAR.
 *
 * Sheets archived on rollover:
 * _FG_PROJ_B  — FanGraphs batter projections
 * _FG_PROJ_P  — FanGraphs pitcher projections
 *
 * All other year-over-year archiving is handled per-script using
 * the prevYear pattern (check archive → fetch prev → fetch current).
 *
 * @param {Spreadsheet} ss - The master spreadsheet (passed in to avoid
 * redundant getMasterSS() calls from callers)
 */
function _handleYearRollover(ss) {
  const currentYearRange = ss.getRangeByName('CURRENT_YEAR');
  if (!currentYearRange) {
    Logger.log('_handleYearRollover: CURRENT_YEAR named range not found.');
    return;
  }

  const savedYear  = parseInt(currentYearRange.getValue(), 10);
  const actualYear = new Date().getFullYear();

  if (actualYear <= savedYear) return; // No rollover needed

  Logger.log('_handleYearRollover: year advanced from ' + savedYear + ' to ' + actualYear + '. Archiving projections.');

  const dataSS    = getDataSS();
  const archiveSS = getArchiveSS();

  if (!dataSS || !archiveSS) {
    Logger.log('_handleYearRollover: workbook(s) unavailable. Rollover skipped.');
    return;
  }

  const sheetsToRoll = ['_FG_PROJ_B', '_FG_PROJ_P'];

  sheetsToRoll.forEach(sheetName => {
    const srcSheet = dataSS.getSheetByName(sheetName);
    if (!srcSheet || srcSheet.getLastRow() < 2) {
      Logger.log('_handleYearRollover: ' + sheetName + ' empty or missing, skipping.');
      return;
    }

    const values = srcSheet.getDataRange().getValues();
    writeToArchive(sheetName, values);
    srcSheet.clearContents();
    Logger.log('_handleYearRollover: archived and cleared ' + sheetName);
  });

  currentYearRange.setValue(actualYear);
  SpreadsheetApp.flush();
  Logger.log('_handleYearRollover: CURRENT_YEAR updated to ' + actualYear);
}