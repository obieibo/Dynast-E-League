/**
 * @file dataSchedule.gs
 * @description Generates a weekly schedule difficulty multiplier for all 30 MLB teams.
 * Merges MLB Stats API (games/opponents), FanGraphs (team quality), and Park Factors.
 * Includes dynamic playoff detection to heavily penalize matchups against elite teams
 * during the fantasy playoffs.
 * @dependencies _helpers.gs
 * @writesTo _WEEKLY_SCHEDULE in the Data workbook
 */

// ============================================================================
//  CONSTANTS & MAPPINGS
// ============================================================================

// MLB Stats API Team IDs mapped to your standard 3-letter abbreviations
const MLB_TEAM_MAP = {
  108: 'LAA', 109: 'ARI', 110: 'BAL', 111: 'BOS', 112: 'CHC', 113: 'CIN', 
  114: 'CLE', 115: 'COL', 116: 'DET', 117: 'HOU', 118: 'KCR', 119: 'LAD', 
  120: 'WSH', 121: 'NYM', 133: 'ATH', 134: 'PIT', 135: 'SDP', 136: 'SEA', 
  137: 'SFG', 138: 'STL', 139: 'TBR', 140: 'TEX', 141: 'TOR', 142: 'MIN', 
  143: 'PHI', 144: 'ATL', 145: 'CWS', 146: 'MIA', 147: 'NYY', 158: 'MIL'
};

// 3-Year Rolling Park Factors (Base 100 = Neutral). 
// Hardcoding this is vastly superior to scraping FanGraphs HTML daily, as these 
// metrics stabilize over 3 years and barely shift mid-season.
const PARK_FACTORS = {
  'COL': 112, 'CIN': 108, 'BOS': 108, 'KCR': 105, 'LAA': 104, 'BAL': 103,
  'TEX': 103, 'ATL': 102, 'CWS': 102, 'PHI': 102, 'LAD': 101, 'ARI': 101,
  'MIN': 101, 'TOR': 100, 'HOU': 100, 'NYY': 100, 'MIA': 99,  'CHC': 99,
  'MIL': 99,  'WSH': 98,  'PIT': 98,  'CLE': 98,  'NYM': 97,  'TBR': 97,
  'SDP': 96,  'STL': 96,  'ATH': 95,  'SFG': 95,  'DET': 94,  'SEA': 92
};

// ============================================================================
//  MAIN EXECUTION FUNCTION
// ============================================================================

/**
 * Calculates the weekly difficulty schedule for a given date range.
 * Defaults to the upcoming Monday-Sunday if no dates are provided.
 */
function updateWeeklyScheduleContext() {
  const ss = getPrimarySS();
  const currentYear = parseInt(ss.getRangeByName('CURRENT_YEAR')?.getValue(), 10) || new Date().getFullYear();
  
  // 1. Determine target week (Next Monday to Sunday)
  const today = new Date();
  const dayOfWeek = today.getDay(); // 0 = Sun, 1 = Mon, etc.
  const daysUntilNextMonday = dayOfWeek === 0 ? 1 : 8 - dayOfWeek;
  
  const startDate = new Date(today);
  startDate.setDate(today.getDate() + daysUntilNextMonday);
  
  const endDate = new Date(startDate);
  endDate.setDate(startDate.getDate() + 6);

  const startStr = Utilities.formatDate(startDate, "GMT", "yyyy-MM-dd");
  const endStr = Utilities.formatDate(endDate, "GMT", "yyyy-MM-dd");

  Logger.log(`Processing Schedule for Week: ${startStr} to ${endStr}`);

  // 2. Check League Info for Playoff Status
  const scheduleContext = _getLeagueScheduleContext();
  const isPlayoffs = scheduleContext ? scheduleContext.isPlayoffs : false;
  
  if (isPlayoffs) {
    Logger.log(`PLAYOFF MODE ENGAGED: Week ${scheduleContext.currentWeek} (Playoffs started Wk ${scheduleContext.playoffStartWeek})`);
  }

  // 3. Fetch all necessary data
  const scheduleData = _fetchMLBStatsSchedule(startStr, endStr);
  const fgBatting = _fetchFanGraphsTeamStats(currentYear, 'bat');
  const fgPitching = _fetchFanGraphsTeamStats(currentYear, 'pit');

  if (!scheduleData || !fgBatting || !fgPitching) {
    _logError('dataSchedule.gs', 'Failed to fetch one or more schedule dependencies.', 'HIGH');
    return;
  }

  // 4. Build ranking dictionaries from FanGraphs
  // We rank Batting by wRC+ (higher is better, so Rank 1 = hardest for opposing pitchers)
  const batRanks = _rankTeams(fgBatting, 'wRC+'); 
  
  // We rank Pitching by SIERA (lower is better, so Rank 1 = hardest for opposing hitters)
  const pitchRanks = _rankTeams(fgPitching, 'SIERA', true);

  // 5. Calculate difficulty per team
  const outputRows = [['TEAM', 'GAMES', 'OPP_PITCH_RANK_AVG', 'OPP_BAT_RANK_AVG', 'PARK_FACTOR_AVG', 'HITTER_DIFF_MULT', 'PITCHER_DIFF_MULT', 'PLAYOFFS_ACTIVE']];

  Object.keys(MLB_TEAM_MAP).forEach(mlbId => {
    const teamAbbr = MLB_TEAM_MAP[mlbId];
    const games = scheduleData[teamAbbr] || [];
    
    if (games.length === 0) {
      // If a team has no games (All-Star break, etc.), default multipliers to 1.0
      outputRows.push([teamAbbr, 0, 15.5, 15.5, 1.0, 1.0, 1.0, isPlayoffs ? "YES" : "NO"]);
      return;
    }

    let totalOppPitchRank = 0;
    let totalOppBatRank = 0;
    let totalParkFactor = 0;

    games.forEach(game => {
      const oppAbbr = game.opponent;
      const venueAbbr = game.isHome ? teamAbbr : oppAbbr;
      
      totalOppPitchRank += pitchRanks[oppAbbr] || 15.5; // default to average if missing
      totalOppBatRank += batRanks[oppAbbr] || 15.5;
      
      const parkRaw = PARK_FACTORS[venueAbbr] || 100;
      totalParkFactor += (parkRaw / 100); // Normalize to 1.0
    });

    const avgOppPitch = totalOppPitchRank / games.length;
    const avgOppBat = totalOppBatRank / games.length;
    const avgPark = totalParkFactor / games.length;

    // BASE MULTIPLIER MATH: 1.0 + ((Rank - 15.5) / 100)
    // High rank (e.g. 30) = easy schedule = multiplier > 1.0
    let hitterMult = 1.0 + ((avgOppPitch - 15.5) / 100);
    let pitcherMult = 1.0 + ((avgOppBat - 15.5) / 100);

    // =========================================================
    // THE PLAYOFF SHIFT
    // =========================================================
    if (isPlayoffs) {
      // In the playoffs, matchups against elite teams are deadlier.
      // We widen the variance to heavily penalize streaming against top 10 units.
      
      // If facing a top 10 pitching staff (rank 1-10), double the penalty for hitters
      if (avgOppPitch < 10) hitterMult = hitterMult - ((10 - avgOppPitch) / 100);
      
      // If facing a top 10 offense (rank 1-10), double the penalty for pitchers
      if (avgOppBat < 10) pitcherMult = pitcherMult - ((10 - avgOppBat) / 100);
    }

    // Apply park factors
    hitterMult = hitterMult * avgPark; // Hitters benefit from good parks
    pitcherMult = pitcherMult / avgPark; // Pitchers benefit from bad parks

    outputRows.push([
      teamAbbr, 
      games.length, 
      avgOppPitch.toFixed(1), 
      avgOppBat.toFixed(1), 
      avgPark.toFixed(3), 
      hitterMult.toFixed(3), 
      pitcherMult.toFixed(3),
      isPlayoffs ? "YES" : "NO"
    ]);
  });

  // 6. Write to Sheet
  writeToData('_WEEKLY_SCHEDULE', outputRows);
  _updateTimestamp('UPDATE_SCHEDULE');
}

// ============================================================================
//  HELPER FETCHERS & PARSERS
// ============================================================================

/**
 * @description Reads the _LEAGUE_INFO sheet to dynamically determine season progress.
 * Automatically flags when the league has entered the playoffs.
 * @returns {Object} Context object containing week numbers, dates, and playoff status.
 */
function _getLeagueScheduleContext() {
  const dataSS = getDataSS();
  const infoSheet = dataSS.getSheetByName("_LEAGUE_INFO");
  
  if (!infoSheet) return null;

  // Read columns A, B, C
  const data = infoSheet.getRange("A2:C" + infoSheet.getLastRow()).getValues();
  
  let context = {
    startWeek: 1,
    endWeek: 26,
    currentWeek: 1,
    playoffStartWeek: 24,
    isPlayoffs: false
  };

  data.forEach(row => {
    const type = row[0]?.toString().toLowerCase();
    const key = row[1]?.toString().toLowerCase();
    const val = row[2];

    if (type === 'league' && key === 'start_week') context.startWeek = parseInt(val, 10);
    if (type === 'league' && key === 'end_week') context.endWeek = parseInt(val, 10);
    if (type === 'league' && key === 'current_week') context.currentWeek = parseInt(val, 10);
    if (type === 'settings' && key === 'playoff_start_week') context.playoffStartWeek = parseInt(val, 10);
  });

  // Automatically flag playoff mode
  context.isPlayoffs = (context.currentWeek >= context.playoffStartWeek);
  
  return context;
}

/**
 * Fetches the MLB Stats API schedule and organizes opponents by team.
 */
function _fetchMLBStatsSchedule(startDate, endDate) {
  const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&startDate=${startDate}&endDate=${endDate}&gameType=R`;
  
  let json;
  try {
    const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (response.getResponseCode() !== 200) throw new Error(`HTTP ${response.getResponseCode()}`);
    json = JSON.parse(response.getContentText());
  } catch (e) {
    _logError('dataSchedule.gs', `MLB Stats API Fetch Failed: ${e.message}`, 'HIGH');
    return null;
  }

  const scheduleMap = {};
  Object.values(MLB_TEAM_MAP).forEach(abbr => scheduleMap[abbr] = []);

  if (!json.dates) return scheduleMap;

  json.dates.forEach(dateObj => {
    dateObj.games.forEach(game => {
      const awayId = game.teams.away.team.id;
      const homeId = game.teams.home.team.id;
      
      const awayAbbr = MLB_TEAM_MAP[awayId];
      const homeAbbr = MLB_TEAM_MAP[homeId];

      if (awayAbbr && homeAbbr) {
        scheduleMap[awayAbbr].push({ opponent: homeAbbr, isHome: false });
        scheduleMap[homeAbbr].push({ opponent: awayAbbr, isHome: true });
      }
    });
  });

  return scheduleMap;
}

/**
 * Fetches FanGraphs team-level stats to evaluate opponent strength.
 */
function _fetchFanGraphsTeamStats(year, statType) {
  // statType: 'bat' or 'pit'
  // team=0,ts instructs FG to return Team Splits rather than individual players
  const url = `https://www.fangraphs.com/api/leaders/major-league/data?pos=all&stats=${statType}&lg=all&qual=0&type=8&season=${year}&month=0&season1=${year}&ind=0&team=0,ts&rost=0&age=0&filter=&players=0`;
  
  try {
    const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (response.getResponseCode() !== 200) return null;
    const json = JSON.parse(response.getContentText());
    return json.data || [];
  } catch (e) {
    _logError('dataSchedule.gs', `FG Team Stats Fetch Failed: ${e.message}`, 'HIGH');
    return null;
  }
}

/**
 * Utility to rank FanGraphs team data.
 * @param {boolean} reverse - If true, lower values rank #1 (e.g., SIERA). 
 * If false, higher values rank #1 (e.g., wRC+).
 */
function _rankTeams(fgData, statKey, reverse = false) {
  const ranks = {};
  
  // Clean up team abbreviations to match our internal map
  const cleanData = fgData.map(team => {
    let name = team.TeamNameAbb || team.Team || '';
    name = name.replace(/<[^>]+>/g, '').trim(); // Remove HTML tags FG sometimes leaves in
    // Normalize aliases (e.g. WSN to WSH)
    if (name === 'WSN' || name === 'WAS') name = 'WSH';
    if (name === 'CHW' || name === 'CHA') name = 'CWS';
    if (name === 'TBA' || name === 'RAY') name = 'TBR';
    if (name === 'KCA') name = 'KCR';
    
    return { team: name, val: parseFloat(team[statKey]) || 0 };
  }).filter(t => t.team !== '');

  // Sort logic
  cleanData.sort((a, b) => reverse ? a.val - b.val : b.val - a.val);

  // Assign ranks 1 to 30
  cleanData.forEach((item, index) => {
    ranks[item.team] = index + 1;
  });

  return ranks;
}