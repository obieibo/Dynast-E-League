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
  runCommonUpdates1();
  runCommonUpdates2();
}

/**
 * Hourly trigger entry point - PART 1
 * Handles the most critical transaction and roster resolution logic.
 */
function triggerHourly1() {
  if (!_isUpdateEnabled()) return;
  runCommonUpdates1();
  _updateTimestamp('UPDATE_HOURLY_1');
}

/**
 * Hourly trigger entry point - PART 2
 * Handles stats, standings, and visual dashboard compilation.
 * Schedule this to run ~15-30 minutes after Hourly Part 1.
 */
function triggerHourly2() {
  if (!_isUpdateEnabled()) return;
  runCommonUpdates2();
  _updateTimestamp('UPDATE_HOURLY_2');
}

/**
 * Daily trigger entry point - PART 1
 * Runs external data sources (Stats, Percentiles, Rankings).
 */
function triggerDaily1() {
  if (!_isUpdateEnabled()) return;
  runOccasionalUpdates1();
  _updateTimestamp('UPDATE_DAILY_1');
}

/**
 * Daily trigger entry point - PART 2
 * Runs heavy FanGraphs Projections to prevent execution timeouts.
 */
function triggerDaily2() {
  if (!_isUpdateEnabled()) return;
  runOccasionalUpdates2();
  _updateTimestamp('UPDATE_DAILY_2');
}

/**
 * Daily trigger entry point - PART 3
 * Runs Prospects.
 */
function triggerDaily3() {
  if (!_isUpdateEnabled()) return;
  runOccasionalUpdates3();
  _updateTimestamp('UPDATE_DAILY_3');
}

/**
 * Daily trigger entry point - PART 4
 * Internal sheet resolutions.
 */
function triggerDaily4() {
  if (!_isUpdateEnabled()) return;
  runOccasionalUpdates4();
  _updateTimestamp('UPDATE_DAILY_4');
}

/**
 * Daily trigger entry point - PART 5
 * Updates _MAP.
 */
function triggerDaily5() {
  if (!_isUpdateEnabled()) return;
  runOccasionalUpdates5();
  _updateTimestamp('UPDATE_DAILY_5');
}

/**
 * Weekly trigger entry point.
 * Runs heavy historical / mapping updates.
 */
function triggerWeekly() {
  if (!_isUpdateEnabled()) return;
  runWeeklyUpdates();
  _updateTimestamp('UPDATE_WEEKLY');
}

// ============================================================================
//  TRIGGER GROUPS (EXECUTION ORDER LOGIC)
// ============================================================================

/**
 * Common updates (Part 1): Foundation Data.
 * STRICT ORDER REQUIRED: Transactions and Drafts must resolve before Rosters.
 */
function runCommonUpdates1() {
  updateYahooTransactions(); 
  updateYahooDraft();        
  updateYahooRosters();      
  
  _spreadsheetCounts();      
  flushIdMatchingQueue();    
}

/**
 * Common updates (Part 2): Stats, Visuals, and Lookups.
 * Safe to run independently once Rosters are established.
 */
function runCommonUpdates2() {
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
 * Occasional updates Part 1: External statistical data and rankings.
 */
function runOccasionalUpdates1() {
  updateFantasyProsRankings();
  updateBaseballSavantData();
  updateFanGraphsBatting();
  updateFanGraphsPitching();
  
  _spreadsheetCounts();
  flushIdMatchingQueue();
}

/**
 * Occasional updates Part 2: FanGraphs Projections (High API Load).
 */
function runOccasionalUpdates2() {
  updateFanGraphsBattingProjections();
  updateFanGraphsPitchingProjections();
  
  _spreadsheetCounts();
  flushIdMatchingQueue();
}

/**
 * Occasional updates Part 3: FanGraphs prospect data.
 */
function runOccasionalUpdates3() {
  updateFanGraphsProspects();
  
  _spreadsheetCounts();
  flushIdMatchingQueue();
}

/**
 * Occasional updates Part 4: Internal sheet resolutions.
 */
function runOccasionalUpdates4() {
  executeAllSheetResolutions();
  
  _spreadsheetCounts();
  flushIdMatchingQueue();
}

/**
 * Occasional updates Part 5: Update _MAP.
 */
function runOccasionalUpdates5() {
  syncMapSheet();
  
  _spreadsheetCounts();
  flushIdMatchingQueue();
}

/**
 * Weekly updates: Heavy lookups and archives.
 */
function runWeeklyUpdates() {
  updateYahooPlayers(); 
  updateYahooLeagueInfo();
  updateHistoricalYahooRosters();
  _spreadsheetCounts();
  flushIdMatchingQueue();
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

/** Manually run Common updates 1 bypassing toggle. */
function forceCommonUpdates1() { 
  runCommonUpdates1(); 
  runCommonUpdates2(); 
}

/** Manually run Common updates 2 bypassing toggle. */
function forceCommonUpdates2() { 
  runCommonUpdates2(); 
}

/** Manually run Occasional updates 1 bypassing toggle. */
function forceOccasionalUpdates1() {
  runOccasionalUpdates1();
}

/** Manually run Occasional updates 2 bypassing toggle. */
function forceOccasionalUpdates2() {
  runOccasionalUpdates2();
}

/** Manually run Occasional updates 3 bypassing toggle. */
function forceOccasionalUpdates3() {
  runOccasionalUpdates3();
}

/** Manually run Occasional updates 4 bypassing toggle. */
function forceOccasionalUpdates4() {
  runOccasionalUpdates4();
}

/** Manually run Weekly updates bypassing toggle. */
function runWeeklyUpdatesNow() {
  runWeeklyUpdates();
}