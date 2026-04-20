/**
 * FILE: updateHistoricalTeamStats.gs
 * PURPOSE: Fetches final season stats for all teams for a specific 
 * historical year to establish SGP (Standings Gained Points) denominators.
 *
 * READS FROM: LEAGUE_KEYS_HISTORY (Primary WB)
 * WRITES TO:  _HISTORICAL_TEAM_STATS (Data WB)
 * TIMESTAMPS: UPDATE_HISTORICAL_TEAM_STATS (Primary WB)
 */

/**
 * Main function to fetch historical team stats.
 * @param {number|string} year - The year to fetch (defaults to 2025).
 */
function updateHistoricalTeamStats(year = 2025) {
  const ss = getPrimarySS();
  const keysRange = ss.getRangeByName("LEAGUE_KEYS_HISTORY");

  if (!keysRange) {
    Logger.log("updateHistoricalTeamStats: Named range LEAGUE_KEYS_HISTORY not found.");
    return;
  }

  // 1. Find the League Key for the requested year
  const keysData = keysRange.getValues();
  // String() safely handles numbers vs strings and potential empty rows
  const row = keysData.find(r => r && r[0] && String(r[0]) === String(year));
  
  if (!row || !row[2]) {
    Logger.log(`updateHistoricalTeamStats: No league key found for year ${year} in LEAGUE_KEYS_HISTORY.`);
    return;
  }

  const leagueKey = row[2].toString().trim();
  Logger.log(`updateHistoricalTeamStats: Fetching final stats for ${year} (Key: ${leagueKey})...`);

  // 2. Fetch Settings (for Stat Names) and Stats (for Values) in parallel
  const urls = [
    `https://fantasysports.yahooapis.com/fantasy/v2/league/${leagueKey}/settings?format=json`,
    `https://fantasysports.yahooapis.com/fantasy/v2/league/${leagueKey}/teams/stats?format=json`
  ];

  const [settingsData, statsData] = fetchAllYahooAPI(urls);

  if (!settingsData || !statsData) {
    Logger.log('updateHistoricalTeamStats: API fetch failed. Check Yahoo authorization.');
    return;
  }

  // 3. Build Stat Map (converts Yahoo IDs like '12' to 'HR')
  const categories = settingsData.fantasy_content?.league?.[1]?.settings?.[0]?.stat_categories?.stats;
  if (!categories) {
    Logger.log('updateHistoricalTeamStats: Could not find stat categories in settings.');
    return;
  }

  const statMap = {};
  categories.forEach(s => {
    statMap[s.stat.stat_id] = s.stat.display_name;
  });

  // 4. Parse Team Stats
  const teamsDict = statsData.fantasy_content?.league?.[1]?.teams;
  if (!teamsDict || teamsDict.count === 0) {
    Logger.log('updateHistoricalTeamStats: No team data found.');
    return;
  }

  const numTeams = teamsDict.count;

  // Build headers from the first team's stat array to ensure order alignment
  const firstTeamStats = teamsDict['0']?.team?.find(item => item?.team_stats)?.team_stats?.stats || [];
  const statHeaders    = firstTeamStats.map(s => statMap[s.stat.stat_id] || `Stat_${s.stat.stat_id}`);
  
  // Columns: Year, Team ID, Team Name, then all category names
  const headers        = ['YEAR', 'TEAM_ID', 'TEAM', ...statHeaders];
  const outputRows     = [headers];

  for (let i = 0; i < numTeams; i++) {
    const teamArray = teamsDict[i.toString()]?.team;
    if (!teamArray) continue;

    const meta = teamArray[0];
    const teamId   = meta.find(item => item?.team_id)?.team_id   || '';
    const teamName = meta.find(item => item?.name)?.name         || '';

    const statsBlock = teamArray.find(item => item?.team_stats);
    const statVals   = statsBlock
      ? statsBlock.team_stats.stats.map(s => s.stat.value || '0')
      : [];

    outputRows.push([year, teamId, teamName, ...statVals]);
  }

  // 5. Write to Data Workbook and Timestamp Primary Workbook
  writeToData('_HISTORICAL_TEAM_STATS', outputRows);
  updateTimestamp('UPDATE_HISTORICAL_TEAM_STATS');
  
  Logger.log(`updateHistoricalTeamStats: Successfully wrote ${year} stats to _HISTORICAL_TEAM_STATS.`);
}