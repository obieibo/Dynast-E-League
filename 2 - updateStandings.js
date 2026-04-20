/**
 * FILE: updateStandings.gs
 * PURPOSE: Fetches the current league standings from the Yahoo
 *          Fantasy Sports API and writes them to _STANDINGS in
 *          the Data workbook.
 *
 * READS FROM: Yahoo Fantasy Sports API (standings endpoint)
 * WRITES TO:  _STANDINGS (Data WB)
 * CALLED BY:  commonUpdates() in triggerGroups.gs
 * DEPENDENCIES: helperFunctions.gs, yahooAuthentication.gs
 *
 * OUTPUT SCHEMA (_STANDINGS):
 *   Col A  RANK       — Current league rank
 *   Col B  TEAM_ID    — Yahoo fantasy team ID
 *   Col C  MANAGER_ID — Yahoo manager ID
 *   Col D  TEAM       — Fantasy team display name
 *   Col E  WINS       — Total wins
 *   Col F  LOSSES     — Total losses
 *   Col G  TIES       — Total ties
 *   Col H  WIN_PCT    — Win percentage
 *   Col I  GAMES_BACK — Games behind first place
 */


// ============================================================
//  CONSTANTS
// ============================================================

const STANDINGS_SHEET   = '_STANDINGS';
const STANDINGS_HEADERS = [
  'RANK', 'TEAM_ID', 'MANAGER_ID', 'TEAM',
  'WINS', 'LOSSES', 'TIES', 'WIN_PCT', 'GAMES_BACK'
];


// ============================================================
//  MAIN FUNCTION
// ============================================================

/**
 * Fetches current standings from Yahoo and writes them to
 * _STANDINGS in the Data workbook. Each row represents one
 * fantasy team's current season record and rank.
 */
function updateStandings() {
  const leagueKey = getLeagueKey();
  if (!leagueKey) {
    Logger.log('updateStandings: no league key found. Aborting.');
    return;
  }

  const url  = `https://fantasysports.yahooapis.com/fantasy/v2/league/${leagueKey}/standings?format=json`;
  const data = fetchYahooAPI(url);

  if (!data) {
    Logger.log('updateStandings: fetch failed. Aborting.');
    return;
  }

  const standingsDict = data.fantasy_content?.league?.[1]?.standings?.[0]?.teams;
  if (!standingsDict) {
    Logger.log('updateStandings: no standings data found in response.');
    return;
  }

  const numTeams  = standingsDict.count || 0;
  const outputRows = [STANDINGS_HEADERS];

  for (let i = 0; i < numTeams; i++) {
    const t    = standingsDict[i.toString()]?.team;
    if (!t) continue;

    const meta = t[0];

    const teamId   = meta.find(item => item?.team_id)?.team_id   || '';
    const teamName = meta.find(item => item?.name)?.name         || '';
    const mngrId   = meta.find(item => item?.managers)?.managers?.[0]?.manager?.manager_id || '';

    const standingsObj = t.find(item => item?.team_standings);
    if (!standingsObj) continue;

    const stats   = standingsObj.team_standings;
    const outcome = stats.outcome_totals || {};

    outputRows.push([
      stats.rank             || '',
      teamId,
      mngrId,
      teamName,
      outcome.wins           || 0,
      outcome.losses         || 0,
      outcome.ties           || 0,
      outcome.percentage     || 0,
      stats.games_back       || '-'
    ]);
  }

  writeToData(STANDINGS_SHEET, outputRows);
  Logger.log('updateStandings: wrote ' + (outputRows.length - 1) + ' teams.');
  updateTimestamp('UPDATE_STANDINGS');
}