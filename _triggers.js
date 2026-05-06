/**
 * @file _triggers.gs
 * @description Orchestrates all script execution. Defines time-based trigger groups,
 * manages the update toggle, and establishes the strict dependency execution order.
 * * NOTE: Heavy functions have been split into Part 1 and Part 2 to prevent Google 
 * Apps Script 6-minute maximum execution timeouts.
 * @dependencies All script files.
 */

// ============================================================================
//  AUTOMATED TRIGGER ENTRY POINTS
// ============================================================================

/**
 * On-open trigger entry point.
 * Runs common core Yahoo data on spreadsheet load.
 */
function triggerManual() {
  if (!_isUpdateEnabled()) return;
  updateYahooTransactions(); 
  updateYahooDraft();        
  updateYahooRosters();      
  
  updateYahooStandings();    
  updateYahooMatchups();     
  updateYahooTeamStats();    
  updateYahooManagers();     
  
  saveAcquiredData();
  updatePlayerDashboards();

  _spreadsheetCounts();      
  flushIdMatchingQueue(); 
}

/**
 * Hourly trigger entry point - PART 1
 * Handles the most critical transaction and roster resolution logic.
 */
function triggerHourly1() {
  if (!_isUpdateEnabled()) return;
  updateYahooTransactions(); 
  updateYahooDraft();        
  updateYahooRosters();      
  
  _spreadsheetCounts();      
  flushIdMatchingQueue(); 

  _updateTimestamp('UPDATE_HOURLY_1');
}

/**
 * Hourly trigger entry point - PART 2
 * Handles stats, standings, and visual dashboard compilation.
 * Schedule this to run ~15-30 minutes after Hourly Part 1.
 */
function triggerHourly2() {
  if (!_isUpdateEnabled()) return;
  updateYahooStandings();    
  updateYahooMatchups();     
  updateYahooTeamStats();    
  updateYahooManagers();     
  
  saveAcquiredData();
  updatePlayerDashboards();
  
  _spreadsheetCounts();      
  flushIdMatchingQueue();
  _updateTimestamp('UPDATE_HOURLY_2');
}

/**
 * Daily trigger entry point - PART 1
 * Runs external data sources (Stats, Percentiles, Rankings).
 */
function triggerDaily1() {
  if (!_isUpdateEnabled()) return;
  updateFantasyProsRankings();
  updateBaseballSavantData();
  updateFanGraphsBatting();
  updateFanGraphsPitching();
  
  _spreadsheetCounts();
  flushIdMatchingQueue();

  _updateTimestamp('UPDATE_DAILY_1');
}

/**
 * Daily trigger entry point - PART 2
 * Runs heavy FanGraphs Projections to prevent execution timeouts.
 */
function triggerDaily2() {
  if (!_isUpdateEnabled()) return;
  updateFanGraphsBattingProjections();
  _updateTimestamp('UPDATE_DAILY_2');
}

/**
 * Daily trigger entry point - PART 3
 * Runs heavy FanGraphs Projections to prevent execution timeouts.
 */
function triggerDaily3() {
  if (!_isUpdateEnabled()) return;
  updateFanGraphsPitchingProjections();
  _updateTimestamp('UPDATE_DAILY_3');
}

/**
 * Daily trigger entry point - PART 4
 * Runs Prospects.
 */
function triggerDaily4() {
  if (!_isUpdateEnabled()) return;
  updateFanGraphsProspects();
  
  _spreadsheetCounts();
  flushIdMatchingQueue();

  _updateTimestamp('UPDATE_DAILY_4');
}

/**
 * Daily trigger entry point - PART 5
 * Internal sheet resolutions.
 */
function triggerDaily5() {
  if (!_isUpdateEnabled()) return;
  executeAllSheetResolutions();
  
  _spreadsheetCounts();
  flushIdMatchingQueue();

  _updateTimestamp('UPDATE_DAILY_5');
}

/**
 * Daily trigger entry point - PART 6
 * Updates _MAP.
 */
function triggerDaily6() {
  if (!_isUpdateEnabled()) return;
  syncMapSheet();
  
  _spreadsheetCounts();
  flushIdMatchingQueue();

  _updateTimestamp('UPDATE_DAILY_6');
}

/**
 * Weekly trigger entry point.
 * Runs heavy historical updates.
 */
function triggerWeekly() {
  if (!_isUpdateEnabled()) return;
  updateYahooPlayers(); 
  updateYahooLeagueInfo();
  updateHistoricalYahooRosters();

  _spreadsheetCounts();
  flushIdMatchingQueue();

  _updateTimestamp('UPDATE_WEEKLY');
}

// ============================================================================
//  TRIGGER TOGGLE & MANUAL HELPERS
// ============================================================================

/**
 * Checks whether automated updates are enabled via the SHEET_UPDATES Named Range.
 * @returns {boolean} True if exactly 'Automatic'.
 */
function _isUpdateEnabled() {
  const range = getPrimarySS().getRangeByName('SHEET_UPDATES');
  if (!range) {
    _logError('_triggers.gs', 'SHEET_UPDATES missing. Defaulting to paused.', 'HIGH');
    return false;
  }
  const val = range.getValue().toString().trim();
  if (val !== 'Automatic') {
    Logger.log(`Updates paused (SHEET_UPDATES = "${val}").`);
    return false;
  }
  return true;
}

/** Manually run Hourly updates 1 bypassing toggle. */
function forceHourlyUpdates1() { 
  triggerHourly1(); 
}

/** Manually run Hourly updates 2 bypassing toggle. */
function forceHourlyUpdates2() { 
  triggerHourly2(); 
}

/** Manually run Daily updates 1 bypassing toggle. */
function forceDailyUpdates1() {
  triggerDaily1();
}

/** Manually run Daily updates 2 bypassing toggle. */
function forceDailyUpdates2() {
  triggerDaily2();
}

/** Manually run Daily updates 3 bypassing toggle. */
function forceDailyUpdates3() {
  triggerDaily3();
}

/** Manually run Daily updates 4 bypassing toggle. */
function forceDailyUpdates4() {
  triggerDaily4();
}

/** Manually run Daily updates 5 bypassing toggle. */
function forceDailyUpdates5() {
  triggerDaily5();
}

/** Manually run Daily updates 6 bypassing toggle. */
function forceDailyUpdates6() {
  triggerDaily6();
}

/** Manually run Weekly updates bypassing toggle. */
function forceWeeklyUpdates() {
  triggerWeekly();
}