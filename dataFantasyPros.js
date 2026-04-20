/**
 * @file dataFantasyPros.gs
 * @description Fetches expert consensus rankings (ECR) from FantasyPros for 
 * Preseason, Rest-of-Season (ROS), and Dynasty formats.
 * @dependencies _helpers.gs, resolvePlayer.gs
 * @writesTo _FP_PRE, _FP_ROS, _FP_DYN
 */

// ============================================================================
//  FANTASYPROS CONSTANTS
// ============================================================================

const FP_PAGES = [
  { sheetName: '_FP_PRE', url: 'https://www.fantasypros.com/mlb/rankings/overall.php' },
  { sheetName: '_FP_ROS', url: 'https://www.fantasypros.com/mlb/rankings/ros-overall.php' },
  { sheetName: '_FP_DYN', url: 'https://www.fantasypros.com/mlb/rankings/dynasty-overall.php' }
];

const FP_HEADERS = ['YEAR', 'IDPLAYER', 'RANK', 'PLAYER', 'TEAM', 'BEST', 'WORST', 'AVG', 'STD_DEV'];

// ============================================================================
//  MAIN FETCH FUNCTION
// ============================================================================

/**
 * Fetches all three ranking pages in parallel, parses embedded JSON, and writes.
 */
function updateFantasyProsRankings() {
  const ss = getPrimarySS();
  const currentYear = parseInt(ss.getRangeByName('CURRENT_YEAR')?.getValue(), 10);
  if (!currentYear) {
    _logError('dataFantasyPros.gs', 'CURRENT_YEAR not found.', 'CRITICAL');
    return;
  }

  const maps = getPlayerMaps('YAHOOID'); // FP doesn't provide IDs, relying on Name match
  const requests = FP_PAGES.map(page => ({ url: page.url, muteHttpExceptions: true }));
  const responses = UrlFetchApp.fetchAll(requests);

  responses.forEach((response, index) => {
    const page = FP_PAGES[index];
    if (response.getResponseCode() !== 200) {
      _logError('dataFantasyPros.gs', `HTTP ${response.getResponseCode()} for ${page.url}`, 'HIGH');
      return;
    }

    const html = response.getContentText();
    const jsonMatch = html.match(/var ecrData = (\{[\s\S]*?\});/);

    if (!jsonMatch) {
      _logError('dataFantasyPros.gs', `Could not find ecrData on ${page.sheetName}. Page structure may have changed.`, 'HIGH');
      return;
    }

    let ecrData;
    try {
      ecrData = JSON.parse(jsonMatch[1]);
    } catch (e) {
      _logError('dataFantasyPros.gs', `JSON parse failed for ${page.sheetName}: ${e.message}`, 'HIGH');
      return;
    }

    if (!ecrData || !ecrData.players || ecrData.players.length === 0) return;

    const outputRows = [FP_HEADERS];

    ecrData.players.forEach(p => {
      const team = p.player_team_id || 'FA';
      const pName = p.player_name || '';
      
      // resolvePrimaryId(maps, platformId, mlbId, fgId, name, source, team)
      const primaryId = resolvePrimaryId(maps, null, null, null, pName, 'updateFantasyProsRankings', team);
      
      // Schema: YEAR, IDPLAYER, RANK, PLAYER, TEAM, BEST, WORST, AVG, STD_DEV
      outputRows.push([
        currentYear,
        primaryId,
        p.rank_ecr || '',
        pName,
        team,
        p.rank_min || '',
        p.rank_max || '',
        p.rank_ave || '',
        p.rank_std || ''
      ]);
    });

    writeToData(page.sheetName, outputRows);
  });

  _updateTimestamp('UPDATE_FP');
}