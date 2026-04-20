/**
 * FILE: getProspectSavantData.gs
 * PURPOSE: Fetches minor league (AAA, AA, A+, A) Savant data for 
 * both hitters and pitchers from a custom API endpoint.
 * Archives the prior year on the first run of a new season.
 *
 * READS FROM: Custom PythonAnywhere API (Parallel requests per level)
 * Archive workbook — to detect whether prior year exists
 * _IDPLAYER_MAP (Data WB) via getPlayerMaps()
 * WRITES TO:  _PS_B (Data WB) — Prospect Savant Batters
 * _PS_P (Data WB) — Prospect Savant Pitchers
 * Archive workbook — prior year snapshot on rollover
 * CALLED BY:  occasionalUpdates() in triggerGroups.gs
 * DEPENDENCIES: helperFunctions.gs, playerResolution.gs
 */

// ============================================================
//  CONSTANTS
// ============================================================

const PS_BASE_URL = "https://oriolebird.pythonanywhere.com/leaders";
const PS_LEVELS   = ["AAA", "AA", "A+", "A"];

// API parameters — format: {min_pa_or_bf}/{min_batted_balls}/{min_pitches} etc.
const PS_PARAMS_HITTERS  = "1/16/28"; 
const PS_PARAMS_PITCHERS = "1/16/28";

const PS_CATEGORIES = [
  { type: "hitters",  sheetName: "_PS_B", params: PS_PARAMS_HITTERS },
  { type: "pitchers", sheetName: "_PS_P", params: PS_PARAMS_PITCHERS }
];

const PS_TARGET_COLUMNS = [
  "IDPLAYER", "MLB_AbbName", "Position", "ab", "age", "age_days", "age_p", "ba", "babip", 
  "barrelbbe", "barrelbbe_p", "bat_speed", "bbrate", "bbrate_p", "chaserate", "chaserate_p", 
  "d_agg", "ev", "ev50", "ev50_p", "ev90", "ev90_p", "ev_p", "hhrate", "hhrate_p", "ip", 
  "iso", "krate", "krate_p", "langle", "langle_p", "level", "maxev", "maxev_p", "name", 
  "obp", "p_agg", "pa", "pitch_percent", "power_agg", "pscore", "score_p", "season", "slg", 
  "spd", "spd_p", "swing", "swing_p", "swstr", "swstr_p", "velocity", "wbsr", "wbsr_pa", 
  "wbsr_pa_p", "whiffrate", "whiffrate_p", "woba", "wobadiff", "xba", "xba_p", "xbadiff", 
  "xobp", "xobpdiff", "xslg", "xslg_p", "xslgdiff", "xwoba", "xwoba_p", "zcontact", 
  "zcontact_p", "zswing", "zswing_p"
];


// ============================================================
//  MAIN FUNCTION
// ============================================================

function getProspectSavantData() {
  const ss = getPrimarySS();
  
  // Safely execute year rollover handler if it exists in scope
  if (typeof _handleYearRollover === 'function') {
    _handleYearRollover(ss);
  }

  const currentYearRange = ss.getRangeByName("CURRENT_YEAR");
  const archiveSS = getArchiveSS();
  
  if (!currentYearRange || !archiveSS) {
    Logger.log('getProspectSavantData: Missing CURRENT_YEAR or Archive SS. Aborting.');
    return;
  }
  
  const currentYear = parseInt(currentYearRange.getValue(), 10);
  const prevYear    = currentYear - 1;
  const maps        = getPlayerMaps("MLBID"); // MLBAM is the primary ID here
  
  Logger.log(`getProspectSavantData: Fetching MiLB Savant data for ${currentYear}...`);

  PS_CATEGORIES.forEach(cat => {
    const sheetName = cat.sheetName;
    const sheetPrev = archiveSS.getSheetByName(sheetName);

    // Archive prior year if not already present
    if (!_psSheetHasYear(sheetPrev, prevYear)) {
      Logger.log(`getProspectSavantData: archiving ${cat.type} for ${prevYear}...`);
      const prevData = _getProspectSavantRows(cat.type, prevYear, maps, cat.params);
      if (prevData && prevData.length > 1) {
        writeToArchive(sheetName, prevData);
        Logger.log(`getProspectSavantData: archived ${prevData.length - 1} ${cat.type} for ${prevYear}`);
      }
    }

    // Fetch and write current year
    const currentData = _getProspectSavantRows(cat.type, currentYear, maps, cat.params);
    if (currentData && currentData.length > 1) {
      writeToData(sheetName, currentData);
      Logger.log(`getProspectSavantData: wrote ${currentData.length - 1} ${cat.type} to ${sheetName}`);
    } else {
      Logger.log(`getProspectSavantData: No data returned for ${cat.type} in ${currentYear}.`);
    }
  });

  // Flush any missing prospects to the ID Matching sheet
  flushIdMatchingQueue();
}


// ============================================================
//  FETCH AND MERGE
// ============================================================

/**
 * Fetches MiLB Savant data for a given category (hitters/pitchers) 
 * across all defined minor league levels, merges them, and resolves IDs.
 *
 * @param {string} catType - "hitters" or "pitchers"
 * @param {number} year    - Season year to fetch
 * @param {Object} maps    - Player resolution maps
 * @param {string} params  - Custom API parameter string
 * @returns {Array[]} 2D array with headers
 */
function _getProspectSavantRows(catType, year, maps, params) {
  let allRows = [PS_TARGET_COLUMNS];

  const requests = PS_LEVELS.map(level => ({
    url: `${PS_BASE_URL}/${catType}/${level}/${year}/${params}`,
    muteHttpExceptions: true
  }));

  const responses = fetchAllYahooAPI(requests); // Uses your batch fetcher for safety

  responses.forEach(response => {
    if (!response || response.getResponseCode() !== 200) return;

    const text = response.getContentText();
    const json = text ? JSON.parse(text) : null;
    const data = json?.data;

    if (data && data.length > 0) {
      data.forEach(player => {
        const mlbId = player.MLBAMId ? player.MLBAMId.toString() : null;
        
        // Strip HTML/whitespace from name and team for clean resolution
        const pName = (player.name || player.player_name || "").toString().replace(/<[^>]+>/g, '').trim();
        const teamAbbr = (player.MLB_AbbName || "").toString().replace(/<[^>]+>/g, '').trim();

        // Pass to the universal resolver (Null for platformId since this is MLBAM primary)
        const masterId = resolveMasterId(maps, null, mlbId, pName, 'getProspectSavantData', teamAbbr);

        const row = PS_TARGET_COLUMNS.map(header => {
          if (header === "IDPLAYER") return masterId;
          let val = player[header];
          
          // Strip HTML from text returns
          if (typeof val === 'string') val = val.replace(/<[^>]+>/g, '').trim();
          
          return (val !== null && val !== undefined) ? val : "";
        });
        
        allRows.push(row);
      });
    }
  });

  return allRows;
}


// ============================================================
//  ARCHIVE YEAR CHECK
// ============================================================

/**
 * Checks whether the Prospect Savant sheet in the archive workbook
 * already contains data for the given year.
 */
function _psSheetHasYear(sheet, year) {
  if (!sheet || sheet.getLastRow() < 2) return false;

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const seasonIdx = headers.indexOf("season");
  if (seasonIdx === -1) return false;

  const firstDataYear = parseInt(sheet.getRange(2, seasonIdx + 1).getValue(), 10);
  return firstDataYear === year;
}