/**
 * FILE: getFanGraphsPitch.gs
 * PURPOSE: Fetches cumulative season pitching statistics from the
 * FanGraphs leaderboard API across multiple stat groups and
 * writes a merged table to _FG_P in the Data workbook.
 * Archives the prior year on first run of a new season.
 *
 * READS FROM: FanGraphs leaderboard API (Parallel requests per year)
 * Archive workbook — to detect whether prior year exists
 * _IDPLAYER_MAP (Data WB) via getPlayerMaps()
 * WRITES TO:  _FG_P (Data WB) — merged pitching stats, current year
 * Archive workbook — prior year snapshot on rollover
 * CALLED BY:  occasionalUpdates() in triggerGroups.gs
 * DEPENDENCIES: helperFunctions.gs, playerResolution.gs
 *
 * OUTPUT SCHEMA (_FG_P):
 * Col A   IDPLAYER    — Master BBREF ID
 * Col B   IDFANGRAPHS — FanGraphs player ID
 * Col C   YEAR        — Season year
 * Col D+  [STAT COLS] — Explicitly defined stat columns (ERA, WHIP, Stuff+, etc.)
 */

// ============================================================
//  CONSTANTS
// ============================================================

const FG_PITCH_SHEET = '_FG_P';

const FG_PITCH_BASE = 'https://www.fangraphs.com/api/leaders/major-league/data';

// The specific stat pages to fetch from FanGraphs
const FG_PITCH_TYPES = [0, 1, 2, 23, 24, 36, 44];

// Final output headers for _FG_P
const FG_PITCH_HEADERS = [
  "IDPLAYER", "IDFANGRAPHS", "YEAR", "Name", "Team",
  "W", "L", "ERA", "G", "GS", "QS", "CG", "SV", "HLD", "BS", "IP", "TBF", "H", "R", "ER", "HR", "BB", "IBB", "HBP", "SO",
  "K/9", "BB/9", "K/BB", "HR/9", "K%", "BB%", "K-BB%", 
  "WHIP", "BABIP", "FIP", "E-F", "xFIP", "SIERA", 
  "GB/FB", "LD%", "GB%", "FB%", "IFFB%", "HR/FB",
  "EV", "EV90", "LA", "Barrel%", "HardHit%", "xERA",
  "sp_stuff", "sp_location", "sp_pitching"
];

// The exact JSON keys to extract from the FanGraphs API responses
const FG_PITCH_KEYS = [
  "Name", "TeamNameAbb",
  "W", "L", "ERA", "G", "GS", "QS", "CG", "SV", "HLD", "BS", "IP", "TBF", "H", "R", "ER", "HR", "BB", "IBB", "HBP", "SO",
  "K/9", "BB/9", "K/BB", "HR/9", "K%", "BB%", "K-BB%", 
  "WHIP", "BABIP", "FIP", "E-F", "xFIP", "SIERA", 
  "GB/FB", "LD%", "GB%", "FB%", "IFFB%", "HR/FB", 
  "EV", "EV90", "LA", "Barrel%", "HardHit%", "xERA",
  "sp_stuff", "sp_location", "sp_pitching"
];


// ============================================================
//  MAIN FUNCTION
// ============================================================

/**
 * Fetches required pitching stat groups from FanGraphs for the
 * current year, merges them by player ID, resolves BBREF IDs,
 * and writes the result to _FG_P. Archives prior year if needed.
 */
function getFanGraphsPitch() {
  const ss          = getPrimarySS();
  const currentYear = parseInt(ss.getRangeByName("CURRENT_YEAR")?.getValue(), 10);

  if (!currentYear) {
    Logger.log('getFanGraphsPitch: CURRENT_YEAR not found. Aborting.');
    return;
  }

  const prevYear  = currentYear - 1;
  const maps      = getPlayerMaps('IDFANGRAPHS');
  const archiveSS = getArchiveSS();

  // Archive prior year if not already present
  if (archiveSS) {
    const archiveSheet = archiveSS.getSheetByName(FG_PITCH_SHEET);
    if (!_fgPitchSheetHasYear(archiveSheet, prevYear)) {
      Logger.log('getFanGraphsPitch: archiving ' + prevYear + '...');
      const prevData = _fetchAndMergeFgPitch(prevYear, maps);
      if (prevData && prevData.length > 1) {
        writeToArchive(FG_PITCH_SHEET, prevData);
        Logger.log('getFanGraphsPitch: archived ' + (prevData.length - 1) + ' pitchers for ' + prevYear);
      }
    }
  }

  // Fetch and write current year
  const currentData = _fetchAndMergeFgPitch(currentYear, maps);
  if (!currentData || currentData.length <= 1) {
    Logger.log('getFanGraphsPitch: no data returned for ' + currentYear + '. Aborting write.');
    return;
  }

  writeToData(FG_PITCH_SHEET, currentData);
  Logger.log('getFanGraphsPitch: wrote ' + (currentData.length - 1) + ' pitchers for ' + currentYear);
  updateTimestamp('UPDATE_FG_PITCH');
  
  // Flush unresolvable players to the ID Matching Sheet
  flushIdMatchingQueue();
}


// ============================================================
//  FETCH AND MERGE
// ============================================================

/**
 * Fetches pitching stat groups for a given year in parallel and 
 * merges them into a single wide table keyed by FanGraphs player ID. 
 *
 * @param  {number} year - Season year to fetch
 * @param  {Object} maps - Player resolution maps
 * @returns {Array[]|null} 2D array with headers, or null on failure
 */
function _fetchAndMergeFgPitch(year, maps) {
  // Build API requests
  const requests = FG_PITCH_TYPES.map(type => {
    const params = [
      "age=", "pos=all", "stats=pit", "lg=all", "qual=0",
      `season=${year}`, `season1=${year}`, `startdate=${year}-03-01`, `enddate=${year}-11-01`,
      "month=0", "hand=", "team=0", "pageitems=20000", "pagenum=1",
      "ind=0", "rost=0", "players=", `type=${type}`, "postseason=",
      "sortdir=default", "sortstat=sp_pitching"
    ].join("&");

    return {
      url: FG_PITCH_BASE + "?" + params,
      method: "get",
      muteHttpExceptions: true,
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'application/json',
        'Referer': 'https://www.fangraphs.com/'
      }
    };
  });

  const responses = UrlFetchApp.fetchAll(requests);
  const playerMap = {};
  let anyData = false;

  // Parse and merge responses
  responses.forEach(response => {
    if (response.getResponseCode() !== 200) return;
    
    const json = JSON.parse(response.getContentText());
    if (!json?.data || json.data.length === 0) return;

    anyData = true;
    json.data.forEach(row => {
      let pid = row.playerid;
      if (!pid) return;

      if (!playerMap[pid]) {
        playerMap[pid] = {};
      }
      // Merge new columns into the existing player object
      Object.assign(playerMap[pid], row);
    });
  });

  if (!anyData) {
    Logger.log('_fetchAndMergeFgPitch: all groups failed for ' + year + '.');
    return null;
  }

  // Build the output array using the requested keys
  const outputData = [FG_PITCH_HEADERS];

  Object.values(playerMap).forEach(row => {
    const fgId  = row.playerid ? row.playerid.toString() : "";
    const mlbId = row.xMLBAMID ? row.xMLBAMID.toString() : null;
    
    // Strip HTML tags from names and teams
    const pName = row.Name ? row.Name.toString().replace(/<[^>]+>/g, '').trim() : "";
    const teamAbbr = row.TeamNameAbb ? row.TeamNameAbb.toString().replace(/<[^>]+>/g, '').trim() : "";
    
    // Pass everything into the universal resolver!
    const masterId = resolveMasterId(maps, fgId, mlbId, pName, 'getFanGraphsPitch', teamAbbr);

    // Map the explicit JSON keys to the output row array
    const stats = FG_PITCH_KEYS.map(key => {
      let val = row[key];
      if (typeof val === 'string') val = val.replace(/<[^>]+>/g, '').trim();
      return (val !== null && val !== undefined) ? val : "";
    });
    
    outputData.push([masterId, fgId, year, ...stats]);
  });

  return outputData;
}


// ============================================================
//  ARCHIVE YEAR CHECK
// ============================================================

/**
 * Checks whether a FanGraphs sheet in the archive workbook
 * already contains data for the given year.
 */
function _fgPitchSheetHasYear(sheet, year) {
  if (!sheet || sheet.getLastRow() < 2) return false;

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const yearIdx = headers.indexOf('YEAR');
  if (yearIdx === -1) return false;

  const firstDataYear = parseInt(sheet.getRange(2, yearIdx + 1).getValue(), 10);
  return firstDataYear === year;
}