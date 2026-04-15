/**
 * FILE: updateLeagueInfo.gs
 * PURPOSE: Fetches all league settings from the Yahoo Fantasy Sports
 *          API and writes a structured reference table to _LEAGUE_INFO
 *          in the Data workbook. Captures league metadata, roster
 *          positions, scoring stat categories, stat modifiers, and
 *          division information in a single flat table.
 *
 *          _LEAGUE_INFO is a reference sheet — it is not used as
 *          input by other scripts. It exists so league configuration
 *          details are visible and queryable from the spreadsheet
 *          without needing to call the Yahoo API directly.
 *
 * READS FROM: Yahoo Fantasy Sports API (settings endpoint)
 * WRITES TO:  _LEAGUE_INFO (Data WB)
 * CALLED BY:  weeklyUpdates() in triggerGroups.gs
 *             rareUpdates() for manual on-demand refresh
 * DEPENDENCIES: helperFunctions.gs, yahooAuthentication.gs
 *
 * OUTPUT SCHEMA (_LEAGUE_INFO):
 *   Col A  CATEGORY — Grouping label for the setting row
 *                     Values: 'League Info', 'General Setting',
 *                             'Roster Position', 'Stat Category',
 *                             'Stat Modifier', 'Division'
 *   Col B  SETTING  — The setting name or identifier
 *   Col C  VALUE    — The setting value
 *   Col D  TYPE     — Position type or stat type where applicable
 *   Col E  ID       — Yahoo internal ID (stat_id, division_id, etc.)
 *   Col F  FLAG     — Additional flags (e.g. 'Display Only', 'Bench')
 */


// ============================================================
//  CONSTANTS
// ============================================================

const LEAGUE_INFO_SHEET   = '_LEAGUE_INFO';
const LEAGUE_INFO_HEADERS = ['CATEGORY', 'SETTING', 'VALUE', 'TYPE', 'ID', 'FLAG'];


// ============================================================
//  MAIN FUNCTION
// ============================================================

/**
 * Fetches current league settings from Yahoo and writes a flat
 * reference table to _LEAGUE_INFO in the Data workbook.
 *
 * Parses five sections from the Yahoo settings response:
 *   League Info    — top-level league metadata (name, season, type, etc.)
 *   General Setting — scalar settings values (max teams, trade deadline, etc.)
 *   Roster Position — each roster slot with count and position type
 *   Stat Category   — each scoring category with display name and stat ID
 *   Stat Modifier   — point value assigned to each stat category
 *   Division        — division names and IDs if the league uses divisions
 */
function updateLeagueInfo() {
  const leagueKey = getLeagueKey();
  if (!leagueKey) {
    Logger.log('updateLeagueInfo: no league key found. Aborting.');
    return;
  }

  const url  = `https://fantasysports.yahooapis.com/fantasy/v2/league/${leagueKey}/settings?format=json`;
  const data = fetchYahooAPI(url);

  if (!data || !data.fantasy_content) {
    Logger.log('updateLeagueInfo: fetch failed or empty response. Aborting.');
    return;
  }

  const basicInfo = data.fantasy_content.league?.[0];
  const settings  = data.fantasy_content.league?.[1]?.settings?.[0];

  if (!basicInfo || !settings) {
    Logger.log('updateLeagueInfo: could not parse league or settings data. Aborting.');
    return;
  }

  const outputRows = [LEAGUE_INFO_HEADERS];

  // ---- League Info ----
  Object.keys(basicInfo).forEach(key => {
    const val = basicInfo[key];
    if (val === null || typeof val !== 'object') {
      outputRows.push(['League Info', key, val, '', '', '']);
    } else if (key === 'logo' && val.url) {
      outputRows.push(['League Info', 'logo_url', val.url, '', '', '']);
    } else {
      outputRows.push(['League Info', key, JSON.stringify(val), '', '', '']);
    }
  });

  // ---- General Settings ----
  // Complex keys are parsed into their own sections below —
  // all other scalar settings are written here as General Setting rows
  const complexKeys = ['roster_positions', 'stat_categories', 'stat_modifiers', 'divisions'];

  Object.keys(settings).forEach(key => {
    const val = settings[key];
    if (val === null || typeof val !== 'object') {
      outputRows.push(['General Setting', key, val, '', '', '']);
    } else if (!complexKeys.includes(key)) {
      outputRows.push(['General Setting', key, JSON.stringify(val), '', '', '']);
    }
  });

  // ---- Roster Positions ----
  if (settings.roster_positions) {
    settings.roster_positions.forEach(item => {
      const pos     = item.roster_position;
      const posType = pos.position_type || '';
      const flag    = pos.is_bench ? 'Bench' : '';
      outputRows.push(['Roster Position', pos.position, pos.count, posType, '', flag]);
    });
  }

  // ---- Stat Categories ----
  if (settings.stat_categories?.stats) {
    settings.stat_categories.stats.forEach(item => {
      const stat     = item.stat;
      const name     = stat.name         || '';
      const abbr     = stat.display_name || stat.abbr || '';
      const statType = stat.position_type || '';
      const statId   = stat.stat_id !== undefined ? String(stat.stat_id) : '';
      const flag     = stat.is_only_display_stat == '1' ? 'Display Only' : '';
      outputRows.push(['Stat Category', name, abbr, statType, statId, flag]);
    });
  }

  // ---- Stat Modifiers ----
  if (settings.stat_modifiers?.stats) {
    settings.stat_modifiers.stats.forEach(item => {
      const stat   = item.stat;
      const statId = stat.stat_id !== undefined ? String(stat.stat_id) : '';
      outputRows.push(['Stat Modifier', 'Stat Point Value', stat.value, '', statId, '']);
    });
  }

  // ---- Divisions ----
  if (settings.divisions) {
    settings.divisions.forEach(item => {
      const div   = item.division;
      const divId = div.division_id !== undefined ? String(div.division_id) : '';
      outputRows.push(['Division', div.name, '', '', divId, '']);
    });
  }

  writeToData(LEAGUE_INFO_SHEET, outputRows);
  Logger.log('updateLeagueInfo: wrote ' + (outputRows.length - 1) + ' setting rows.');
  updateTimestamp('UPDATE_LEAGUE');
}