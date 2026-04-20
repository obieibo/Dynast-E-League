/**
 * FILE: updateDraft.gs (Updated for "Draft" sheet - Current Season Only)
 */

const DRAFT_DATA_SHEET = '_DRAFT';
const DRAFTS_DISPLAY_SHEET = 'Draft'; // Updated name

// Headers without YEAR
const DRAFTS_DISPLAY_HEADERS = [
  'ROUND', 'PICK', 'OVERALL', 'ADJUSTED',
  'MANAGER', 'LOGO', 'TEAM', 'KEEPER',
  'PLAYER', 'MLB_LOGO', 'POSITION', 'IL', 'NA'
];

function updateDraft() {
  const ss = getPrimarySS();
  const leagueKey = getLeagueKey();
  const currentYear = ss.getRangeByName('CURRENT_YEAR')?.getValue();

  if (!leagueKey || !currentYear) return;

  const maps = getPlayerMaps('YAHOOID');
  const { teamMetadata, numTeams } = _fetchTeamMetadata(leagueKey);
  const rawPicks = _fetchRawDraftPicks(leagueKey);
  const playerMap = _fetchDraftPlayerDetails(leagueKey, rawPicks);

  const { dataRows, displayRows } = _buildDraftRows(
    rawPicks, playerMap, teamMetadata, numTeams, maps, currentYear, ss
  );

  // Write Engine Data (Data WB)
  writeToData(DRAFT_DATA_SHEET, [DRAFT_DATA_HEADERS, ...dataRows]);

  // Update Display (Primary WB)
  const sheet = ss.getSheetByName(DRAFTS_DISPLAY_SHEET);
  if (!sheet) return;

  // Clear existing current season data (all rows below header)
  if (sheet.getLastRow() >= DRAFTS_DATA_START_ROW) {
    sheet.getRange(DRAFTS_DATA_START_ROW, 1, sheet.getMaxRows(), DRAFTS_DISPLAY_HEADERS.length).clearContent();
  }

  // Write new rows
  if (displayRows.length > 0) {
    sheet.getRange(DRAFTS_DATA_START_ROW, 1, displayRows.length, displayRows[0].length).setValues(displayRows);
    sheet.getRange(DRAFTS_DATA_START_ROW, 1, displayRows.length, displayRows[0].length).sort({column: 3, ascending: true});
  }

  updateTimestamp('UPDATE_DRAFTS');
  flushIdMatchingQueue();
}

/**
 * Modified row builder (Removed Year from display rows)
 */
function _buildDraftRows(rawPicks, playerMap, teamMetadata, numTeams, maps, rowYear, ss) {
  const dataRows = [];
  const displayRows = [];
  let adjCount = 1;

  rawPicks.forEach(pick => {
    const p = playerMap[pick.playerKey] || {};
    const tMeta = teamMetadata[pick.teamKey] || { name: '', id: '' };
    const masterId = resolveMasterId(maps, p.pId, null, p.name, 'updateDraft', p.team);
    const isKeeper = (p.keeper || '').toUpperCase() === 'K';
    const pos = parsePositions(p.positions || '');

    dataRows.push([
      pick.round, pick.overallPick - ((pick.round - 1) * numTeams), pick.overallPick, 
      isKeeper ? '' : adjCount++, tMeta.id, tMeta.managerId, tMeta.name, p.keeper || '',
      masterId, p.name || '', p.team || '', p.positions, pos.cleanPositions, pos.isIL, pos.isNA
    ]);

    // DISPLAY ROW: Starts at ROUND (Col A), no YEAR
    displayRows.push([
      pick.round, 
      pick.overallPick - ((pick.round - 1) * numTeams), 
      pick.overallPick, 
      isKeeper ? '' : (adjCount - 1),
      tMeta.name, // Placeholder for Manager Name
      `=IFERROR(FILTER(MANAGERS_LOGO, MANAGERS_YEAR=${rowYear}, MANAGERS_TEAM_ID=${tMeta.id}), "")`,
      tMeta.name,
      isKeeper ? '=ICON_K' : '',
      p.name || '',
      p.team ? `=IFERROR(INDEX(MLB_TEAM_LOGOS, ROUNDUP(MATCH("${p.team}", TOCOL(MLB_TEAM_CODES), 0) / COLUMNS(MLB_TEAM_CODES)), MATCH(${rowYear}, MLB_TEAM_YEARS, 0)), "")` : '',
      pos.cleanPositions,
      pos.isIL ? '=ICON_IL' : '',
      pos.isNA ? '=ICON_NA' : ''
    ]);
  });

  return { dataRows, displayRows };
}