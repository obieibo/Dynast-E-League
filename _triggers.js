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
 * On-open trigger entry point.
 * Runs common core Yahoo data on spreadsheet load.
 */
function triggerOnOpen() {
  if (!_isUpdateEnabled()) return;
  runCommonUpdates();
}

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
 * Runs heavy FanGraphs Projections, Prospects, and local sheet resolutions.
 */
function triggerDaily2() {
  if (!_isUpdateEnabled()) return;
  runOccasionalUpdates2();
  _updateTimestamp('UPDATE_DAILY_2');
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
  updatePlayerDashboards();
  
  // 5. Cleanup
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
 * Occasional updates Part 2: Projections, Prospects, and internal sheet resolutions.
 */
function runOccasionalUpdates2() {
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

/** Manually run Occasional updates Part 1 bypassing toggle. */
function runOccasionalUpdatesPart1Now() { runOccasionalUpdatesPart1(); }

/** Manually run Occasional updates Part 2 bypassing toggle. */
function runOccasionalUpdatesPart2Now() { runOccasionalUpdatesPart2(); }

/** Manually run Weekly updates bypassing toggle. */
function runWeeklyUpdatesNow() { runWeeklyUpdates(); }