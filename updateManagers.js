/**
 * FILE: updateManagers.gs
 * PURPOSE: Fetches fantasy team and manager information from the Yahoo
 *          Fantasy Sports API and maintains the Managers historical
 *          display sheet in the master workbook.
 *
 *          On first run (Managers sheet has no data): fetches all
 *          historical years using league keys from the LEAGUE_KEYS_HISTORY
 *          named range in Settings, then adds the current year.
 *
 *          On subsequent runs: only processes the current year —
 *          updates team names and logos if changed, adds new manager
 *          rows if ownership changed mid-season. Historical years are
 *          never modified after initial write.
 *
 * READS FROM: Yahoo Fantasy Sports API (teams endpoint, per-year)
 *             Named ranges: CURRENT_YEAR, LEAGUE_KEY, LEAGUE_KEYS_HISTORY
 * WRITES TO:  Managers (Master WB)
 * CALLED BY:  commonUpdates() in triggerGroups.gs
 * DEPENDENCIES: helperFunctions.gs, yahooAuthentication.gs
 *
 * SETUP REQUIRED (one-time):
 *   In Settings, create a three-column table — Year in col 1, League Key in col 3.
 *   Point LEAGUE_KEYS_HISTORY at that table. Do not include the current year.
 *   The current year key lives in LEAGUE_KEY only.
 *
 * OUTPUT SCHEMA (Managers display sheet):
 *   Row 1  — 'Managers' title
 *   Row 2  — Blank
 *   Row 3  — Column headers
 *   Row 4+ — Data rows, one per team per year
 *
 *   Col A — Year
 *   Col B — Logo        — CellImage built from Yahoo team logo URL
 *   Col C — Team        — Fantasy team display name
 *   Col D — Manager     — Manager full name (manually entered)
 *   Col E — Short Name  — Auto-generated short name
 *   Col F — Team ID     — Yahoo team ID
 *   Col G — Manager ID  — Yahoo manager ID
 *   Col H — Logo URL    — Yahoo team logo URL (source for col B)
 *
 * MANAGER FULL NAME:
 *   Yahoo does not reliably return real names. Col D is intended for
 *   real names and should be filled in manually. The script carries
 *   a manager's name forward from the most recent prior year when a
 *   new year is written, and leaves the column blank for managers
 *   with no prior history.
 *
 * SHORT NAME GENERATION:
 *   Generated automatically across all years for consistency.
 *   Rules in order: first name only if unique, first + last initial,
 *   first + two-char last as final fallback. Regenerated on every run.
 *   Run regenerateShortNames() manually after updating names.
 *
 * SORT ORDER:
 *   Year DESC → Team ID ASC → Manager ID ASC
 */


// ============================================================
//  CONSTANTS
// ============================================================

const MANAGERS_SHEET          = 'Managers';
const MANAGERS_DATA_START_ROW = 4;
const MANAGERS_HEADER_ROW     = 3;
const MANAGERS_NUM_COLS       = 8;

const MGR_COL_YEAR       = 0;  // A — Year
const MGR_COL_LOGO       = 1;  // B — CellImage logo
const MGR_COL_TEAM       = 2;  // C — Team name
const MGR_COL_MANAGER    = 3;  // D — Manager full name (manual entry)
const MGR_COL_SHORT_NAME = 4;  // E — Short name (auto-generated)
const MGR_COL_TEAM_ID    = 5;  // F — Yahoo team ID
const MGR_COL_MANAGER_ID = 6;  // G — Yahoo manager ID
const MGR_COL_LOGO_URL   = 7;  // H — Logo URL (source for col B)

const MANAGERS_HEADERS = [
  'YEAR', 'LOGO', 'TEAM', 'MANAGER',
  'SHORT NAME', 'TEAM ID', 'MANAGER ID', 'LOGO URL'
];


// ============================================================
//  MAIN FUNCTION
// ============================================================

/**
 * Detects whether this is a first run (empty Managers sheet) and
 * routes to the appropriate fetch path. After building all rows,
 * regenerates short names across all years, sorts by Year DESC →
 * Team ID ASC → Manager ID ASC, then writes to the sheet.
 */
function updateManagers() {
  const ss          = getMasterSS();
  const leagueKey   = getLeagueKey();
  const currentYear = ss.getRangeByName('CURRENT_YEAR')?.getValue();

  if (!leagueKey || !currentYear) {
    Logger.log('updateManagers: missing LEAGUE_KEY or CURRENT_YEAR. Aborting.');
    return;
  }

  const sheet      = _getManagersSheet(ss);
  const isFirstRun = sheet.getLastRow() < MANAGERS_DATA_START_ROW;

  Logger.log('updateManagers: ' + (isFirstRun ? 'first run.' : 'incremental update.'));

  let allRows = isFirstRun
    ? _fetchAllHistoricalManagers(ss, leagueKey, currentYear)
    : _updateCurrentYearManagers(sheet, leagueKey, currentYear);

  if (allRows.length === 0) {
    Logger.log('updateManagers: no data returned. Aborting.');
    return;
  }

  allRows = _applyShortNames(allRows);

  allRows.sort((a, b) => {
    if (b[MGR_COL_YEAR] !== a[MGR_COL_YEAR]) return b[MGR_COL_YEAR] - a[MGR_COL_YEAR];
    const tDiff = (parseInt(a[MGR_COL_TEAM_ID]) || 0) - (parseInt(b[MGR_COL_TEAM_ID]) || 0);
    if (tDiff !== 0) return tDiff;
    return (parseInt(a[MGR_COL_MANAGER_ID]) || 0) - (parseInt(b[MGR_COL_MANAGER_ID]) || 0);
  });

  _writeManagersSheet(sheet, allRows);
  updateTimestamp('UPDATE_MANAGERS');
  Logger.log('updateManagers: wrote ' + allRows.length + ' rows.');
}


// ============================================================
//  FIRST RUN — ALL HISTORICAL YEARS
// ============================================================

/**
 * Fetches manager and team data for all historical years plus the
 * current year. Used only on first run when the Managers sheet is
 * empty. Historical years are fetched oldest-first so manager name
 * history propagates forward correctly when the current year is
 * added last. The current year is filtered out of the historical key
 * map and fetched separately to prevent duplicate rows.
 *
 * @param  {Spreadsheet} ss          - Master spreadsheet
 * @param  {string}      leagueKey   - Current year league key
 * @param  {number}      currentYear - Current season year
 * @returns {Array[]} All data rows across all years (no headers)
 */
function _fetchAllHistoricalManagers(ss, leagueKey, currentYear) {
  const historicalKeys  = _readLeagueKeyHistory(ss);
  const allRows         = [];

  const historicalYears = Object.keys(historicalKeys)
    .map(Number)
    .filter(year => year !== parseInt(currentYear))
    .sort((a, b) => a - b);

  if (historicalYears.length === 0) {
    Logger.log('_fetchAllHistoricalManagers: no historical years found.');
  }

  historicalYears.forEach(year => {
    const yearRows = _fetchYearTeams(year, historicalKeys[year], allRows);
    allRows.push(...yearRows);
    Logger.log('_fetchAllHistoricalManagers: fetched ' + yearRows.length + ' teams for ' + year);
  });

  const currentRows = _fetchYearTeams(currentYear, leagueKey, allRows);
  allRows.push(...currentRows);
  Logger.log('_fetchAllHistoricalManagers: fetched ' + currentRows.length + ' teams for ' + currentYear);

  return allRows;
}


/**
 * Reads the LEAGUE_KEYS_HISTORY named range from Settings and returns
 * a map of year → league key. If the current year appears in the
 * range, logs a warning — it should live in LEAGUE_KEY only.
 *
 * @param  {Spreadsheet} ss
 * @returns {Object} year (number) → league key (string)
 */
function _readLeagueKeyHistory(ss) {
  const range = ss.getRangeByName('LEAGUE_KEYS_HISTORY');
  if (!range) {
    Logger.log('_readLeagueKeyHistory: LEAGUE_KEYS_HISTORY named range not found.');
    return {};
  }

  const currentYear = parseInt(ss.getRangeByName('CURRENT_YEAR')?.getValue() || 0);
  const keyMap      = {};

  range.getValues().forEach(row => {
    const year = row[0] ? parseInt(row[0]) : 0;          // Col A
    const key  = row[2] ? row[2].toString().trim() : ''; // Col C (changed from row[1])
    
    if (year > 2000 && key) {
      if (year === currentYear) {
        Logger.log('_readLeagueKeyHistory: WARNING — current year ' + currentYear +
                   ' found in LEAGUE_KEYS_HISTORY. Fetch via LEAGUE_KEY instead.');
      }
      keyMap[year] = key;
    }
  });

  Logger.log('_readLeagueKeyHistory: found ' + Object.keys(keyMap).length + ' years.');
  return keyMap;
}


// ============================================================
//  INCREMENTAL UPDATE — CURRENT YEAR ONLY
// ============================================================

/**
 * Updates manager and team data for the current year only.
 * Reads all existing rows from the Managers sheet, normalizes them
 * to the current column schema, then merges fresh Yahoo data into
 * current year rows — updating team name and logo URL while
 * preserving manually entered manager names. New managers not yet
 * in the sheet are appended. Historical year rows are returned
 * unchanged.
 *
 * @param  {Sheet}  sheet       - Managers sheet
 * @param  {string} leagueKey   - Current year league key
 * @param  {number} currentYear - Current season year
 * @returns {Array[]} Full updated row set (all years, no headers)
 */
function _updateCurrentYearManagers(sheet, leagueKey, currentYear) {
  const existingData = sheet.getDataRange().getValues();

  let headerIdx = -1;
  for (let i = 0; i < Math.min(5, existingData.length); i++) {
    if (existingData[i][0]?.toString().trim().toUpperCase() === 'YEAR') {
      headerIdx = i;
      break;
    }
  }

  const rawHeaders  = headerIdx !== -1
    ? existingData[headerIdx].map(h => h.toString().trim().toUpperCase())
    : [];

  const rawDataRows = (headerIdx !== -1 ? existingData.slice(headerIdx + 1) : existingData.slice(MANAGERS_DATA_START_ROW - 1))
    .filter(row => row.some(cell => cell !== '' && cell !== null));

  const existingRows = rawDataRows.map(row => _normalizeManagerRow(row, rawHeaders));

  const freshCurrentRows = _fetchYearTeams(currentYear, leagueKey, existingRows);

  const byTeamId    = {};
  const byManagerId = {};
  const nonCurrent  = [];

  existingRows.forEach(row => {
    if (!row[MGR_COL_YEAR]) return;
    if (parseInt(row[MGR_COL_YEAR]) === parseInt(currentYear)) {
      const tId = row[MGR_COL_TEAM_ID]    ? row[MGR_COL_TEAM_ID].toString()    : '';
      const mId = row[MGR_COL_MANAGER_ID] ? row[MGR_COL_MANAGER_ID].toString() : '';
      if (tId) byTeamId[tId]    = row;
      if (mId) byManagerId[mId] = row;
    } else {
      nonCurrent.push(row);
    }
  });

  freshCurrentRows.forEach(fresh => {
    const tId = fresh[MGR_COL_TEAM_ID]    ? fresh[MGR_COL_TEAM_ID].toString()    : '';
    const mId = fresh[MGR_COL_MANAGER_ID] ? fresh[MGR_COL_MANAGER_ID].toString() : '';
    if (byTeamId[tId]) {
      byTeamId[tId][MGR_COL_TEAM]     = fresh[MGR_COL_TEAM];
      byTeamId[tId][MGR_COL_LOGO_URL] = fresh[MGR_COL_LOGO_URL];
    } else if (!byManagerId[mId]) {
      byTeamId[tId]    = fresh;
      byManagerId[mId] = fresh;
    }
  });

  return [...nonCurrent, ...Object.values(byTeamId)];
}


// ============================================================
//  YAHOO TEAM FETCH
// ============================================================

/**
 * Fetches team metadata for a single league year from Yahoo.
 * Extracts team ID, team name, manager ID, and logo URL per team.
 * Pre-populates the Manager column from prior year history using
 * manager ID matching — leaves blank if no prior history exists.
 * Logo column is returned as empty string — CellImage objects are
 * built and written by _writeManagersSheet.
 *
 * @param  {number}  year      - Season year
 * @param  {string}  leagueKey - Yahoo league key for this year
 * @param  {Array[]} priorRows - All rows fetched so far (for name lookup)
 * @returns {Array[]} Data rows for this year (no headers)
 */
function _fetchYearTeams(year, leagueKey, priorRows) {
  const url  = `https://fantasysports.yahooapis.com/fantasy/v2/league/${leagueKey}/teams?format=json`;
  const data = fetchYahooAPI(url);

  if (!data) {
    Logger.log('_fetchYearTeams: fetch failed for year ' + year + '.');
    return [];
  }

  const teamsData = data.fantasy_content?.league?.[1]?.teams;
  if (!teamsData) return [];

  const historicalNames = {};
  priorRows.forEach(row => {
    const mId  = row[MGR_COL_MANAGER_ID] ? row[MGR_COL_MANAGER_ID].toString() : '';
    const name = row[MGR_COL_MANAGER]    ? row[MGR_COL_MANAGER].toString().trim() : '';
    if (mId && name && !historicalNames[mId]) historicalNames[mId] = name;
  });

  const rows = [];

  for (let i = 0; i < teamsData.count; i++) {
    const teamArr = teamsData[i.toString()]?.team;
    if (!teamArr) continue;

    let teamId = '', teamName = '', managerId = '', logoUrl = '';

    teamArr[0].forEach(item => {
      if (!item) return;
      if (item.team_id)  teamId    = item.team_id.toString();
      if (item.name)     teamName  = item.name;
      if (item.managers) managerId = item.managers[0]?.manager?.manager_id?.toString() || '';
      if (item.team_logos?.[0]?.team_logo?.url) logoUrl = item.team_logos[0].team_logo.url;
    });

    rows.push([
      year,
      '',                                // Logo — CellImage applied by _writeManagersSheet
      teamName,
      historicalNames[managerId] || '',  // Manager — blank if no prior history
      '',                                // Short Name — applied by _applyShortNames
      teamId,
      managerId,
      logoUrl
    ]);
  }

  return rows;
}


// ============================================================
//  SHORT NAME GENERATION
// ============================================================

/**
 * Generates and applies short names for all managers across all years.
 * Uniqueness is evaluated globally so a manager's short name stays
 * consistent year over year as new managers join. Only rows with a
 * non-empty Manager full name receive a short name.
 *
 * Rules applied in order:
 *   1. First name only — if unique across all managers
 *   2. First + last initial — e.g. 'Mike S.'
 *   3. First + two-char last — e.g. 'Mike Sm.' (final fallback)
 *
 * @param  {Array[]} rows - All data rows
 * @returns {Array[]} Same rows with Short Name column populated
 */
function _applyShortNames(rows) {
  const allNames = [...new Set(
    rows.map(r => r[MGR_COL_MANAGER] ? r[MGR_COL_MANAGER].toString().trim() : '').filter(Boolean)
  )];

  const parsed = allNames.map(full => {
    const parts = full.trim().split(/\s+/);
    return { full, first: parts[0] || '', last: parts.length > 1 ? parts[parts.length - 1] : '' };
  });

  const shortNameMap = {};

  parsed.forEach(n => {
    if (!n.first) return;
    const sameFirst = parsed.filter(x => x.first.toLowerCase() === n.first.toLowerCase());
    if (sameFirst.length === 1) {
      shortNameMap[n.full] = n.first;
    } else if (n.last) {
      const sameInit = sameFirst.filter(x => x.last.charAt(0).toLowerCase() === n.last.charAt(0).toLowerCase());
      shortNameMap[n.full] = sameInit.length === 1
        ? `${n.first} ${n.last.charAt(0)}.`
        : `${n.first} ${n.last.substring(0, 2)}.`;
    } else {
      shortNameMap[n.full] = n.first;
    }
  });

  rows.forEach(row => {
    const full          = row[MGR_COL_MANAGER] ? row[MGR_COL_MANAGER].toString().trim() : '';
    row[MGR_COL_SHORT_NAME] = full ? (shortNameMap[full] || full) : '';
  });

  return rows;
}


// ============================================================
//  SHEET WRITE
// ============================================================

/**
 * Writes all manager data rows to the Managers sheet.
 * Clears data rows (row 4+) before writing. Normalizes all rows
 * to MANAGERS_NUM_COLS — pads rows from prior schema versions
 * with empty strings and truncates oversized rows.
 * Inserts rows if the sheet does not have enough capacity.
 *
 * Logo column (col B) is written in two passes:
 *   Pass 1 — setValues() writes all columns with '' for Logo.
 *   Pass 2 — setValues() writes CellImage objects to col B only,
 *             built from Logo URL (col H). CellImage objects are
 *             stored directly in cells with no formula needed.
 *             One CellImage is built per unique URL and reused
 *             across rows sharing the same logo.
 *
 * @param {Sheet}   sheet - Managers display sheet
 * @param {Array[]} rows  - All sorted data rows (no headers)
 */
function _writeManagersSheet(sheet, rows) {
  if (rows.length === 0) return;

  const normalized = rows.map(row => {
    const out = new Array(MANAGERS_NUM_COLS).fill('');
    for (let i = 0; i < Math.min(row.length, MANAGERS_NUM_COLS); i++) {
      out[i] = row[i] !== null && row[i] !== undefined ? row[i] : '';
    }
    return out;
  });

  const lastRow = sheet.getLastRow();
  if (lastRow >= MANAGERS_DATA_START_ROW) {
    sheet.getRange(MANAGERS_DATA_START_ROW, 1,
      lastRow - MANAGERS_DATA_START_ROW + 1, MANAGERS_NUM_COLS).clearContent();
  }

  const needed = MANAGERS_DATA_START_ROW + normalized.length - 1;
  if (sheet.getMaxRows() < needed) {
    sheet.insertRowsAfter(sheet.getMaxRows(), needed - sheet.getMaxRows());
  }

  sheet.getRange(MANAGERS_DATA_START_ROW, 1, normalized.length, MANAGERS_NUM_COLS)
    .setValues(normalized);

  // Build CellImage objects — one per unique URL, reused across rows
  const imageCache  = {};
  const imageValues = normalized.map(row => {
    const url = row[MGR_COL_LOGO_URL] ? row[MGR_COL_LOGO_URL].toString().trim() : '';
    if (!url) return [''];
    if (!(url in imageCache)) {
      try {
        imageCache[url] = SpreadsheetApp.newCellImage()
          .setSourceUrl(url)
          .setAltTextDescription('Team Logo')
          .build();
      } catch (e) {
        Logger.log('_writeManagersSheet: logo build failed for ' + url + ' — ' + e.message);
        imageCache[url] = '';
      }
    }
    return [imageCache[url]];
  });

  sheet.getRange(MANAGERS_DATA_START_ROW, MGR_COL_LOGO + 1, normalized.length, 1)
    .setValues(imageValues);

  Logger.log('_writeManagersSheet: wrote ' + normalized.length + ' rows, ' +
             imageValues.filter(v => v[0] !== '').length + ' logos.');
}


// ============================================================
//  SHEET INITIALIZATION
// ============================================================

/**
 * Returns the Managers sheet from the master workbook. Creates it
 * with title row, blank row, and headers if it does not yet exist.
 *
 * @param  {Spreadsheet} ss
 * @returns {Sheet}
 */
function _getManagersSheet(ss) {
  let sheet = ss.getSheetByName(MANAGERS_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(MANAGERS_SHEET);
    sheet.getRange(1, 1).setValue('Managers');
    sheet.getRange(MANAGERS_HEADER_ROW, 1, 1, MANAGERS_NUM_COLS).setValues([MANAGERS_HEADERS]);
    Logger.log('_getManagersSheet: created Managers sheet.');
  }
  return sheet;
}


// ============================================================
//  DATA READER
// ============================================================

/**
 * Reads all data rows from the Managers sheet starting at
 * MANAGERS_DATA_START_ROW. Filters out entirely blank rows.
 *
 * @param  {Sheet} sheet
 * @returns {Array[]} Data rows (no header rows)
 */
function _readManagersDataRows(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < MANAGERS_DATA_START_ROW) return [];
  return sheet
    .getRange(MANAGERS_DATA_START_ROW, 1,
      lastRow - MANAGERS_DATA_START_ROW + 1, MANAGERS_NUM_COLS)
    .getValues()
    .filter(row => row.some(cell => cell !== '' && cell !== null));
}


// ============================================================
//  ROW NORMALIZATION
// ============================================================

/**
 * Normalizes a single row from an existing Managers sheet to the
 * current MANAGERS_NUM_COLS column schema. Maps known header names
 * to their target column indices so data from prior schema versions
 * lands in the correct position. Unrecognized columns are dropped.
 * Missing columns are filled with empty strings. Logo column is
 * always reset to '' — CellImage is rebuilt by _writeManagersSheet.
 *
 * @param  {Array}    row        - Raw row values from existing sheet
 * @param  {string[]} rawHeaders - Uppercased headers from existing sheet
 * @returns {Array} Normalized row with exactly MANAGERS_NUM_COLS values
 */
function _normalizeManagerRow(row, rawHeaders) {
  const out = new Array(MANAGERS_NUM_COLS).fill('');

  if (rawHeaders.length === 0) {
    for (let i = 0; i < Math.min(row.length, MANAGERS_NUM_COLS); i++) {
      out[i] = row[i] !== null && row[i] !== undefined ? row[i] : '';
    }
    out[MGR_COL_LOGO] = '';
    return out;
  }

  const map = {
    'YEAR': MGR_COL_YEAR, 'TEAM': MGR_COL_TEAM, 'MANAGER': MGR_COL_MANAGER,
    'SHORT NAME': MGR_COL_SHORT_NAME, 'TEAM ID': MGR_COL_TEAM_ID,
    'MANAGER ID': MGR_COL_MANAGER_ID, 'LOGO URL': MGR_COL_LOGO_URL
  };

  rawHeaders.forEach((h, i) => {
    const target = map[h];
    if (target !== undefined && i < row.length) {
      out[target] = row[i] !== null && row[i] !== undefined ? row[i] : '';
    }
  });

  out[MGR_COL_LOGO] = '';
  return out;
}


// ============================================================
//  SHORT NAME REGENERATOR
// ============================================================

/**
 * Regenerates short names for all managers based on the current
 * Manager full name column values. Run manually after filling in
 * or updating manager names. Only the Short Name column is changed —
 * all other columns and the sort order are preserved.
 */
function regenerateShortNames() {
  const ss    = getMasterSS();
  const sheet = _getManagersSheet(ss);
  const rows  = _readManagersDataRows(sheet);

  if (rows.length === 0) {
    Logger.log('regenerateShortNames: no data rows found.');
    return;
  }

  const updated = _applyShortNames(rows);
  sheet.getRange(MANAGERS_DATA_START_ROW, MGR_COL_SHORT_NAME + 1, updated.length, 1)
    .setValues(updated.map(row => [row[MGR_COL_SHORT_NAME]]));

  Logger.log('regenerateShortNames: updated ' + updated.length + ' short names.');
}