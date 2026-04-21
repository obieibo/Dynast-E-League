/**
 * @file dataBaseballSavant.gs
 * @description Advanced fetcher for Baseball Savant data. Pulls multiple CSV endpoints 
 * (Percentiles, Statcast, Expected Stats, Bat Tracking, etc.) in parallel, merges them 
 * dynamically by MLB_ID, and generates a unified Master Table for Batters and Pitchers.
 * @dependencies _helpers.gs, resolvePlayer.gs
 * @writesTo _BS_B, _BS_P, and Archive workbook
 */

// ============================================================================
//  SAVANT CONSTANTS & CONFIGURATION
// ============================================================================
// Note: min=1 ensures we get the entire player universe, not just qualifiers.

const SAVANT_CONFIG = {
  batters: {
    sheetName: '_BS_B',
    urls: [
      'https://baseballsavant.mlb.com/leaderboard/percentile-rankings?type=batter&csv=true',
      'https://baseballsavant.mlb.com/leaderboard/expected_statistics?type=batter&min=1&csv=true',
      'https://baseballsavant.mlb.com/leaderboard/statcast?type=batter&min=1&csv=true',
      'https://baseballsavant.mlb.com/leaderboard/bat-tracking?min_swings=1&csv=true',
      'https://baseballsavant.mlb.com/leaderboard/sprint_speed?min_opps=1&csv=true',
      'https://baseballsavant.mlb.com/leaderboard/baserunning-run-value?csv=true',
      'https://baseballsavant.mlb.com/leaderboard/run_value?type=batter&min=1&csv=true',
      'https://baseballsavant.mlb.com/leaderboard/fielding-run-value?csv=true'
    ]
  },
  pitchers: {
    sheetName: '_BS_P',
    urls: [
      'https://baseballsavant.mlb.com/leaderboard/percentile-rankings?type=pitcher&csv=true',
      'https://baseballsavant.mlb.com/leaderboard/expected_statistics?type=pitcher&min=1&csv=true',
      'https://baseballsavant.mlb.com/leaderboard/statcast?type=pitcher&min=1&csv=true',
      'https://baseballsavant.mlb.com/leaderboard/pitch-arsenal-stats?min=1&csv=true',
      'https://baseballsavant.mlb.com/leaderboard/pitch-movement?min=1&csv=true',
      'https://baseballsavant.mlb.com/leaderboard/run_value?type=pitcher&min=1&csv=true'
    ]
  }
};

// ============================================================================
//  MAIN FETCH FUNCTION
// ============================================================================

function updateBaseballSavantData() {
  const ss = getPrimarySS();
  const currentYear = parseInt(ss.getRangeByName('CURRENT_YEAR')?.getValue(), 10);
  
  if (!currentYear) {
    _logError('dataBaseballSavant.gs', 'CURRENT_YEAR not found.', 'CRITICAL');
    return;
  }
  
  const prevYear = currentYear - 1;
  const maps = getPlayerMaps('MLBID'); 

  // Process Batters and Pitchers
  ['batters', 'pitchers'].forEach(groupKey => {
    const config = SAVANT_CONFIG[groupKey];
    const archiveSS = getArchiveSS();
    
    // 1. Check and Process Archive (Previous Year)
    if (archiveSS) {
      const archiveSheet = archiveSS.getSheetByName(config.sheetName);
      if (_readSavantYear(archiveSheet) !== prevYear) {
        const prevData = _fetchAndMergeSavantData(config.urls, prevYear, maps, config.sheetName);
        if (prevData && prevData.length > 1) writeToArchive(config.sheetName, prevData);
      }
    }

    // 2. Process Current Year
    const currentData = _fetchAndMergeSavantData(config.urls, currentYear, maps, config.sheetName);
    if (currentData && currentData.length > 1) {
      writeToData(config.sheetName, currentData);
    }
  });

  _updateTimestamp('UPDATE_BS'); // Make sure you have this named range in your sheet
}

// ============================================================================
//  FETCH & MERGE ENGINE
// ============================================================================

/**
 * Fetches multiple Savant CSVs in parallel and merges them into a single 2D array.
 * Keys all data to the player's MLB_ID and strips duplicate columns (like year, name).
 */
function _fetchAndMergeSavantData(baseUrls, year, maps, sheetName) {
  // Append the year parameter to all URLs
  const requests = baseUrls.map(url => ({
    url: `${url}&year=${year}`,
    muteHttpExceptions: true
  }));

  // Fetch all endpoints simultaneously for massive speed improvement
  const responses = UrlFetchApp.fetchAll(requests);
  
  const playerMap = {};
  const allHeaders = ['IDPLAYER', 'MLBID']; 
  const headerTracker = new Set(allHeaders);

  // Iterate through each CSV response
  responses.forEach((response, index) => {
    if (response.getResponseCode() !== 200) {
      // Don't kill the script if one endpoint fails (e.g. Bat Tracking in 2022)
      Logger.log(`Warning: Failed to fetch Savant endpoint for ${year}: ${requests[index].url}`);
      return; 
    }

    const csvData = Utilities.parseCsv(response.getContentText());
    if (!csvData || csvData.length <= 1) return;

    const rawHeaders = csvData[0].map(h => h.trim());
    
    // Find the primary identifying columns in this specific CSV
    const iPlayerId = rawHeaders.indexOf('player_id');
    const iPlayerName = rawHeaders.indexOf('player_name') > -1 ? rawHeaders.indexOf('player_name') : rawHeaders.indexOf('last_name, first_name');
    const iFirst = rawHeaders.indexOf('first_name');
    const iLast = rawHeaders.indexOf('last_name');

    if (iPlayerId === -1) return; // Cannot merge without an ID

    // Record new headers we haven't seen yet in previous CSVs
    const validColIndices = [];
    rawHeaders.forEach((header, idx) => {
      // Exclude redundant columns that appear in every CSV
      const isRedundant = ['player_id', 'player_name', 'last_name, first_name', 'first_name', 'last_name', 'year'].includes(header.toLowerCase());
      
      if (!isRedundant) {
        validColIndices.push(idx);
        if (!headerTracker.has(header)) {
          headerTracker.add(header);
          allHeaders.push(header);
        }
      }
    });

    // Populate the player map
    for (let i = 1; i < csvData.length; i++) {
      const row = csvData[i];
      const mlbId = row[iPlayerId];
      if (!mlbId) continue;

      // Initialize player in map if they don't exist yet
      if (!playerMap[mlbId]) {
        let fullName = '';
        if (iPlayerName !== -1) fullName = row[iPlayerName];
        else if (iFirst !== -1 && iLast !== -1) fullName = `${row[iFirst]} ${row[iLast]}`;
        
        // Resolve to your league's Master ID
        const primaryId = resolvePrimaryId(maps, mlbId, mlbId, null, fullName, `Savant_${sheetName}`, null);
        
        playerMap[mlbId] = {
          'IDPLAYER': primaryId,
          'MLBID': mlbId
        };
      }

      // Add the specific stats from this CSV into the player's object
      validColIndices.forEach(idx => {
        const headerName = rawHeaders[idx];
        playerMap[mlbId][headerName] = row[idx];
      });
    }
  });

  // If no players were found across any CSV, abort
  const playerIds = Object.keys(playerMap);
  if (playerIds.length === 0) return null;

  // Convert the Object Map back into a 2D Array for writing to Google Sheets
  const outputRows = [allHeaders];
  
  playerIds.forEach(mlbId => {
    const pData = playerMap[mlbId];
    const newRow = allHeaders.map(header => pData[header] !== undefined ? pData[header] : "");
    outputRows.push(newRow);
  });

  return outputRows;
}

/**
 * Reads the year from an existing Savant archive sheet to prevent unnecessary updates.
 */
function _readSavantYear(sheet) {
  if (!sheet || sheet.getLastRow() < 2) return 0;
  // Fallback checking multiple ways Savant might output the year column
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(h => h.toString().toLowerCase());
  const yearIdx = headers.indexOf('year');
  
  if (yearIdx === -1) return 0;
  return parseInt(sheet.getRange(2, yearIdx + 1).getValue(), 10) || 0;
}