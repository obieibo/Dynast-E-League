/**
 * @file _helpers.gs
 * @description Core infrastructure utilities shared across all scripts.
 * Provides workbook access, Yahoo API fetch wrappers (with retries), sheet writers, 
 * central error logging, and player data parsers.
 * @writesTo Primary, Data, Archive workbooks, and 'Error Log'
 */

// ============================================================================
//  WORKBOOK CACHE
// ============================================================================
let _primarySSCache = null;
let _dataSSCache = null;
let _archiveSSCache = null;

// ============================================================================
//  WORKBOOK ACCESS
// ============================================================================

/**
 * Returns the Primary (active) spreadsheet.
 * @returns {SpreadsheetApp.Spreadsheet}
 */
function getPrimarySS() {
  if (_primarySSCache) return _primarySSCache;
  _primarySSCache = SpreadsheetApp.getActiveSpreadsheet();
  return _primarySSCache;
}

/**
 * Returns the Data workbook using the SHEET_DATA_ID named range.
 * @returns {SpreadsheetApp.Spreadsheet|null}
 */
function getDataSS() {
  if (_dataSSCache) return _dataSSCache;
  const range = getPrimarySS().getRangeByName('SHEET_DATA_ID');
  if (!range || !range.getValue()) {
    _logError('_helpers.gs', 'SHEET_DATA_ID missing or empty.', 'CRITICAL');
    return null;
  }
  _dataSSCache = SpreadsheetApp.openById(range.getValue().toString().trim());
  return _dataSSCache;
}

/**
 * Returns the Archive workbook using the SHEET_ARCHIVE_ID named range.
 * @returns {SpreadsheetApp.Spreadsheet|null}
 */
function getArchiveSS() {
  if (_archiveSSCache) return _archiveSSCache;
  const range = getPrimarySS().getRangeByName('SHEET_ARCHIVE_ID');
  if (!range || !range.getValue()) {
    _logError('_helpers.gs', 'SHEET_ARCHIVE_ID missing or empty.', 'CRITICAL');
    return null;
  }
  _archiveSSCache = SpreadsheetApp.openById(range.getValue().toString().trim());
  return _archiveSSCache;
}

// ============================================================================
//  SHEET WRITE FUNCTIONS
// ============================================================================

/**
 * Writes 2D array data to the Primary workbook.
 * @param {string} sheetName - Target sheet.
 * @param {Array[]} dataArray - 2D array of values.
 */
function writeToPrimary(sheetName, dataArray) {
  _writeToWorkbook(getPrimarySS(), sheetName, dataArray);
}

/**
 * Writes 2D array data to the Data workbook.
 * @param {string} sheetName - Target sheet.
 * @param {Array[]} dataArray - 2D array of values.
 */
function writeToData(sheetName, dataArray) {
  const ss = getDataSS();
  if (ss) _writeToWorkbook(ss, sheetName, dataArray);
}

/**
 * Writes 2D array data to the Archive workbook.
 * @param {string} sheetName - Target sheet.
 * @param {Array[]} dataArray - 2D array of values.
 */
function writeToArchive(sheetName, dataArray) {
  const ss = getArchiveSS();
  if (ss) _writeToWorkbook(ss, sheetName, dataArray);
}

/**
 * Internal core write logic. Clears target sheet before writing.
 */
function _writeToWorkbook(workbook, sheetName, dataArray) {
  if (!dataArray || dataArray.length === 0) return;
  let sheet = workbook.getSheetByName(sheetName);
  if (!sheet) sheet = workbook.insertSheet(sheetName);

  const numCols = dataArray[0].length;
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();

  if (lastRow > 0 && lastCol > 0) {
    sheet.getRange(1, 1, lastRow, Math.max(numCols, lastCol)).clearContent();
  }
  sheet.getRange(1, 1, dataArray.length, numCols).setValues(dataArray);
}

// ============================================================================
//  YAHOO API FETCH WRAPPERS
// ============================================================================

/**
 * Fetches a single Yahoo API endpoint with exponential backoff.
 * @param {string} url - Yahoo API URL.
 * @returns {Object|null} Parsed JSON or null.
 */
function _fetchYahooAPI(url) {
  if (!_hasYahooAccess()) return null;

  const options = {
    headers: { 'Authorization': 'Bearer ' + _getYahooAccessToken() },
    muteHttpExceptions: true
  };

  let attempts = 0;
  const maxAttempts = 3;

  while (attempts < maxAttempts) {
    try {
      const response = UrlFetchApp.fetch(url, options);
      const code = response.getResponseCode();
      if (code === 200) return JSON.parse(response.getContentText());
      if (code < 500) {
        _logError('_helpers.gs', `HTTP ${code} for URL: ${url}`, 'HIGH');
        return null;
      }
    } catch (e) {
      if (attempts === maxAttempts - 1) _logError('_helpers.gs', `Fetch Exception: ${e.message}`, 'HIGH');
    }
    attempts++;
    Utilities.sleep(2000 * attempts);
  }
  return null;
}

/**
 * Fetches multiple Yahoo API endpoints in parallel using UrlFetchApp.fetchAll.
 * @param {string[]} urls - Array of URLs.
 * @returns {(Object|null)[]} Array of parsed JSON responses.
 */
function _fetchAllYahooAPI(urls) {
  if (!_hasYahooAccess() || !urls || urls.length === 0) return urls.map(() => null);

  const requests = urls.map(url => ({
    url: url,
    headers: { 'Authorization': 'Bearer ' + _getYahooAccessToken() },
    muteHttpExceptions: true
  }));

  let attempts = 0;
  const maxAttempts = 3;

  while (attempts < maxAttempts) {
    try {
      const responses = UrlFetchApp.fetchAll(requests);
      let has5xx = responses.some(r => r.getResponseCode() >= 500 && r.getResponseCode() < 600);
      
      if (!has5xx || attempts === maxAttempts - 1) {
        return responses.map((res, i) => {
          if (res.getResponseCode() !== 200) {
            _logError('_helpers.gs', `Batch HTTP ${res.getResponseCode()} for URL: ${urls[i]}`, 'HIGH');
            return null;
          }
          return JSON.parse(res.getContentText());
        });
      }
    } catch (e) {
      if (attempts === maxAttempts - 1) _logError('_helpers.gs', `Batch Fetch Exception: ${e.message}`, 'HIGH');
    }
    attempts++;
    Utilities.sleep(2000 * attempts);
  }
  return urls.map(() => null);
}

// ============================================================================
//  YAHOO PLAYER PARSER
// ============================================================================

/**
 * Normalizes Yahoo's nested player array into a flat, predictable object.
 * @param {Array} playerDataArray - Raw nested array.
 * @returns {Object} Flat player object.
 */
function _parseYahooPlayer(playerDataArray) {
  const p = { pKey: '', pId: '', name: '', team: '', positions: '', status: '', injuryNote: '', keeper: false };
  if (!playerDataArray || !Array.isArray(playerDataArray)) return p;

  playerDataArray.forEach(block => {
    if (!Array.isArray(block)) return;
    block.forEach(item => {
      if (!item) return;
      if (item.player_key) p.pKey = item.player_key;
      else if (item.player_id) p.pId = item.player_id.toString();
      else if (item.name) p.name = item.name.full || '';
      else if (item.editorial_team_abbr) p.team = item.editorial_team_abbr.toUpperCase();
      else if (item.status) p.status = item.status;
      else if (item.injury_note) p.injuryNote = item.injury_note;
      else if (item.is_keeper && item.is_keeper.status == 1) p.keeper = true;
      else if (item.eligible_positions) {
        p.positions = item.eligible_positions.map(pos => pos.position).filter(Boolean).join(', ');
      }
    });
  });
  return p;
}

/**
 * Parses raw Yahoo position string to strip IL/NA and return boolean flags.
 * @param {string} eligibilityString - e.g., 'C, 1B, IL'
 * @returns {Object} Clean positions and boolean flags.
 */
function _parsePositions(eligibilityString) {
  if (!eligibilityString) return { cleanPositions: '', isIL: false, isNA: false };
  const parts = eligibilityString.split(',').map(s => s.trim()).filter(Boolean);
  return {
    cleanPositions: parts.filter(p => p !== 'IL' && p !== 'NA').join(', '),
    isIL: parts.includes('IL'),
    isNA: parts.includes('NA')
  };
}

// ============================================================================
//  ERROR LOGGING & UTILITIES
// ============================================================================

/**
 * Writes an error to Row 4 of the 'Error Log' display sheet.
 * @param {string} scriptName - Name of the script generating the error.
 * @param {string} errorMessage - Description of the failure.
 * @param {string} severity - 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'.
 */
function _logError(scriptName, errorMessage, severity) {
  const ss = getPrimarySS();
  let sheet = ss.getSheetByName('Error Log');
  
  if (!sheet) {
    sheet = ss.insertSheet('Error Log');
    sheet.getRange('A3:D3').setValues([['DATE & TIME', 'SCRIPT NAME', 'ERROR MESSAGE', 'SEVERITY']]);
    sheet.getRange('A3:D3').setFontWeight('bold');
  }

  sheet.insertRowBefore(4);
  sheet.getRange('A4:D4').setValues([[new Date(), scriptName, errorMessage, severity]]);
}

/**
 * Stamps the current time in a specified Named Range.
 * @param {string} namedRange - e.g., 'UPDATE_HOURLY'
 */
function _updateTimestamp(namedRange) {
  const range = getPrimarySS().getRangeByName(namedRange);
  if (range) {
    range.setValue(new Date());
    SpreadsheetApp.flush();
  }
}

/**
 * Counts total allocated cells across all workbooks and logs them to named ranges.
 */
function _spreadsheetCounts() {
  const targets = [
    { workbook: getPrimarySS(), rangeName: 'COUNT_CELLS_PRIMARY' },
    { workbook: getDataSS(),    rangeName: 'COUNT_CELLS_DATA' },
    { workbook: getArchiveSS(), rangeName: 'COUNT_CELLS_ARCHIVE' }
  ];

  targets.forEach(t => {
    if (!t.workbook) return;
    const count = t.workbook.getSheets().reduce((sum, s) => sum + (s.getMaxRows() * s.getMaxColumns()), 0);
    const range = getPrimarySS().getRangeByName(t.rangeName);
    if (range) range.setValue(count);
  });
}