/**
 * @file resolveSheet.gs
 * @description Configuration-driven script that resolves player names from 
 * designated custom sheets (via button clicks) to their Primary IDs.
 * @dependencies resolvePlayer.gs, _helpers.gs
 */

// ============================================================================
//  CONFIGURATION
// ============================================================================

const RESOLUTION_CONFIG = [
  {
    sheetName: "PL Pitchers", 
    // You can add as many input/output/team pairs to this array as you need!
    ranges: [
      { 
        input: "RESOLVE_PL_SP_INPUT",
        output: "RESOLVE_PL_SP_OUTPUT",
        teamInput: "RESOLVE_PL_SP_TEAM",
        sourceName: "Pitcher List (SP)" 
      },
      { 
        input: "RESOLVE_PL_RP_INPUT",
        output: "RESOLVE_PL_RP_OUTPUT",
        teamInput: "RESOLVE_PL_RP_TEAM",
        sourceName: "Pitcher List (RP)" 
      }
    ]
  },
  {
    sheetName: "PL Hitters", 
    ranges: [
      { 
        input: "RESOLVE_PL_HIT_INPUT",
        output: "RESOLVE_PL_HIT_OUTPUT", 
        teamInput: "RESOLVE_PL_HIT_TEAM",
        sourceName: "Pitcher List (Hitters)" 
      }
    ]
  },
  {
    sheetName: "Draft", 
    ranges: [
      { 
        input: "RESOLVE_DRAFT_ACTIVE_INPUT",
        output: "RESOLVE_DRAFT_ACTIVE_OUTPUT",
        teamInput: "RESOLVE_DRAFT_ACTIVE_TEAM",
        sourceName: "Draft (Active Rosters)" 
      }
    ]
  }
  // Add other sheets here as new objects following the same format
];


// ============================================================================
//  RESOLVE ACTIVE SHEET FUNCTION
// ============================================================================

/**
 * Assign this function to a drawing/button on your sheet.
 * It detects which sheet you are currently looking at, finds the matching 
 * configuration, and processes all named ranges for that specific sheet.
 */
function resolveActiveSheet() {
  const ss = getPrimarySS();
  const sheet = ss.getActiveSheet();
  const sheetName = sheet.getName();
  
  // Find the configuration that matches the sheet we are currently on
  const matchedConfig = RESOLUTION_CONFIG.find(config => config.sheetName === sheetName);

  if (!matchedConfig) {
    SpreadsheetApp.getUi().alert(`No resolution configuration found for the sheet: ${sheetName}`);
    return;
  }

  // Visual feedback so you know it's working
  ss.toast("Starting resolution. This may take a moment...", "Resolving", -1);

  const maps = getPlayerMaps('YAHOOID'); 
  let totalResolved = 0;

  // Process all input/output range pairs defined for this sheet
  for (let rangePair of matchedConfig.ranges) {
    totalResolved += _singleRangeResolution(rangePair, maps);
  }

  flushIdMatchingQueue();
  
  // Final success popup
  ss.toast(`Successfully resolved ${totalResolved} players on ${sheetName}!`, "Complete", 5);
}


// ============================================================================
//  CORE RESOLUTION LOGIC
// ============================================================================

/**
 * Executes resolution for a single input/output range pair.
 * Returns the number of players resolved.
 */
function _singleRangeResolution(rangePair, maps) {
  const ss = getPrimarySS();
  let resolvedCount = 0;

  const inputRange = ss.getRangeByName(rangePair.input);
  const outputRange = ss.getRangeByName(rangePair.output);
  
  if (!inputRange || !outputRange) {
    _logError('resolveSheet.gs', `Missing Named Range: ${rangePair.input} or ${rangePair.output}`, 'HIGH');
    return 0;
  }

  const inputValues = inputRange.getValues();
  const outputValues = [];
  
  // ---> NEW LOGIC: Fetch team abbreviations if a Named Range was provided <---
  let teamValues = null;
  if (rangePair.teamInput) {
    const teamRange = ss.getRangeByName(rangePair.teamInput);
    if (teamRange) {
      teamValues = teamRange.getValues();
    } else {
      _logError('resolveSheet.gs', `Missing Named Range: ${rangePair.teamInput}. Continuing without teams.`, 'MEDIUM');
    }
  }
  
  for (let i = 0; i < inputValues.length; i++) {
    const playerName = inputValues[i][0]; 
    const teamName = teamValues ? teamValues[i][0] : null; // Extract team name if we have it
    
    if (playerName) {
      // Resolve the player name to the Master ID, passing the teamName at the end
      const id = resolvePrimaryId(maps, null, null, null, playerName, rangePair.sourceName, teamName);
      outputValues.push([id]);
      resolvedCount++;
    } else {
      // If the input row is blank, ensure the output row is blank
      outputValues.push([""]); 
    }
  }
  
  // Write all IDs back to the sheet in one fast batch
  outputRange.setValues(outputValues);
  
  return resolvedCount;
}

/**
 * Manually iterate through ALL sheets in the config.
 * You can assign this to a custom menu button if you want to resolve everything at once.
 */
function executeAllSheetResolutions() {
  const ss = getPrimarySS();
  const maps = getPlayerMaps('YAHOOID'); 
  let totalAcrossAll = 0;

  ss.toast("Starting master resolution for all sheets...", "Processing", -1);

  for (let config of RESOLUTION_CONFIG) {
    for (let rangePair of config.ranges) {
      totalAcrossAll += _singleRangeResolution(rangePair, maps);
    }
  }
  
  flushIdMatchingQueue();
  ss.toast(`Master resolution complete! Processed ${totalAcrossAll} players across all sheets.`, "Done", 5);
}