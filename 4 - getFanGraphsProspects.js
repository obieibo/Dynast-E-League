/**
 * FILE: getFanGraphsProspects.gs
 * PURPOSE: Fetches the FanGraphs prospect board data for both the 
 * standard report and updated rankings. 
 * Archives the prior year on the first run of a new season.
 *
 * READS FROM: FanGraphs Prospects API (Parallel requests)
 * Archive workbook — to detect whether prior year exists
 * _IDPLAYER_MAP (Data WB) via getPlayerMaps()
 * WRITES TO:  _FG_PROSP (Data WB) — prospect data, current year
 * Archive workbook — prior year snapshot on rollover
 * CALLED BY:  occasionalUpdates() in triggerGroups.gs
 * DEPENDENCIES: helperFunctions.gs, playerResolution.gs
 *
 * OUTPUT SCHEMA (_FG_PROSP):
 * Col A   IDPLAYER    — Master BBREF ID
 * Col B   Type        — Board Name (e.g., Prospect_List_Report)
 * Col C   Season      — Season year
 * Col D+  [STAT COLS] — Explicitly defined prospect traits (ETA, FV, etc.)
 */

// ============================================================
//  CONSTANTS
// ============================================================

const FG_PROSP_SHEET = '_FG_PROSP';
const FG_PROSP_BASE  = 'https://www.fangraphs.com/api/prospects/board/data';

// Explicit columns matching the FanGraphs API JSON keys
const FG_PROSP_COLUMNS = [
  "IDPLAYER", "Type", "Season", "playerName", "Age", "Height", "Weight", "Bats", "Throws", 
  "Team", "llevel", "mlevel", "Position", "Ovr_Rank", "Org_Rank", "FV_Current", "ETA_Current", 
  "School", "Summary", "pHit", "fHit", "pGame", "fGame", "pRaw", "fRaw", "pSpd", "fSpd", 
  "pFld", "fFld", "pArm", "Variance", "BirthDate", "TLDR", "Athleticism", "Frame", 
  "Performer", "Dist_Raw", "Player_Type", "Amateur_Rk", "Signed_Yr", "Signed_Mkt", 
  "Signed_Org", "Draft_Rnd", "School_Type", "Country", "Pitch_Sel", "Bat_Ctrl", 
  "Fantasy_Redraft", "Fantasy_Dynasty", "HardHit%", "Levers", "Versatility", "Contact_Style", 
  "Vel", "pFB", "fFB", "pSL", "fSL", "pCB", "fCB", "pCH", "fCH", "pCT", "fCT", "pCMD", "fCMD", 
  "Range", "Touch", "Delivery", "FBType", "pSPL", "fSPL", "bRPM", "fRPM", "TJDate"
];

const FG_PROSP_OPTIONS = {
  muteHttpExceptions: true,
  headers: {
    'User-Agent': 'Mozilla/5.0',
    'Accept': 'application/json',
    'Referer': 'https://www.fangraphs.com/'
  }
};


// ============================================================
//  MAIN FUNCTION
// ============================================================

function getFanGraphsProspects() {
  const ss = getPrimarySS();
  
  // Safely execute your rollover handler if it exists in scope
  if (typeof _handleYearRollover === 'function') {
    _handleYearRollover(ss);
  }

  const currentYear = parseInt(ss.getRangeByName("CURRENT_YEAR")?.getValue(), 10);

  if (!currentYear) {
    Logger.log('getFanGraphsProspects: CURRENT_YEAR not found. Aborting.');
    return;
  }

  const prevYear  = currentYear - 1;
  const maps      = getPlayerMaps('IDFANGRAPHS');
  const archiveSS = getArchiveSS();

  // Archive prior year if not already present
  if (archiveSS) {
    const archiveSheet = archiveSS.getSheetByName(FG_PROSP_SHEET);
    if (!_fgProspSheetHasYear(archiveSheet, prevYear)) {
      Logger.log('getFanGraphsProspects: archiving ' + prevYear + '...');
      const prevData = _fetchProspectData(prevYear, maps);
      if (prevData && prevData.length > 1) {
        writeToArchive(FG_PROSP_SHEET, prevData);
        Logger.log('getFanGraphsProspects: archived ' + (prevData.length - 1) + ' prospects for ' + prevYear);
      }
    }
  }

  // Fetch and write current year
  const currentData = _fetchProspectData(currentYear, maps);
  if (!currentData || currentData.length <= 1) {
    Logger.log('getFanGraphsProspects: no data returned for ' + currentYear + '. Aborting write.');
    return;
  }

  writeToData(FG_PROSP_SHEET, currentData);
  Logger.log('getFanGraphsProspects: wrote ' + (currentData.length - 1) + ' prospects for ' + currentYear);
  updateTimestamp('UPDATE_FG_PROSP');
  
  // Flush unresolvable prospects to the ID Matching Sheet
  flushIdMatchingQueue();
}


// ============================================================
//  FETCH AND MERGE
// ============================================================

/**
 * Fetches prospect data for a given year across multiple board 
 * types and parses them into a standardized 2D array.
 *
 * @param  {number} year - Season year to fetch
 * @param  {Object} maps - Player resolution maps
 * @returns {Array[]|null} 2D array with headers
 */
function _fetchProspectData(year, maps) {
  const outputData = [FG_PROSP_COLUMNS];

  const boards = [
    { draftId: `${year}prospect`, name: "Prospect_List_Report" },
    { draftId: `${year}updated`,  name: "Prospect_List_Updated" }
  ];

  const requests = boards.map(board => ({
    url: `${FG_PROSP_BASE}?draft=${board.draftId}&season=${year}&playerid=&position=&team=&type=0`,
    ...FG_PROSP_OPTIONS
  }));

  const responses = UrlFetchApp.fetchAll(requests);

  responses.forEach((response, index) => {
    if (!response || response.getResponseCode() !== 200) return;

    const text = response.getContentText();
    const data = text ? JSON.parse(text) : null;
    let playerList = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);

    playerList.forEach(player => {
      // Inject our custom tracking columns
      player["Type"]   = boards[index].name;
      player["Season"] = year;
      
      const fgId  = player["PlayerId"] ? player["PlayerId"].toString() : "";
      const mlbId = player["xMLBAMID"] ? player["xMLBAMID"].toString() : null; // Occasionally available in FG APIs
      
      // Clean HTML out of the identity variables before resolving
      const pName    = (player["playerName"] || "").toString().replace(/<[^>]+>/g, '').trim();
      const teamAbbr = (player["Team"] || "").toString().replace(/<[^>]+>/g, '').trim();

      // Resolve the master ID!
      player["IDPLAYER"] = resolveMasterId(maps, fgId, mlbId, pName, 'getFanGraphsProspects', teamAbbr);

      // Build the row dynamically based on the explicit column list
      const rowData = FG_PROSP_COLUMNS.map(key => {
        let val = player[key];
        // Strip HTML from all text string values
        if (typeof val === 'string') {
          val = val.replace(/<[^>]+>/g, '').trim();
        }
        return (val !== null && val !== undefined) ? val : "";
      });
      
      outputData.push(rowData);
    });
  });

  return outputData;
}


// ============================================================
//  ARCHIVE YEAR CHECK
// ============================================================

/**
 * Checks whether the Prospect sheet in the archive workbook
 * already contains data for the given year. Looks for the 'Season'
 * column in the header row and checks the first data row.
 */
function _fgProspSheetHasYear(sheet, year) {
  if (!sheet || sheet.getLastRow() < 2) return false;

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const yearIdx = headers.indexOf('Season'); // Season is in Col C
  if (yearIdx === -1) return false;

  const firstDataYear = parseInt(sheet.getRange(2, yearIdx + 1).getValue(), 10);
  return firstDataYear === year;
}