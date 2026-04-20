/**
 * @file _triggers.gs
 * @description Orchestrates all script execution. Defines time-based trigger groups,
 * manages the update toggle, and establishes the strict dependency execution order.
 * @dependencies All script files.
 */

// ============================================================================
//  AUTOMATED TRIGGER ENTRY POINTS
// ============================================================================

/**
 * Hourly trigger entry point.
 * Runs common core Yahoo data.
 */
function triggerHourly() {
  if (!_isUpdateEnabled()) return;
  runCommonUpdates();
  _updateTimestamp('UPDATE_HOURLY');
}

/**
 * On-open trigger entry point.
 * Runs common core Yahoo data on spreadsheet load.
 */
function triggerOnOpen() {
  if (!_isUpdateEnabled()) return;
  runCommonUpdates();
}

/**
 * Daily trigger entry point.
 * Runs external data sources (FanGraphs, Savant, FantasyPros).
 */
function triggerDaily() {
  if (!_isUpdateEnabled()) return;
  runOccasionalUpdates();
  _updateTimestamp('UPDATE_DAILY');
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
 * Common updates: Fast, high-priority Yahoo data.
 * STRICT ORDER REQUIRED: Transactions and Drafts must resolve before Rosters.
 */
function runCommonUpdates() {
  // 1. Foundation Data (Must run first)
  updateYahooTransactions(); 
  updateYahooDraft();        
  
  // 2. Rosters (Depends on Transactions & Draft)
  updateYahooRosters();      
  
  // 3. Standalone Yahoo Stats
  updateYahooStandings();    
  updateYahooMatchups();     
  updateYahooTeamStats();    
  updateYahooManagers();     
  
  // 4. Utilities (Depends on Rosters)
  saveAcquiredData();        
  optimizeActiveLineups();   
  
  // 5. Cleanup
  _spreadsheetCounts();      
  flushIdMatchingQueue();    
}

/**
 * Occasional updates: External statistical data. Order independent.
 */
function runOccasionalUpdates() {
  updateFantasyProsRankings();
  updateBaseballSavantPercentiles();
  updateFanGraphsBatting();
  updateFanGraphsPitching();
  updateFanGraphsBattingProjections();
  updateFanGraphsPitchingProjections();
  updateFanGraphsProspects();
  
  executeAllSheetResolutions();
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

/** Manually run Common updates bypassing toggle. */
function runCommonUpdatesNow() { runCommonUpdates(); }

/** Manually run Occasional updates bypassing toggle. */
function runOccasionalUpdatesNow() { runOccasionalUpdates(); }

/** Manually run Weekly updates bypassing toggle. */
function runWeeklyUpdatesNow() { runWeeklyUpdates(); }