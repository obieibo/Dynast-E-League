/**
 * FILE: getFantasyPros.gs
 * PURPOSE: Fetches expert consensus rankings (ECR) from FantasyPros
 *          for three ranking types and writes each to the Data workbook.
 *          Rankings are embedded as JSON in the FantasyPros HTML pages
 *          and extracted via regex.
 *
 * READS FROM: FantasyPros HTML pages (3 parallel fetches)
 *             _IDPLAYER_MAP (Data WB) via getPlayerMaps()
 * WRITES TO:  _FP_PRE (Data WB) — preseason overall rankings
 *             _FP_ROS (Data WB) — rest-of-season overall rankings
 *             _FP_DYN (Data WB) — dynasty overall rankings
 * CALLED BY:  occasionalUpdates() in triggerGroups.gs
 * DEPENDENCIES: helperFunctions.gs, playerResolution.gs
 *
 * OUTPUT SCHEMA (all three sheets):
 *   Col A  IDPLAYER  — Master BBREF ID
 *   Col B  YEAR      — Current season year
 *   Col C  RANK      — Expert consensus rank
 *   Col D  PLAYER    — Player display name
 *   Col E  TEAM      — MLB team abbreviation
 *   Col F  POS       — Position eligibility string
 *   Col G  BEST      — Best rank from any expert
 *   Col H  WORST     — Worst rank from any expert
 *   Col I  AVG       — Average rank across all experts
 *   Col J  STD_DEV   — Standard deviation of ranks
 *   Col K  NOTES     — 'Has Notes' if player has analyst notes, else ''
 *
 * FRAGILITY NOTE:
 *   FantasyPros embeds ranking data as a JavaScript variable in the
 *   HTML source. If FantasyPros changes their page structure or the
 *   variable name, the regex match will fail silently and the sheet
 *   will not be updated. Check UPDATE_FP timestamp to detect failures.
 */


// ============================================================
//  CONSTANTS
// ============================================================

const FP_HEADERS = [
  'IDPLAYER', 'YEAR', 'RANK', 'PLAYER', 'TEAM',
  'POS', 'BEST', 'WORST', 'AVG', 'STD_DEV', 'NOTES'
];

const FP_PAGES = [
  { sheetName: '_FP_PRE', url: 'https://www.fantasypros.com/mlb/rankings/overall.php' },
  { sheetName: '_FP_ROS', url: 'https://www.fantasypros.com/mlb/rankings/ros-overall.php' },
  { sheetName: '_FP_DYN', url: 'https://www.fantasypros.com/mlb/rankings/dynasty-overall.php' }
];


// ============================================================
//  MAIN FUNCTION
// ============================================================

/**
 * Fetches all three FantasyPros ranking pages in parallel,
 * extracts the embedded ECR JSON from each, resolves player IDs,
 * and writes the results to the corresponding sheets.
 *
 * Failures on individual pages are logged but do not abort the
 * run — the other pages continue processing normally.
 */
function getFantasyPros() {
  const ss          = getMasterSS();
  const currentYear = parseInt(ss.getRangeByName('CURRENT_YEAR')?.getValue(), 10);
  if (!currentYear) {
    Logger.log('getFantasyPros: CURRENT_YEAR not found. Aborting.');
    return;
  }

  const maps = getPlayerMaps('FANTPROSNAME');

  // Fetch all three pages in parallel
  const requests  = FP_PAGES.map(page => ({ url: page.url, muteHttpExceptions: true }));
  const responses = UrlFetchApp.fetchAll(requests);

  responses.forEach((response, index) => {
    const page = FP_PAGES[index];

    if (response.getResponseCode() !== 200) {
      Logger.log('getFantasyPros: HTTP ' + response.getResponseCode() + ' for ' + page.url);
      return;
    }

    const html      = response.getContentText();
    const jsonMatch = html.match(/var ecrData = (\{[\s\S]*?\});/);

    if (!jsonMatch) {
      Logger.log('getFantasyPros: could not find ecrData in ' + page.sheetName + ' page. Page structure may have changed.');
      return;
    }

    let ecrData;
    try {
      ecrData = JSON.parse(jsonMatch[1]);
    } catch (e) {
      Logger.log('getFantasyPros: JSON parse failed for ' + page.sheetName + ' — ' + e.message);
      return;
    }

    if (!ecrData || !ecrData.players || ecrData.players.length === 0) {
      Logger.log('getFantasyPros: no player data found for ' + page.sheetName + '.');
      return;
    }

    const outputRows = [FP_HEADERS];

    ecrData.players.forEach(p => {
      const masterId = resolveMasterId(maps, null, null, p.player_name, 'getFantasyPros');
      outputRows.push([
        masterId,
        currentYear,
        p.rank_ecr         || '',
        p.player_name      || '',
        p.player_team_id   || 'FA',
        p.player_positions || '',
        p.rank_min         || '',
        p.rank_max         || '',
        p.rank_ave         || '',
        p.rank_std         || '',
        p.player_notes_id ? 'Has Notes' : ''
      ]);
    });

    writeToData(page.sheetName, outputRows);
    Logger.log('getFantasyPros: wrote ' + (outputRows.length - 1) + ' players to ' + page.sheetName);
  });

  updateTimestamp('UPDATE_FP');
}