/**
 * FILE: triggerGroups.gs
 * PURPOSE: Orchestrates all script execution. Defines trigger groups
 *          that run scripts in the correct dependency order, manages
 *          the Automatic vs Manual update toggle, and provides
 *          manual run functions for individual trigger groups.
 *
 * EXECUTION MODEL:
 *   Three automated cadences, each mapped to a time-based trigger:
 *
 *   triggerHourly()   → commonUpdates()     (set to every 1 hour)
 *   triggerOnOpen()   → commonUpdates()     (fires on spreadsheet open)
 *   triggerDaily()    → occasionalUpdates() (set to once daily, off-season)
 *   triggerWeekly()   → weeklyUpdates()     (set to once weekly)
 *
 *   Plus one rare/manual group for infrequent operations:
 *   rareUpdates()     → run manually as needed
 *
 * DEPENDENCY ORDER (critical — do not reorder without understanding):
 *   Within commonUpdates():
 *     updateTransactions() must run BEFORE updateRosters()
 *     updateDraft() must run BEFORE updateRosters()
 *     Reason: updateRosters() reads from _TRANSACTIONS and _DRAFT
 *             rather than fetching that data independently.
 *
 * TRIGGER SETUP (one-time, manual):
 *   In Apps Script editor → Triggers (clock icon) → Add Trigger:
 *   - triggerHourly:  time-driven, hour timer, every 1 hour
 *   - triggerOnOpen:  from spreadsheet, on open
 *   - triggerDaily:   time-driven, day timer, 6am-7am (or your preference)
 *   - triggerWeekly:  time-driven, week timer, Monday morning
 *   Do NOT add triggers for commonUpdates/occasionalUpdates/weeklyUpdates
 *   directly — always go through the trigger* wrapper functions so the
 *   SHEET_UPDATES toggle is respected.
 *
 * UPDATE TOGGLE:
 *   Named range SHEET_UPDATES in master Settings sheet.
 *   Value 'Automatic' → triggers execute normally.
 *   Any other value   → all triggers are skipped.
 *   Use 'Manual' during active tinkering or rebuilds to prevent
 *   partial writes while you are editing sheet structure.
 *   Toggle is checked by _isUpdateEnabled() before every trigger group.
 *
 * DEPENDENCIES: All script files — this is the top of the call stack.
 */


// ============================================================
//  AUTOMATED TRIGGER ENTRY POINTS
//  These are the only functions registered as Apps Script triggers.
//  All check the SHEET_UPDATES toggle before executing.
// ============================================================

/**
 * Hourly trigger entry point.
 * Runs commonUpdates() — all Yahoo league data that needs to
 * stay current throughout the day during the active season.
 * Set to: time-driven, hour timer, every 1 hour.
 */
function triggerHourly() {
  if (!_isUpdateEnabled()) return;
  commonUpdates();
  updateTimestamp('UPDATE_HOURLY');
}


/**
 * On-open trigger entry point.
 * Runs commonUpdates() so the sheet is current when you open it.
 * Set to: from spreadsheet, on open event.
 * Note: on-open triggers have a 30-second execution limit.
 * If commonUpdates() is timing out on open, comment out the
 * slower scripts (updateMatchups, updateTransactions) from
 * commonUpdates() and create a separate triggerOnOpen() group
 * with only the fastest calls (updateStandings, updateRosters).
 */
function triggerOnOpen() {
  if (!_isUpdateEnabled()) return;
  commonUpdates();
}


/**
 * Daily trigger entry point.
 * Runs occasionalUpdates() — external data sources that update
 * daily or less frequently (FanGraphs, Savant, FantasyPros, prospects).
 * Set to: time-driven, day timer, early morning.
 * During the off-season this can be reduced to weekly.
 */
function triggerDaily() {
  if (!_isUpdateEnabled()) return;
  occasionalUpdates();
  updateTimestamp('UPDATE_DAILY');
}


/**
 * Weekly trigger entry point.
 * Runs weeklyUpdates() — operations that only need to run once
 * per week (player ID map refresh, cell count audit).
 * Set to: time-driven, week timer, Monday morning.
 */
function triggerWeekly() {
  if (!_isUpdateEnabled()) return;
  weeklyUpdates();
  updateTimestamp('UPDATE_WEEKLY');
}


// ============================================================
//  TRIGGER GROUPS
//  Define what runs in each cadence and in what order.
//  Dependency order within commonUpdates() is critical —
//  see file header for explanation.
// ============================================================

/**
 * Common updates — runs every hour and on open.
 * All Yahoo league data: transactions, draft, rosters, standings,
 * matchups, team stats, IL, waivers, acquisition history.
 *
 * DEPENDENCY ORDER — do not reorder:
 *   1. updateTransactions() — must be first, updateRosters() reads its output
 *   2. updateDraft()        — must be second, updateRosters() reads its output
 *   3. updateRosters()      — depends on _TRANSACTIONS and _DRAFT
 *   4-9. remaining Yahoo scripts have no inter-dependencies
 *   10. saveAcquired()      — must be after updateRosters() (reads _ROSTERS)
 *   11. optimizeLineups()   — must be after all team/player updates are complete
 *   12. spreadsheetCounts() — always last, audits after all writes complete
 */
function commonUpdates() {
  updateTransactions();   // 1 — owns all transaction data
  updateDraft();          // 2 — owns all draft result data
  updateRosters();        // 3 — reads from _TRANSACTIONS + _DRAFT
  updateStandings();      // 4
  updateMatchups();       // 5
  updateTeamStats();      // 6 — feeds league stats dashboard + z-scores
  updateIL();             // 7
  updateWaivers();        // 8
  updateManagers();       // 9
  saveAcquired();         // 10 — must follow updateRosters()
  optimizeLineup();       // 11
  spreadsheetCounts();    // 12
  flushIdMatchingQueue(); // 13 — always last
}


/**
 * Occasional updates — runs once daily.
 * External data sources: FanGraphs stats and projections,
 * Baseball Savant percentiles, FantasyPros rankings,
 * FanGraphs prospects, Prospect Savant metrics.
 *
 * Order here is not dependency-driven — each script is independent.
 * Ordered by approximate execution time (faster scripts first)
 * so if the 6-minute limit is approached, slower scripts can be
 * moved to a separate trigger without disrupting faster ones.
 *
 * _handleYearRollover() is called inside getFanGraphsBatProj()
 * and getFanGraphsPitchProj() — not called here directly.
 */
function occasionalUpdates() {
  getFantasyPros();           // Fast — 3 parallel HTML fetches
  getBaseballSavantPctl();    // Moderate — 2 CSV fetches + archive check
  // getFanGraphsBat();          // Moderate — 7 parallel API calls + archive check
  // getFanGraphsPitch();        // Moderate — 7 parallel API calls + archive check
  // getFanGraphsBatProj();      // Slower  — 16 parallel API calls (8 models × 2 types)
  // getFanGraphsPitchProj();    // Slower  — 16 parallel API calls (8 models × 2 types)
  // getFanGraphsProspects();    // Slower  — 2 fetches + archive check
  // getProspectSavantData();    // Slower  — 8 parallel fetches (4 levels × 2 types)
  allSheetsResolution();
  spreadsheetCounts();
  flushIdMatchingQueue();     // Always last
}


/**
 * Weekly updates — runs once per week.
 * Operations that are too slow or unnecessary to run daily.
 * Player ID map refresh is the primary weekly task — it fetches
 * the full Smart Fantasy Baseball CSV and rebuilds _IDPLAYER_MAP.
 */
function weeklyUpdates() {
  refreshPlayerIdMap();       // Fetches SFBB CSV → rebuilds _IDPLAYER_MAP
  updatePlayers();
  updateLeagueInfo();         // League settings, stat categories, roster positions
  updateIdMatchingStatuses(); // review FAIL rows after fresh map
  spreadsheetCounts();
  flushIdMatchingQueue();
}


/**
 * Rare updates — run manually only.
 * Operations that should only happen on explicit intent:
 * not tied to any automated trigger.
 * Run from the Apps Script editor by selecting the function
 * and clicking Run, or via a manual button on the Settings sheet.
 */
function rareUpdates() {
  updateLeagueInfo();
  spreadsheetCounts();
}


// ============================================================
//  MANUAL RUN HELPERS
//  Convenience functions for running individual groups or scripts
//  from the Apps Script editor without touching trigger wiring.
//  These bypass the SHEET_UPDATES toggle intentionally —
//  if you run something manually you mean it.
// ============================================================

/**
 * Manually runs commonUpdates() regardless of SHEET_UPDATES toggle.
 * Use during setup, after tinkering, or to force a refresh.
 */
function runCommonUpdatesNow() {
  Logger.log('runCommonUpdatesNow: starting...');
  commonUpdates();
  Logger.log('runCommonUpdatesNow: complete.');
}


/**
 * Manually runs occasionalUpdates() regardless of SHEET_UPDATES toggle.
 * Use after initial setup to populate all external data sheets.
 * WARNING: this makes ~50 external API calls — expect 3-5 minutes runtime.
 */
function runOccasionalUpdatesNow() {
  Logger.log('runOccasionalUpdatesNow: starting...');
  occasionalUpdates();
  Logger.log('runOccasionalUpdatesNow: complete.');
}


/**
 * Manually runs weeklyUpdates() regardless of SHEET_UPDATES toggle.
 * Use when you want to force a player ID map refresh mid-week.
 */
function runWeeklyUpdatesNow() {
  Logger.log('runWeeklyUpdatesNow: starting...');
  weeklyUpdates();
  Logger.log('runWeeklyUpdatesNow: complete.');
}


// ============================================================
//  UPDATE TOGGLE CHECK
// ============================================================

/**
 * Checks whether automated updates are enabled.
 * Reads the SHEET_UPDATES named range from the master Settings sheet.
 * Returns true only if the value is exactly 'Automatic'.
 * All trigger entry points call this before executing.
 *
 * To pause all automated updates: set SHEET_UPDATES to 'Manual'
 * (or any value other than 'Automatic') in the Settings sheet.
 * Manual run functions (runCommonUpdatesNow, etc.) bypass this check.
 *
 * @returns {boolean} true if updates are enabled
 */
function _isUpdateEnabled() {
  const ss    = getMasterSS();
  const range = ss.getRangeByName('SHEET_UPDATES');

  if (!range) {
    Logger.log('_isUpdateEnabled: SHEET_UPDATES named range not found. Defaulting to disabled.');
    return false;
  }

  const val = range.getValue().toString().trim();
  if (val !== 'Automatic') {
    Logger.log('_isUpdateEnabled: updates paused (SHEET_UPDATES = "' + val + '").');
    return false;
  }

  return true;
}