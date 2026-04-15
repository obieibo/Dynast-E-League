/**
 * FILE: testResolution.gs
 * PURPOSE: Manual test suite for the player ID resolution system.
 *          Run these functions from the Apps Script editor after
 *          refreshPlayerIdMap() completes to verify the full
 *          resolution chain is working correctly before any
 *          data fetch scripts are run.
 *
 *          This file is a permanent part of the project — not a
 *          throwaway scratch file. Add new test cases here whenever
 *          a new edge case is discovered or an override is added.
 *
 * HOW TO RUN:
 *   1. In Apps Script editor, select a function from the dropdown
 *   2. Click Run
 *   3. View results in Execution Log (View → Logs)
 *   Run testAll() to execute the entire suite at once.
 *   Run individual test functions to isolate specific scenarios.
 *
 * ADDING NEW TESTS:
 *   When you discover a player that resolves incorrectly in production,
 *   add a test case here before fixing it. This ensures the fix works
 *   and prevents regressions in future refreshes.
 *   Follow the pattern: _assertResolution(maps, platformId, mlbamId,
 *                                         playerName, expected, label)
 *
 * WHAT PASSING LOOKS LIKE IN THE LOG:
 *   PASS | FanGraphs ID lookup         | ohtansh01
 *   PASS | MLBAM co-primary lookup     | ohtansh01
 *   PASS | Yahoo ID lookup             | judgeaa01
 *   PASS | Override name (Batter)      | ohtansh01
 *   PASS | Override MLBAM (ATH Muncy)  | muncyma02
 *   PASS | Name fallback               | freemfr01
 *   PASS | Graceful unresolved         | (empty string)
 *   --- testResolution: 7/7 passed ---
 *
 * DEPENDENCIES: playerResolution.gs, helperFunctions.gs
 * CALLED BY:    Manual execution only — never by trigger groups
 */


// ============================================================
//  FULL TEST SUITE
// ============================================================

/**
 * Runs all resolution test functions in sequence.
 * Reports a final pass/fail summary to the execution log.
 * Flushes the ID Matching queue after all tests complete so
 * any name-fallback or unresolved players encountered during
 * testing are written to the ID Matching sheet — useful for
 * verifying the queue and write mechanism work correctly.
 */
function testAll() {
  Logger.log('=== testAll: starting full resolution test suite ===');

  let passed = 0;
  let failed = 0;

  const results = [
    testFanGraphsIdLookup(),
    testMlbamCoPrimaryLookup(),
    testYahooIdLookup(),
    testOverrideNameBatter(),
    testOverrideNamePitcher(),
    testOverrideMlbamAthMuncy(),
    testOverrideMlbamLadMuncy(),
    testNameFallback(),
    testGracefulUnresolved(),
    testNullInputs(),
    testActiveRostersLadMuncy(),
    testActiveRostersAthMuncy()
  ];

  results.forEach(r => r ? passed++ : failed++);

  Logger.log('=== testAll: ' + passed + '/' + (passed + failed) + ' passed ===');

  if (failed > 0) {
    Logger.log('ACTION REQUIRED: ' + failed + ' test(s) failed. Review logs above.');
  } else {
    Logger.log('All tests passed. Resolution system is ready.');
  }

  // Flush queue so name-fallback and unresolved players from
  // this test run are written to the ID Matching sheet
  flushIdMatchingQueue();
  Logger.log('testAll: ID Matching queue flushed.');

  // Update PASS/FAIL status for existing rows based on current override data
  updateIdMatchingStatuses();
  Logger.log('testAll: ID Matching statuses updated.');
}


// ============================================================
//  INDIVIDUAL TEST FUNCTIONS
//  Each returns true (pass) or false (fail).
//  All use _assertResolution() for consistent logging.
// ============================================================

/**
 * Test 1 — FanGraphs ID lookup via idMap.
 * Verifies the primary platform ID path works for FanGraphs.
 * Uses Shohei Ohtani's FG player ID (19755).
 * Expected resolution path: step 3 (platform ID map).
 */
function testFanGraphsIdLookup() {
  const maps = getPlayerMaps('IDFANGRAPHS');
  return _assertResolution(
    maps,
    '19755',        // FG player ID for Ohtani
    '660271',       // MLBAM ID
    'Shohei Ohtani',
    'ohtansh01',
    'FanGraphs ID lookup'
  );
}


/**
 * Test 2 — MLBAM ID as co-primary key.
 * Verifies that passing null for platformId still resolves
 * correctly via the MLBAM map — not name fallback.
 * Expected resolution path: step 4 (MLBAM co-primary map).
 */
function testMlbamCoPrimaryLookup() {
  const maps = getPlayerMaps('IDFANGRAPHS');
  return _assertResolution(
    maps,
    null,           // No platform ID provided
    '660271',       // MLBAM ID only
    'Shohei Ohtani',
    'ohtansh01',
    'MLBAM co-primary lookup'
  );
}


/**
 * Test 3 — Yahoo ID lookup.
 * Verifies the idMap path works for Yahoo IDs.
 * Uses Mookie Betts' Yahoo player ID.
 * Replace '8578' with Betts' actual Yahoo ID from your league
 * if this test fails — Yahoo IDs can vary by league/year.
 * Expected resolution path: step 3 (platform ID map).
 */
function testYahooIdLookup() {
  const maps = getPlayerMaps('YAHOOID');
  return _assertResolution(
    maps,
    '9552',          // Mookie Betts Yahoo ID — verify against your league
    '605141',        // Mookie Betts MLBAM ID
    'Mookie Betts',
    'bettsmo01',
    'Yahoo ID lookup'
  );
}


/**
 * Test 4 — Override name map, (Batter) suffix variant.
 * Verifies that 'Shohei Ohtani (Batter)' in ID Matching
 * resolves before any ID lookup is attempted.
 * Uses _normalizeOverrideName() which preserves the (Batter)
 * qualifier so the key 'shoheiohtanibatter' is distinct from
 * 'shoheiohtani' in the main nameMap.
 * Requires this entry in ID Matching:
 * RAW_NAME: 'Shohei Ohtani (Batter)' | IDPLAYER: 'ohtansh01'
 * Expected resolution path: step 1 (override name map).
 */
function testOverrideNameBatter() {
  const maps = getPlayerMaps('IDFANGRAPHS');
  return _assertResolution(
    maps,
    null,
    null,
    'Shohei Ohtani (Batter)',
    'ohtansh01',
    'Override name (Batter suffix)'
  );
}


/**
 * Test 5 — Override name map, (Pitcher) suffix variant.
 * Same player as test 4 but different FanGraphs name variant.
 * Uses _normalizeOverrideName() which preserves the (Batter)
 * qualifier so the key 'shoheiohtanibatter' is distinct from
 * 'shoheiohtani' in the main nameMap.
 * Requires this entry in ID Matching:
 *   RAW_NAME: 'Shohei Ohtani (Pitcher)' | IDPLAYER: 'ohtansh01'
 * Expected resolution path: step 1 (override name map).
 */
function testOverrideNamePitcher() {
  const maps = getPlayerMaps('IDFANGRAPHS');
  return _assertResolution(
    maps,
    null,
    null,
    'Shohei Ohtani (Pitcher)',
    'ohtansh01',
    'Override name (Pitcher suffix)'
  );
}


/**
 * Test 6 — Override MLBAM map, ATH Max Muncy.
 * Verifies that MLBAM ID 691777 resolves to the Athletics Max Muncy
 * and NOT to the Dodgers Max Muncy, confirming the override MLBAM
 * map correctly disambiguates same-name different-player cases.
 * Requires this entry in ID Matching:
 *   MLBID: '691777' | IDPLAYER: 'muncyma02' (ATH Muncy)
 * Expected resolution path: step 2 (override MLBAM map).
 */
function testOverrideMlbamAthMuncy() {
  const maps = getPlayerMaps('MLBID');
  return _assertResolution(
    maps,
    null,
    '691777',       // ATH Max Muncy MLBAM ID
    'Max Muncy',
    'muncyma02',
    'Override MLBAM (ATH Muncy)'
  );
}


/**
 * Test 7 — Override MLBAM map, LAD Max Muncy.
 * Companion to test 6 — confirms the LAD Max Muncy resolves
 * to his correct BBREF ID via the override MLBAM map.
 * Requires this entry in ID Matching:
 *   MLBID: '571970' | IDPLAYER: 'muncyma01' (LAD Muncy)
 * Expected resolution path: step 2 (override MLBAM map).
 */
function testOverrideMlbamLadMuncy() {
  const maps = getPlayerMaps('MLBID');
  return _assertResolution(
    maps,
    null,
    '571970',       // LAD Max Muncy MLBAM ID
    'Max Muncy',
    'muncyma01',
    'Override MLBAM (LAD Muncy)'
  );
}


/**
 * Test 8 — Name fallback as last resort.
 * Verifies that a player with no IDs provided still resolves
 * correctly via normalized name matching against _IDPLAYER_MAP.
 * Freddie Freeman is a safe choice — unique name, no disambiguation needed.
 * Note: User opted to test Ronald Acuña Jr. to verify that a player name
 * with special character still resolves correctly.
 * Expected resolution path: step 5 (name fallback).
 * A warning log line from resolveMasterId() is expected and correct here.
 */
function testNameFallback() {
  const maps = getPlayerMaps('IDFANGRAPHS');
  return _assertResolution(
    maps,
    null,
    null,
    'Ronald Acuña Jr.',
    'acunaro01',
    'Name fallback (no IDs provided)'
  );
}


/**
 * Test 9 — Graceful handling of an unresolvable player.
 * Verifies that a completely unknown player returns an empty string
 * rather than throwing an error. This is critical — a single bad
 * player record should never crash a script processing hundreds of rows.
 * Expected result: '' (empty string)
 */
function testGracefulUnresolved() {
  const maps = getPlayerMaps('IDFANGRAPHS');
  return _assertResolution(
    maps,
    'FAKE_FG_ID_999',
    'FAKE_MLBAM_999',
    'Fake Player Name',
    '',
    'Graceful unresolved (unknown player)'
  );
}


/**
 * Test 10 — All null inputs.
 * Verifies that passing null for all three lookup parameters
 * returns an empty string without throwing an error.
 * Guards against callers that may not always have player data
 * available (e.g. partially parsed API responses).
 * Expected result: '' (empty string)
 */
function testNullInputs() {
  const maps = getPlayerMaps('IDFANGRAPHS');
  return _assertResolution(
    maps,
    null,
    null,
    null,
    '',
    'All null inputs (no crash)'
  );
}


/**
 * Test 11 — Active Rosters name resolution, LAD Max Muncy.
 * Simulates the commissioner's sheet which returns qualified
 * name strings with no accompanying IDs.
 * 'Max Muncy (LAD) (B)' must resolve via overrideNameMap step 1.
 * Requires this entry in ID Matching:
 *   RAW_NAME: 'Max Muncy (LAD) (B)' | IDPLAYER: 'muncyma01'
 * Expected resolution path: step 1 (override name map).
 * Will return '' without the override row — that is the failure
 * this test is designed to catch.
 */
function testActiveRostersLadMuncy() {
  const maps = getPlayerMaps('IDFANGRAPHS');
  return _assertResolution(
    maps,
    null,
    null,
    'Max Muncy (LAD) (B)',
    'muncyma01',
    'Active Rosters name (LAD Muncy)'
  );
}


/**
 * Test 12 — Active Rosters name resolution, ATH Max Muncy.
 * Companion to test 11.
 * Requires this entry in ID Matching:
 *   RAW_NAME: 'Max Muncy (ATH) (B)' | IDPLAYER: 'muncyma02'
 * Expected resolution path: step 1 (override name map).
 */
function testActiveRostersAthMuncy() {
  const maps = getPlayerMaps('IDFANGRAPHS');
  return _assertResolution(
    maps,
    null,
    null,
    'Max Muncy (ATH) (B)',
    'muncyma02',
    'Active Rosters name (ATH Muncy)'
  );
}


// ============================================================
//  ASSERTION HELPER
// ============================================================

/**
 * Runs a single resolution assertion and logs the result.
 * Called by all individual test functions.
 * Returns true on pass, false on fail — used by testAll()
 * to compute the final pass/fail summary.
 *
 * @param  {Object}      maps       - Result of getPlayerMaps()
 * @param  {string|null} platformId - Platform-native ID to test
 * @param  {string|null} mlbamId    - MLBAM ID to test
 * @param  {string|null} playerName - Player name to test
 * @param  {string}      expected   - Expected IDPLAYER result
 * @param  {string}      label      - Human-readable test description for log
 * @returns {boolean} true if result matches expected, false otherwise
 */
function _assertResolution(maps, platformId, mlbamId, playerName, expected, label) {
  const result = resolveMasterId(maps, platformId, mlbamId, playerName);
  const pass   = result === expected;

  if (pass) {
    Logger.log('PASS | ' + label + ' | ' + (result || '(empty string)'));
  } else {
    Logger.log('FAIL | ' + label +
               ' | expected: ' + (expected || '(empty string)') +
               ' | got: '      + (result  || '(empty string)'));
  }

  return pass;
}


// ============================================================
//  STANDALONE FLUSH
// ============================================================

/**
 * Manually flushes the ID Matching queue. Run this after any
 * manual resolveMasterId() calls made outside of a trigger group
 * to ensure accumulated entries are written to the ID Matching sheet.
 * Also useful after debugging sessions where multiple resolution
 * calls were made without a trigger group flushing afterward.
 */
function flushMatchingQueueNow() {
  flushIdMatchingQueue();
  Logger.log('flushMatchingQueueNow: complete.');
}