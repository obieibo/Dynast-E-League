/**
 * FILE: updateDraft.gs
 * PURPOSE: Fetches the current year draft results from the Yahoo
 * Fantasy Sports API and maintains two outputs:
 *
 * 1. _DRAFT (Data WB) — structured data layer used by
 * updateRosters.gs to look up original draft rounds
 * without re-fetching from Yahoo. This is the
 * authoritative source for draft round data.
 *
 * 2. Drafts (Master WB) — historical display sheet
 * accumulating all years' picks. Appends the current
 * year if not already present. Never overwrites prior
 * year history.
 *
 * This script owns all draft result data. No other script
 * fetches draftresults from Yahoo — they read from _DRAFT.
 * Enforced by execution order in triggerGroups.gs where
 * updateDraft() runs before updateRosters().
 *
 * On first run (empty Drafts sheet): fetches all historical
 * years from LEAGUE_KEYS_HISTORY before appending the
 * current year. Historical years can also be imported one
 * at a time via runHistoricalDraftImport().
 *
 * READS FROM: Yahoo Fantasy Sports API (draftresults, teams, players)
 * Managers sheet (Master WB) — manager display names
 * Named ranges: CURRENT_YEAR, LEAGUE_KEYS_HISTORY,
 * ICON_K, ICON_IL, ICON_NA
 * WRITES TO:  _DRAFT (Data WB)
 * Drafts (Master WB)
 * CALLED BY:  commonUpdates() in triggerGroups.gs
 * Must run BEFORE updateRosters()
 * DEPENDENCIES: helperFunctions.gs, playerResolution.gs,
 * yahooAuthentication.gs, updateManagers.gs
 * (references MGR_COL_* constants)
 */

// ============================================================
//  CONSTANTS
// ============================================================

const DRAFT_DATA_SHEET     = '_DRAFT';
const DRAFTS_DISPLAY_SHEET = 'Drafts';

const DRAFT_DATA_HEADERS = [
  'ROUND', 'PICK', 'OVERALL', 'ADJUSTED',
  'TEAM_ID', 'MANAGER_ID', 'ROSTER', 'KEEPER',
  'IDPLAYER', 'PLAYER', 'MLB_TEAM', 'ELIGIBILITY', 'POSITION', 'IL', 'NA'
];

const DRAFTS_DISPLAY_HEADERS = [
  'YEAR', 'ROUND', 'PICK', 'OVERALL', 'ADJUSTED',
  'MANAGER', 'LOGO', 'TEAM', 'KEEPER',
  'PLAYER', 'MLB_LOGO', 'POSITION', 'IL', 'NA'
];

// Column indices for Drafts display rows (0-based) — used in sort and write logic
const DISP_COL_YEAR    = 0;
const DISP_COL_OVERALL = 3;
const DISP_COL_LOGO    = 6;

const DRAFTS_DATA_START_ROW = 4;  // Rows 1-3 are title/blank/headers
const DRAFT_WRITE_CHUNK     = 100; // Rows per setValues() call


// ============================================================
//  MAIN FUNCTION
// ============================================================

function updateDraft() {
  const ss          = getMasterSS();
  const leagueKey   = getLeagueKey();
  const currentYear = ss.getRangeByName('CURRENT_YEAR')?.getValue();

  if (!leagueKey) {
    Logger.log('updateDraft: no league key found. Aborting.');
    return;
  }
  if (!currentYear) {
    Logger.log('updateDraft: CURRENT_YEAR missing or empty. Aborting.');
    return;
  }

  const maps = getPlayerMaps('YAHOOID');

  const { teamMetadata, numTeams } = _fetchTeamMetadata(leagueKey);
  if (numTeams === 0) {
    Logger.log('updateDraft: no teams found. Aborting.');
    return;
  }

  const rawPicks = _fetchRawDraftPicks(leagueKey);
  if (rawPicks.length === 0) {
    Logger.log('updateDraft: no picks found. Draft may not have occurred yet.');
    return;
  }

  const playerMap = _fetchDraftPlayerDetails(leagueKey, rawPicks);

  const { dataRows, displayRows } = _buildDraftRows(
    rawPicks, playerMap, teamMetadata, numTeams, maps, currentYear, ss
  );

  writeToData(DRAFT_DATA_SHEET, [DRAFT_DATA_HEADERS, ...dataRows]);
  Logger.log('updateDraft: wrote ' + dataRows.length + ' picks to ' + DRAFT_DATA_SHEET);

  const draftsSheet = ss.getSheetByName(DRAFTS_DISPLAY_SHEET);
  if (!draftsSheet || draftsSheet.getLastRow() < DRAFTS_DATA_START_ROW) {
    Logger.log('updateDraft: first run — fetching historical years.');
    _appendHistoricalDraftYears(ss, maps, currentYear);
  }

  _appendToDraftsDisplay(displayRows, currentYear, ss);
  updateTimestamp('UPDATE_DRAFTS');
  flushIdMatchingQueue();
}


// ============================================================
//  TEAM METADATA FETCH
// ============================================================

function _fetchTeamMetadata(leagueKey) {
  const url  = `https://fantasysports.yahooapis.com/fantasy/v2/league/${leagueKey}/teams?format=json`;
  const data = fetchYahooAPI(url);

  const teamMetadata = {};
  let   numTeams     = 0;

  if (!data) {
    Logger.log('_fetchTeamMetadata: fetch failed.');
    return { teamMetadata, numTeams };
  }

  const teamsData = data.fantasy_content?.league?.[1]?.teams;
  if (!teamsData) return { teamMetadata, numTeams };

  numTeams = teamsData.count || 0;

  for (let i = 0; i < numTeams; i++) {
    const t = teamsData[i.toString()]?.team?.[0];
    if (!t) continue;

    let tKey = '', tId = '', tName = '', mId = '';

    t.forEach(item => {
      if (!item) return;
      if (item.team_key) tKey  = item.team_key;
      if (item.team_id)  tId   = item.team_id.toString();
      if (item.name)     tName = item.name;
      if (item.managers) mId   = item.managers[0]?.manager?.manager_id?.toString() || '';
    });

    // We no longer extract or cache logoUrl here
    if (tKey) teamMetadata[tKey] = { name: tName, id: tId, managerId: mId };
  }

  Logger.log('_fetchTeamMetadata: found ' + numTeams + ' teams.');
  return { teamMetadata, numTeams };
}


// ============================================================
//  DRAFT PICKS FETCH
// ============================================================

function _fetchRawDraftPicks(leagueKey) {
  return _fetchRawDraftPicksForKey(leagueKey);
}

function _fetchRawDraftPicksForKey(leagueKey) {
  const url  = `https://fantasysports.yahooapis.com/fantasy/v2/league/${leagueKey}/draftresults?format=json`;
  const data = fetchYahooAPI(url);

  if (!data) {
    Logger.log('_fetchRawDraftPicksForKey: fetch failed for key ' + leagueKey);
    return [];
  }

  const resultsData = data.fantasy_content?.league?.[1]?.draft_results;
  if (!resultsData || resultsData.count === 0) return [];

  const picks = [];
  for (let i = 0; i < resultsData.count; i++) {
    const pick = resultsData[i.toString()]?.draft_result;
    if (pick?.player_key) {
      picks.push({
        overallPick: parseInt(pick.pick),
        round:       parseInt(pick.round),
        teamKey:     pick.team_key,
        playerKey:   pick.player_key
      });
    }
  }

  Logger.log('_fetchRawDraftPicksForKey: found ' + picks.length + ' picks.');
  return picks;
}


// ============================================================
//  PLAYER DETAILS FETCH
// ============================================================

function _fetchDraftPlayerDetails(leagueKey, rawPicks) {
  const urls = [];
  for (let i = 0; i < rawPicks.length; i += 25) {
    const chunk = rawPicks.slice(i, i + 25).map(p => p.playerKey).join(',');
    urls.push(`https://fantasysports.yahooapis.com/fantasy/v2/league/${leagueKey}/players;player_keys=${chunk}?format=json`);
  }

  const playerMap = {};
  fetchAllYahooAPI(urls).forEach(pJson => {
    if (!pJson) return;
    const pData = pJson.fantasy_content?.league?.[1]?.players;
    if (!pData || typeof pData !== 'object') return;
    for (let j = 0; j < pData.count; j++) {
      const pInfo  = pData[j.toString()]?.player;
      if (!pInfo) continue;
      const parsed = parseYahooPlayer(pInfo);
      if (parsed.pKey) playerMap[parsed.pKey] = parsed;
    }
  });

  Logger.log('_fetchDraftPlayerDetails: resolved ' + Object.keys(playerMap).length + ' players.');
  return playerMap;
}


// ============================================================
//  ROW BUILDER
// ============================================================

function _buildDraftRows(rawPicks, playerMap, teamMetadata, numTeams, maps, rowYear, ss) {
  const iconK  = '=ICON_K';
  const iconIL = '=ICON_IL';
  const iconNA = '=ICON_NA';

  // We still use this map strictly to grab the text Manager Name
  const managerDataMap = _buildManagerDataMap(ss);

  const dataRows    = [];
  const displayRows = [];
  let   adjCount    = 1;

  rawPicks.forEach(pick => {
    const p        = playerMap[pick.playerKey] || {};
    const tMeta    = teamMetadata[pick.teamKey] || { name: '', id: '', managerId: '' };
    const masterId = resolveMasterId(maps, parsed.pId, null, parsed.name, 'updateDraft', parsed.team);

    const pickInRound  = pick.overallPick - ((pick.round - 1) * numTeams);
    const isKeeper     = (p.keeper || '').toUpperCase() === 'K';
    const adjustedPick = isKeeper ? '' : adjCount++;
    const eligStr      = p.positions || '';
    const { cleanPositions, isIL, isNA } = parsePositions(eligStr);

    // Get text manager name
    const mapKeyById = `${rowYear}_${tMeta.id}`;
    const mapKeyByName = `${rowYear}_${tMeta.name}`;
    const mgrData = managerDataMap[mapKeyById] || managerDataMap[mapKeyByName] || {};
    const managerName = mgrData.managerName || '';

    // FORMULA 1: FANTASY TEAM LOGO (Column G lookup)
    // Injects the literal rowYear and tMeta.id directly into the formula
    const logoValue = `=IFERROR(FILTER(MANAGERS_LOGO, MANAGERS_YEAR=${rowYear}, MANAGERS_TEAM_ID=${tMeta.id}), "")`;

    // FORMULA 2: MLB TEAM LOGO (Column K lookup)
    // Uses TOCOL and COLUMNS math to find the row in a 2D array, and MATCH for the year column
    const mlbLogoFormula = p.team 
      ? `=IFERROR(INDEX(MLB_TEAM_LOGOS, ROUNDUP(MATCH("${p.team}", TOCOL(MLB_TEAM_CODES), 0) / COLUMNS(MLB_TEAM_CODES)), MATCH(${rowYear}, MLB_TEAM_YEARS, 0)), "")`
      : ``;

    dataRows.push([
      pick.round, pickInRound, pick.overallPick, adjustedPick,
      tMeta.id, tMeta.managerId, tMeta.name, p.keeper || '',
      masterId, p.name || '', p.team || '', eligStr, cleanPositions, isIL, isNA
    ]);

    displayRows.push([
      rowYear, pick.round, pickInRound, pick.overallPick, adjustedPick,
      managerName, logoValue, tMeta.name,
      isKeeper ? iconK : '',
      p.name || '', mlbLogoFormula, cleanPositions,
      isIL ? iconIL : '', isNA ? iconNA : ''
    ]);
  });

  return { dataRows, displayRows };
}


// ============================================================
//  MANAGER DATA MAP (Text Name Only)
// ============================================================

function _buildManagerDataMap(ss) {
  const sheet = ss.getSheetByName('Managers');
  if (!sheet) return {};

  const data = sheet.getDataRange().getValues();
  const managerMap = {};

  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    const year = row[0]; // Col A
    
    if (!year || year === 'Year' || year === 'YEAR') continue;

    const tName = row[2] ? row[2].toString().trim() : ''; // Col C
    const name  = row[4] ? row[4].toString().trim() : ''; // Col E
    const tId   = row[5] ? row[5].toString().trim() : ''; // Col F

    const dataObj = { managerName: name };

    if (tId)   managerMap[`${year}_${tId}`] = dataObj;
    if (tName) managerMap[`${year}_${tName}`] = dataObj;
  }

  return managerMap;
}


// ============================================================
//  DISPLAY SHEET APPEND
// ============================================================

function _appendToDraftsDisplay(displayRows, currentYear, ss) {
  const sheet = ss.getSheetByName(DRAFTS_DISPLAY_SHEET);
  if (!sheet) {
    Logger.log('_appendToDraftsDisplay: Drafts sheet not found.');
    return;
  }

  const lastRow = sheet.getLastRow();

  if (lastRow >= DRAFTS_DATA_START_ROW) {
    const existing = sheet
      .getRange(DRAFTS_DATA_START_ROW, 1, lastRow - DRAFTS_DATA_START_ROW + 1, 1)
      .getValues();
    if (existing.some(r => r[0] == currentYear)) {
      Logger.log('_appendToDraftsDisplay: ' + currentYear + ' already in Drafts. Skipping.');
      return;
    }
  }

  if (!displayRows || displayRows.length === 0) {
    Logger.log('_appendToDraftsDisplay: no rows to append.');
    return;
  }

  const NUM_COLS    = DRAFTS_DISPLAY_HEADERS.length;
  const appendStart = Math.max(DRAFTS_DATA_START_ROW, lastRow + 1);

  const safeRows = displayRows.map((row, idx) => {
    const absoluteRow = appendStart + idx;
    return row.map(cell => {
      if (cell === null || cell === undefined) return '';
      
      if (cell instanceof Date) {
        return Utilities.formatDate(cell, Session.getScriptTimeZone(), 'yyyy-MM-dd');
      }

      // Replace {ROW} placeholder with the actual row number (e.g., A4, L5)
      if (typeof cell === 'string' && cell.includes('{ROW}')) {
        return cell.replace(/\{ROW\}/g, absoluteRow);
      }

      return cell; 
    });
  });

  const needed = appendStart + safeRows.length - 1;

  if (sheet.getMaxRows() < needed) {
    sheet.insertRowsAfter(sheet.getMaxRows(), needed - sheet.getMaxRows());
    SpreadsheetApp.flush();
  }

  for (let i = 0; i < safeRows.length; i += DRAFT_WRITE_CHUNK) {
    const chunk = safeRows.slice(i, i + DRAFT_WRITE_CHUNK);
    sheet.getRange(appendStart + i, 1, chunk.length, NUM_COLS).setValues(chunk);
    SpreadsheetApp.flush();
    Logger.log('_appendToDraftsDisplay: wrote rows ' + (appendStart + i) +
               ' to ' + (appendStart + i + chunk.length - 1));
  }

  try {
    const newLast = sheet.getLastRow();
    if (newLast >= DRAFTS_DATA_START_ROW) {
      sheet
        .getRange(DRAFTS_DATA_START_ROW, 1, newLast - DRAFTS_DATA_START_ROW + 1, NUM_COLS)
        .sort([
          { column: DISP_COL_YEAR    + 1, ascending: false },
          { column: DISP_COL_OVERALL + 1, ascending: true  }
        ]);
    }
  } catch (e) {
    Logger.log('_appendToDraftsDisplay: sort failed. Data was written. Error: ' + e.message);
  }

  Logger.log('_appendToDraftsDisplay: appended ' + safeRows.length + ' picks for ' + currentYear);
}


// ============================================================
//  HISTORICAL YEAR IMPORT
// ============================================================

function _appendHistoricalDraftYears(ss, maps, currentYear) {
  const histRange = ss.getRangeByName('LEAGUE_KEYS_HISTORY');
  if (!histRange) {
    Logger.log('_appendHistoricalDraftYears: LEAGUE_KEYS_HISTORY not found.');
    return;
  }

  const years = histRange.getValues()
    // Changed row[1] to row[2] to read League Key from Column C
    .map(row => ({ year: parseInt(row[0]), key: row[2]?.toString().trim() || '' }))
    .filter(e => e.year > 2000 && e.key && e.year !== parseInt(currentYear))
    .sort((a, b) => a.year - b.year);

  if (years.length === 0) {
    Logger.log('_appendHistoricalDraftYears: no historical years found.');
    return;
  }

  years.forEach(entry => {
    Logger.log('_appendHistoricalDraftYears: fetching ' + entry.year + '...');
    _fetchAndAppendYear(entry.year, entry.key, maps, ss);
    Utilities.sleep(500);
  });
}

function runHistoricalDraftImport(targetYear) {
  const ss      = getMasterSS();
  const maps    = getPlayerMaps('YAHOOID');
  const histRange = ss.getRangeByName('LEAGUE_KEYS_HISTORY');

  if (!histRange) {
    Logger.log('runHistoricalDraftImport: LEAGUE_KEYS_HISTORY not found.');
    return;
  }

  const match = histRange.getValues()
    // Changed row[1] to row[2] to read League Key from Column C
    .map(row => ({ year: parseInt(row[0]), key: row[2]?.toString().trim() || '' }))
    .find(e => e.year === parseInt(targetYear));

  if (!match) {
    Logger.log('runHistoricalDraftImport: year ' + targetYear + ' not found in LEAGUE_KEYS_HISTORY.');
    return;
  }

  Logger.log('runHistoricalDraftImport: importing ' + targetYear + '...');
  _fetchAndAppendYear(match.year, match.key, maps, ss);
  Logger.log('runHistoricalDraftImport: ' + targetYear + ' complete.');
}

function _fetchAndAppendYear(year, leagueKey, maps, ss) {
  const { teamMetadata, numTeams } = _fetchTeamMetadata(leagueKey);
  if (numTeams === 0) {
    Logger.log('_fetchAndAppendYear: no teams for ' + year + '. Skipping.');
    return;
  }

  const rawPicks = _fetchRawDraftPicksForKey(leagueKey);
  if (rawPicks.length === 0) {
    Logger.log('_fetchAndAppendYear: no picks for ' + year + '. Skipping.');
    return;
  }

  const playerMap = _fetchDraftPlayerDetails(leagueKey, rawPicks);
  const { displayRows } = _buildDraftRows(
    rawPicks, playerMap, teamMetadata, numTeams, maps, year, ss
  );

  _appendToDraftsDisplay(displayRows, year, ss);
  Logger.log('_fetchAndAppendYear: appended ' + displayRows.length + ' picks for ' + year);
}