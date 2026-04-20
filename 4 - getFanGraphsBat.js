/**
 * FILE: getFanGraphsBat.gs
 * PURPOSE: Fetches cumulative season batting statistics from the
 * FanGraphs leaderboard API across seven stat groups and
 * writes a merged wide table to _FG_B in the Data workbook.
 * Archives the prior year on first run of a new season.
 *
 * READS FROM: FanGraphs leaderboard API (7 parallel requests per year)
 * Archive workbook — to detect whether prior year exists
 * _IDPLAYER_MAP (Data WB) via getPlayerMaps()
 * WRITES TO:  _FG_B (Data WB) — merged batting stats, current year
 * Archive workbook — prior year snapshot on rollover
 * CALLED BY:  occasionalUpdates() in triggerGroups.gs
 * DEPENDENCIES: helperFunctions.gs, playerResolution.gs
 *
 * OUTPUT SCHEMA (_FG_B):
 * Col A   IDPLAYER    — Master BBREF ID (prepended)
 * Col B   IDFANGRAPHS — FanGraphs player ID
 * Col C   YEAR        — Season year
 * Col D+  [STAT COLS] — All stat columns from the seven stat groups,
 * merged by FanGraphs player ID. Duplicate
 * columns (PlayerName, Team, etc.) that appear
 * across multiple groups are deduplicated —
 * only the first occurrence is kept.
 *
 * STAT GROUPS FETCHED:
 * Dashboard    — Standard counting stats + rate stats (HR, RBI, AVG, etc.)
 * Advanced     — BB%, K%, OBP, SLG, wOBA, wRC+, Off, Def
 * Batted Ball  — GB%, FB%, LD%, IFFB%, HR/FB, Pull%, Cent%, Oppo%
 * Win Prob     — WPA, WPA/LI, RE24, REW
 * Plate Disc   — O-Swing%, Z-Swing%, Swing%, O-Contact%, SwStr%, CStr%
 * Statcast     — EV, LA, Barrel%, HardHit%, xBA, xSLG, xwOBA
 * Value        — WAR, RAR, Dollars
 *
 * ARCHIVE PATTERN:
 * On each run, the prior year is checked in the Archive workbook.
 * If the prior year data is missing, all seven stat groups are
 * fetched for the prior year, merged, and archived before the
 * current year data is written.
 *
 * MERGE STRATEGY:
 * Each of the seven API calls returns a JSON array of player rows.
 * Rows are keyed by FanGraphs player ID (playerid field) and merged
 * into a single wide row per player. Columns that appear in multiple
 * stat groups (e.g. PlayerName, Team, G) are deduplicated — the
 * first group's value is kept and subsequent duplicates are dropped.
 */


// ============================================================
//  CONSTANTS
// ============================================================

const FG_BAT_SHEET = '_FG_B';

// FanGraphs leaderboard API base — year is substituted at fetch time
const FG_BAT_BASE = 'https://www.fangraphs.com/api/leaders/major-league/data' +
                    '?pos=all&stats=bat&lg=all&qual=0' +
                    '&season={YEAR}&season1={YEAR}' +
                    '&startdate=&enddate=&month=0&hand=&team=0' +
                    '&pageitems=2000000&pagenum=1&ind=0&rost=0&players=';

// Seven stat group type parameters and their display labels
const FG_BAT_TYPES = [
  { type: '8',  label: 'Dashboard'   },
  { type: '1',  label: 'Advanced'    },
  { type: '2',  label: 'Batted Ball' },
  { type: '7',  label: 'Win Prob'    },
  { type: '5',  label: 'Plate Disc'  },
  { type: '24', label: 'Statcast'    },
  { type: '6',  label: 'Value'       }
];

// Columns shared across stat groups — kept from first group only
const FG_BAT_DEDUP_COLS = new Set([
  'playerid', 'PlayerName', 'Team', 'Age', 'G', 'AB', 'PA',
  'Season', 'AgeRng', 'Pos'
]);


// ============================================================
//  MAIN FUNCTION
// ============================================================

/**
 * Fetches all seven batting stat groups from FanGraphs for the
 * current year, merges them by player ID, resolves BBREF IDs,
 * and writes the result to _FG_B. Archives prior year if needed.
 */
function getFanGraphsBat() {
  const ss          = getPrimarySS();
  const currentYear = parseInt(ss.getRangeByName('CURRENT_YEAR')?.getValue(), 10);

  if (!currentYear) {
    Logger.log('getFanGraphsBat: CURRENT_YEAR not found. Aborting.');
    return;
  }

  const prevYear  = currentYear - 1;
  const maps      = getPlayerMaps('IDFANGRAPHS');
  const archiveSS = getArchiveSS();

  // Archive prior year if not already present
  if (archiveSS) {
    const archiveSheet = archiveSS.getSheetByName(FG_BAT_SHEET);
    if (!_fgSheetHasYear(archiveSheet, prevYear)) {
      Logger.log('getFanGraphsBat: archiving ' + prevYear + '...');
      const prevData = _fetchAndMergeFgBat(prevYear, maps);
      if (prevData && prevData.length > 1) {
        writeToArchive(FG_BAT_SHEET, prevData);
        Logger.log('getFanGraphsBat: archived ' + (prevData.length - 1) + ' batters for ' + prevYear);
      }
    }
  }

  // Fetch and write current year
  const currentData = _fetchAndMergeFgBat(currentYear, maps);
  if (!currentData || currentData.length <= 1) {
    Logger.log('getFanGraphsBat: no data returned for ' + currentYear + '. Aborting write.');
    return;
  }

  writeToData(FG_BAT_SHEET, currentData);
  Logger.log('getFanGraphsBat: wrote ' + (currentData.length - 1) + ' batters for ' + currentYear);
  updateTimestamp('UPDATE_FG_BAT');
  
  // NEW: Ensure any stragglers caught by the resolver are flushed to the ID Matching sheet
  flushIdMatchingQueue();
}


// ============================================================
//  FETCH AND MERGE
// ============================================================

/**
 * Fetches all seven batting stat groups for a given year in
 * parallel and merges them into a single wide table keyed by
 * FanGraphs player ID. Returns a 2D array ready to write.
 *
 * Merge behavior:
 * - Each stat group contributes its unique columns to the merged row
 * - Columns in FG_BAT_DEDUP_COLS are only kept from the first group
 * - Players present in some groups but not others receive empty
 * strings for the missing group's columns
 * - IDPLAYER is prepended as the first column using IDFANGRAPHS
 * resolution against _IDPLAYER_MAP
 *
 * @param  {number} year - Season year to fetch
 * @param  {Object} maps - Player resolution maps
 * @returns {Array[]|null} 2D array with headers, or null on failure
 */
function _fetchAndMergeFgBat(year, maps) {
  // Build all seven URLs for this year
  const urls = FG_BAT_TYPES.map(t =>
    FG_BAT_BASE.replace(/{YEAR}/g, year) + `&type=${t.type}&sortdir=default&sortstat=WAR`
  );

  const responses = fetchAllYahooAPI(urls);

  // Parse each response into an array of player row objects
  const groupData = [];
  let   anyData   = false;

  responses.forEach((resp, idx) => {
    if (!resp) {
      Logger.log('_fetchAndMergeFgBat: no response for ' + FG_BAT_TYPES[idx].label + ' (' + year + ')');
      groupData.push(null);
      return;
    }

    const rows = resp.data;
    if (!rows || !Array.isArray(rows) || rows.length === 0) {
      Logger.log('_fetchAndMergeFgBat: empty data for ' + FG_BAT_TYPES[idx].label + ' (' + year + ')');
      groupData.push(null);
      return;
    }

    anyData = true;
    groupData.push({ label: FG_BAT_TYPES[idx].label, rows });
  });

  if (!anyData) {
    Logger.log('_fetchAndMergeFgBat: all groups failed for ' + year + '.');
    return null;
  }

  // Determine merged column order
  // First group defines identity columns + its unique stats
  // Subsequent groups contribute only their unique stat columns
  const allColumns    = [];  // Final ordered column list
  const seenColumns   = new Set();
  const groupColumns  = [];  // Per-group: array of columns this group adds

  groupData.forEach((group, gIdx) => {
    if (!group) {
      groupColumns.push([]);
      return;
    }

    const sampleRow = group.rows[0];
    const keys      = Object.keys(sampleRow);
    const addedCols = [];

    keys.forEach(key => {
      if (gIdx === 0) {
        // First group: include everything
        if (!seenColumns.has(key)) {
          allColumns.push(key);
          seenColumns.add(key);
          addedCols.push(key);
        }
      } else {
        // Subsequent groups: skip dedup columns and already-seen columns
        if (!FG_BAT_DEDUP_COLS.has(key) && !seenColumns.has(key)) {
          allColumns.push(key);
          seenColumns.add(key);
          addedCols.push(key);
        }
      }
    });

    groupColumns.push(addedCols);
  });

  // Build player map: fgId → merged row object
  const playerMap = {};

  groupData.forEach((group, gIdx) => {
    if (!group) return;
    const cols = groupColumns[gIdx];

    group.rows.forEach(row => {
      const fgId = row.playerid ? row.playerid.toString() : '';
      if (!fgId) return;

      if (!playerMap[fgId]) {
        playerMap[fgId] = {};
      }

      cols.forEach(col => {
        if (!(col in playerMap[fgId])) {
          playerMap[fgId][col] = row[col] !== undefined ? row[col] : '';
        }
      });

      // Always capture PlayerName and IDFANGRAPHS for resolution
      // even from non-first groups as a fallback
      if (!playerMap[fgId]['playerid'])    playerMap[fgId]['playerid']    = fgId;
      if (!playerMap[fgId]['PlayerName'] && row['PlayerName']) {
        playerMap[fgId]['PlayerName'] = row['PlayerName'];
      }
    });
  });

  if (Object.keys(playerMap).length === 0) {
    Logger.log('_fetchAndMergeFgBat: player map empty after merge for ' + year + '.');
    return null;
  }

  // Build output — prepend IDPLAYER, IDFANGRAPHS, YEAR then all merged columns
  // Exclude 'playerid' from output columns since it becomes IDFANGRAPHS
  const outputCols    = allColumns.filter(c => c !== 'playerid');
  const outputHeaders = ['IDPLAYER', 'IDFANGRAPHS', 'YEAR', ...outputCols];
  const outputRows    = [outputHeaders];

  Object.entries(playerMap).forEach(([fgId, merged]) => {
    const playerName = merged['PlayerName'] ? merged['PlayerName'].toString() : '';
    
    // NEW: Extract the team abbreviation from FanGraphs to pass as the 6th parameter!
    const teamAbbr   = merged['Team'] ? merged['Team'].toString() : '';
    const masterId   = resolveMasterId(maps, fgId, null, playerName, 'getFanGraphsBat', teamAbbr);

    const dataRow = [masterId, fgId, year];
    outputCols.forEach(col => {
      const val = merged[col];
      dataRow.push(val !== undefined && val !== null ? val : '');
    });

    outputRows.push(dataRow);
  });

  return outputRows;
}


// ============================================================
//  ARCHIVE YEAR CHECK
// ============================================================

/**
 * Checks whether a FanGraphs sheet in the archive workbook
 * already contains data for the given year. Looks for a YEAR
 * column in the header row and checks the first data row.
 *
 * @param  {Sheet|null} sheet - Archive sheet, or null if not found
 * @param  {number}     year  - Year to check for
 * @returns {boolean} true if the sheet contains data for that year
 */
function _fgSheetHasYear(sheet, year) {
  if (!sheet || sheet.getLastRow() < 2) return false;

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const yearIdx = headers.indexOf('YEAR');
  if (yearIdx === -1) return false;

  const firstDataYear = parseInt(sheet.getRange(2, yearIdx + 1).getValue(), 10);
  return firstDataYear === year;
}