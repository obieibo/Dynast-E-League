/**
 * @file dataBaseballSavant.gs
 * @description Advanced fetcher for Baseball Savant data. Pulls both percentile data 
 * (for UI/dashboards) and Raw xStats (for projection regression modeling).
 * Keys all data by MLB_ID.
 * @dependencies _helpers.gs, resolvePlayer.gs
 * @writesTo _BS_B, _BS_P, _BS_RAW_B, _BS_RAW_P
 */

// ============================================================================
//  SAVANT CONSTANTS & CONFIGURATION
// ============================================================================

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
      'https://baseballsavant.mlb.com/leaderboard/run_value?type=batter&min=1&csv=true'
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
  },
  rawBatters: {
    sheetName: '_BS_RAW_B',
    urls: [
      // Custom endpoint pulling exact metrics needed for mathematical regression
      'https://baseballsavant.mlb.com/leaderboard/custom?year={year}&type=batter&filter=&sort=4&sortDir=desc&min=1&selections=xba,xslg,xwoba,xobp,barrel_batted_rate,hard_hit_percent,sweet_spot_percent,sprint_speed,exit_velocity_avg&csv=true'
    ]
  },
  rawPitchers: {
    sheetName: '_BS_RAW_P',
    urls: [
      // Custom endpoint pulling exact metrics needed for mathematical regression
      'https://baseballsavant.mlb.com/leaderboard/custom?year={year}&type=pitcher&filter=&sort=4&sortDir=desc&min=1&selections=xba,xera,xwoba,whiff_percent,csw_rate,k_percent,bb_percent,barrel_batted_rate,n_fastball_formatted&csv=true'
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

  // Process all groups: Percentiles (Batters/Pitchers) & Raw (Batters/Pitchers)
  ['batters', 'pitchers', 'rawBatters', 'rawPitchers'].forEach(groupKey => {
    const config = SAVANT_CONFIG[groupKey];
    const archiveSS = getArchiveSS();
    
    // 1. Check and Process Archive (Previous Year) ONLY if season is complete
    // Archiving is restricted to percentile sheets to save space, unless requested otherwise
    if (archiveSS && !groupKey.includes('raw')) {
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

  _updateTimestamp('UPDATE_BS'); 
}

// ============================================================================
//  FETCH & MERGE ENGINE
// ============================================================================

function _fetchAndMergeSavantData(baseUrls, year, maps, sheetName) {
  // Inject the year parameter where {year} is present, otherwise append it
  const requests = baseUrls.map(url => ({
    url: url.includes('{year}') ? url.replace('{year}', year) : `${url}&year=${year}`,
    muteHttpExceptions: true
  }));

  const responses = UrlFetchApp.fetchAll(requests);
  
  const playerMap = {};
  const allHeaders = ['IDPLAYER', 'MLBID']; 
  const headerTracker = new Set(allHeaders);

  responses.forEach((response, index) => {
    if (response.getResponseCode() !== 200) {
      Logger.log(`Warning: Failed to fetch Savant endpoint for ${year}: ${requests[index].url}`);
      return; 
    }

    const csvData = Utilities.parseCsv(response.getContentText());
    if (!csvData || csvData.length <= 1) return;

    const rawHeaders = csvData[0].map(h => h.trim());
    
    // Find identifying columns
    const iPlayerId = rawHeaders.indexOf('player_id');
    const iPlayerName = rawHeaders.indexOf('player_name') > -1 ? rawHeaders.indexOf('player_name') : rawHeaders.indexOf('last_name, first_name');
    const iFirst = rawHeaders.indexOf('first_name');
    const iLast = rawHeaders.indexOf('last_name');

    if (iPlayerId === -1) return; 

    // Record unique headers
    const validColIndices = [];
    rawHeaders.forEach((header, idx) => {
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

      if (!playerMap[mlbId]) {
        let fullName = '';
        if (iPlayerName !== -1) fullName = row[iPlayerName];
        else if (iFirst !== -1 && iLast !== -1) fullName = `${row[iFirst]} ${row[iLast]}`;
        
        // Resolve ID based on MLBID mapping
        const primaryId = resolvePrimaryId(maps, mlbId, mlbId, null, fullName, `Savant_${sheetName}`, null);
        
        playerMap[mlbId] = { 'IDPLAYER': primaryId, 'MLBID': mlbId };
      }

      validColIndices.forEach(idx => {
        const headerName = rawHeaders[idx];
        playerMap[mlbId][headerName] = row[idx];
      });
    }
  });

  const playerIds = Object.keys(playerMap);
  if (playerIds.length === 0) return null;

  const outputRows = [allHeaders];
  
  playerIds.forEach(mlbId => {
    const pData = playerMap[mlbId];
    const newRow = allHeaders.map(header => pData[header] !== undefined ? pData[header] : "");
    outputRows.push(newRow);
  });

  return outputRows;
}

function _readSavantYear(sheet) {
  if (!sheet || sheet.getLastRow() < 2) return 0;
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(h => h.toString().toLowerCase());
  const yearIdx = headers.indexOf('year');
  
  if (yearIdx === -1) return 0;
  return parseInt(sheet.getRange(2, yearIdx + 1).getValue(), 10) || 0;
}