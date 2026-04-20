/**
 * @file resolveTest.gs
 * @description Manual test suite for the player ID resolution system.
 * Run these functions from the editor to verify the 7-step path works.
 * @dependencies resolvePlayer.gs, _helpers.gs
 */

// ============================================================================
//  FULL TEST SUITE
// ============================================================================

/**
 * Runs all tests. Reports summary to log and flushes missing queue.
 */
function testAll() {
  Logger.log('=== testAll: starting full resolution test suite ===');
  let passed = 0, failed = 0;

  const results = [
    _testFanGraphsIdLookup(),
    _testMlbamSecondaryLookup(),
    _testYahooIdLookup(),
    _testOverrideName(),
    _testNameTeamComposite(),
    _testNameFallback(),
    _testGracefulUnresolved()
  ];

  results.forEach(r => r ? passed++ : failed++);
  Logger.log(`=== testAll: ${passed}/${passed + failed} passed ===`);

  if (failed > 0) Logger.log('ACTION REQUIRED: Failures detected.');
  flushIdMatchingQueue();
}

// ============================================================================
//  INDIVIDUAL TESTS
// ============================================================================

function _testFanGraphsIdLookup() {
  const maps = getPlayerMaps('IDFANGRAPHS');
  return _assertResolution(maps, '19755', '660271', '19755', 'Shohei Ohtani', 'LAD', 'ohtansh01', 'FG ID lookup');
}

function _testMlbamSecondaryLookup() {
  const maps = getPlayerMaps('IDFANGRAPHS');
  return _assertResolution(maps, null, '660271', null, 'Shohei Ohtani', 'LAD', 'ohtansh01', 'MLBAM secondary lookup');
}

function _testYahooIdLookup() {
  const maps = getPlayerMaps('YAHOOID');
  // Pass Betts' Yahoo ID as the platformId. (Substitute 9552 with current ID if it changes).
  return _assertResolution(maps, '9552', '605141', null, 'Mookie Betts', 'LAD', 'bettsmo01', 'Yahoo ID lookup');
}

function _testOverrideName() {
  const maps = getPlayerMaps('IDFANGRAPHS');
  // Relies on ID Matching sheet having "Shohei Ohtani (Batter)" -> ohtansh01
  return _assertResolution(maps, null, null, null, 'Shohei Ohtani (Batter)', null, 'ohtansh01', 'Override name');
}

function _testNameTeamComposite() {
  const maps = getPlayerMaps('IDFANGRAPHS');
  return _assertResolution(maps, null, null, null, 'Max Muncy', 'ATH', 'muncyma02', 'Name + Team Composite');
}

function _testNameFallback() {
  const maps = getPlayerMaps('IDFANGRAPHS');
  return _assertResolution(maps, null, null, null, 'Ronald Acuña Jr.', null, 'acunaro01', 'Name fallback (no IDs)');
}

function _testGracefulUnresolved() {
  const maps = getPlayerMaps('IDFANGRAPHS');
  return _assertResolution(maps, 'FAKE_ID', 'FAKE_MLB', null, 'Fake Player', 'FAK', '', 'Graceful unresolved');
}

// ============================================================================
//  ASSERTION HELPER
// ============================================================================

/**
 * Asserts the result and logs pass/fail.
 */
function _assertResolution(maps, platformId, mlbId, fgId, playerName, team, expected, label) {
  const result = resolvePrimaryId(maps, platformId, mlbId, fgId, playerName, 'Test', team);
  const pass = result === expected;

  if (pass) {
    Logger.log(`PASS | ${label} | ${result || '(empty string)'}`);
  } else {
    Logger.log(`FAIL | ${label} | expected: ${expected || '(empty string)'} | got: ${result || '(empty string)'}`);
  }
  return pass;
}