/**
 * @file dataBaseballSavant.gs
 * @description Fetches Baseball Savant percentile rankings from MLB's CSV endpoint.
 * Maintains current year data and archives the prior year on rollover.
 * @dependencies _helpers.gs, resolvePlayer.gs
 * @writesTo _BS_B, _BS_P, and Archive workbook
 */

// ============================================================================
//  SAVANT CONSTANTS
// ============================================================================

const SAVANT_ENDPOINTS = [
  { sheetName: '_BS_B', url: 'https://baseballsavant.mlb.com/leaderboard/percentile-rankings?type=batter&team=&csv=true' },
  { sheetName: '_BS_P', url: 'https://baseballsavant.mlb.com/leaderboard/percentile-rankings?type=pitcher&team=&csv=true' }
];

// ============================================================================
//  MAIN FETCH FUNCTION
// ============================================================================

function updateBaseballSavantPercentiles() {
  const ss = getPrimarySS();
  const currentYear = parseInt(ss.getRangeByName('CURRENT_YEAR')?.getValue(), 10);
  if (!currentYear) {
    _logError('dataBaseballSavant.gs', 'CURRENT_YEAR not found.', 'CRITICAL');
    return;
  }
  const prevYear = currentYear - 1;
  const maps = getPlayerMaps('MLBID'); 

  SAVANT_ENDPOINTS.forEach(endpoint => {
    const archiveSS = getArchiveSS();
    if (archiveSS) {
      const archiveSheet = archiveSS.getSheetByName(endpoint.sheetName);
      if (_readSavantYear(archiveSheet) !== prevYear) {
        const prevData = _fetchSavantData(endpoint.url, prevYear, maps);
        if (prevData && prevData.length > 1) writeToArchive(endpoint.sheetName, prevData);
      }
    }

    const currentData = _fetchSavantData(endpoint.url, currentYear, maps);
    if (currentData && currentData.length > 1) {
      writeToData(endpoint.sheetName, currentData);
    }
  });

  _updateTimestamp('UPDATE_BS');
}

// ============================================================================
//  FETCH & PARSE HELPERS
// ============================================================================

function _fetchSavantData(baseUrl, year, maps) {
  const url = `${baseUrl}&year=${year}`;
  const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });

  if (response.getResponseCode() !== 200) {
    _logError('dataBaseballSavant.gs', `HTTP ${response.getResponseCode()} for year ${year}`, 'HIGH');
    return null;
  }

  const csvData = Utilities.parseCsv(response.getContentText());
  if (!csvData || csvData.length <= 1) return null;

  const rawHeaders = csvData[0];
  const iPlayerId = rawHeaders.indexOf('player_id');
  const iPlayerName = rawHeaders.indexOf('player_name');
  const iFirst = rawHeaders.indexOf('first_name');
  const iLast = rawHeaders.indexOf('last_name');

  const outputHeaders = ['IDPLAYER', 'MLBID'];
  rawHeaders.forEach((h, idx) => { if (idx !== iPlayerId) outputHeaders.push(h); });
  
  const outputRows = [outputHeaders];

  for (let i = 1; i < csvData.length; i++) {
    const row = csvData[i];
    const mlbId = iPlayerId !== -1 ? row[iPlayerId] : null;
    
    let fullName = '';
    if (iPlayerName !== -1) fullName = row[iPlayerName];
    else if (iFirst !== -1 && iLast !== -1) fullName = `${row[iFirst]} ${row[iLast]}`;

    // FIX: Pass mlbId as platformId
    const primaryId = resolvePrimaryId(maps, mlbId, mlbId, null, fullName, 'updateBaseballSavantPercentiles', null);

    const newRow = [primaryId, mlbId];
    row.forEach((val, idx) => { if (idx !== iPlayerId) newRow.push(val); });
    outputRows.push(newRow);
  }

  return outputRows;
}

function _readSavantYear(sheet) {
  if (!sheet || sheet.getLastRow() < 2) return 0;
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const yearIdx = headers.indexOf('year');
  if (yearIdx === -1) return 0;
  return parseInt(sheet.getRange(2, yearIdx + 1).getValue(), 10) || 0;
}