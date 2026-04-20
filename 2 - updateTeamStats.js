/**
 * FILE: updateTeamStats.gs
 * PURPOSE: Fetches cumulative season stats for all fantasy teams
 *          from the Yahoo Fantasy Sports API and writes them to
 *          _TEAM_STATS in the Data workbook.
 *
 *          _TEAM_STATS feeds the league stats dashboard and is used
 *          to calculate z-scores for each stat category across all
 *          teams — showing where each manager ranks and how far above
 *          or below the league average they sit in each category.
 *
 * READS FROM: Yahoo Fantasy Sports API (teams/stats endpoint)
 *             Yahoo Fantasy Sports API (settings endpoint, for stat map)
 * WRITES TO:  _TEAM_STATS (Data WB)
 * CALLED BY:  commonUpdates() in triggerGroups.gs
 * DEPENDENCIES: helperFunctions.gs, yahooAuthentication.gs
 *
 * OUTPUT SCHEMA (_TEAM_STATS):
 *   Col A  TEAM_ID    — Yahoo fantasy team ID
 *   Col B  MANAGER_ID — Yahoo manager ID
 *   Col C  TEAM       — Fantasy team display name
 *   Col D+ [STAT COLS] — One column per scoring category, dynamically
 *                        named from Yahoo stat IDs via the settings
 *                        endpoint. Column count varies by league.
 *                        Stat column order matches the settings endpoint
 *                        response order.
 */


// ============================================================
//  CONSTANTS
// ============================================================

const TEAM_STATS_SHEET = '_TEAM_STATS';


// ============================================================
//  MAIN FUNCTION
// ============================================================

/**
 * Fetches cumulative season stats for all 12 teams and writes
 * them to _TEAM_STATS in the Data workbook.
 *
 * Fetches the league settings first to build a stat ID → display
 * name map, then fetches the teams/stats endpoint in parallel.
 * Both requests are made via fetchAllYahooAPI for efficiency.
 *
 * Execution steps:
 *   1. Build stat ID → display name map from settings endpoint
 *   2. Fetch cumulative team stats from teams/stats endpoint
 *   3. Build output rows with dynamic stat columns
 *   4. Write to _TEAM_STATS
 *   5. Stamp UPDATE_TEAM_STATS timestamp
 */
function updateTeamStats() {
  const leagueKey = getLeagueKey();
  if (!leagueKey) {
    Logger.log('updateTeamStats: no league key found. Aborting.');
    return;
  }

  // Steps 1 + 2 — Fetch settings and team stats in parallel
  const urls = [
    `https://fantasysports.yahooapis.com/fantasy/v2/league/${leagueKey}/settings?format=json`,
    `https://fantasysports.yahooapis.com/fantasy/v2/league/${leagueKey}/teams/stats?format=json`
  ];

  const [settingsData, statsData] = fetchAllYahooAPI(urls);

  if (!settingsData) {
    Logger.log('updateTeamStats: settings fetch failed. Aborting.');
    return;
  }
  if (!statsData) {
    Logger.log('updateTeamStats: team stats fetch failed. Aborting.');
    return;
  }

  // Step 3 — Build stat map from settings response
  const categories = settingsData.fantasy_content?.league?.[1]?.settings?.[0]?.stat_categories?.stats;
  if (!categories) {
    Logger.log('updateTeamStats: stat categories not found in settings response. Aborting.');
    return;
  }

  const statMap = {};
  categories.forEach(s => {
    statMap[s.stat.stat_id] = s.stat.display_name;
  });

  // Step 4 — Parse team stats
  const teamsDict = statsData.fantasy_content?.league?.[1]?.teams;
  if (!teamsDict) {
    Logger.log('updateTeamStats: no teams data found in stats response. Aborting.');
    return;
  }

  const numTeams = teamsDict.count || 0;

  // Build headers from first team's stat array to guarantee column/value alignment
  const firstTeamStats = teamsDict['0']?.team?.find(item => item?.team_stats)?.team_stats?.stats || [];
  const statHeaders    = firstTeamStats.map(s => statMap[s.stat.stat_id] || `Stat_${s.stat.stat_id}`);
  const headers        = ['TEAM_ID', 'MANAGER_ID', 'TEAM', ...statHeaders];
  const outputRows     = [headers];

  for (let i = 0; i < numTeams; i++) {
    const teamArray = teamsDict[i.toString()]?.team;
    if (!teamArray) continue;

    const meta = teamArray[0];

    const teamId   = meta.find(item => item?.team_id)?.team_id   || '';
    const teamName = meta.find(item => item?.name)?.name         || '';
    const mngrId   = meta.find(item => item?.managers)?.managers?.[0]?.manager?.manager_id || '';

    const statsBlock = teamArray.find(item => item?.team_stats);
    const statVals   = statsBlock
      ? statsBlock.team_stats.stats.map(s => s.stat.value || '0')
      : [];

    outputRows.push([teamId, mngrId, teamName, ...statVals]);
  }

  // Step 5 — Write and timestamp
  writeToData(TEAM_STATS_SHEET, outputRows);
  Logger.log('updateTeamStats: wrote ' + (outputRows.length - 1) + ' teams.');
  updateTimestamp('UPDATE_TEAM_STATS');
}