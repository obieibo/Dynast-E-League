/**
 * @file resolveSheet.gs
 * @description Configuration-driven script that resolves player names from 
 * designated custom sheets (via checkbox triggers) to their Primary IDs.
 * @dependencies resolvePlayer.gs, _helpers.gs
 */

// ============================================================================
//  CONFIGURATION
// ============================================================================

const RESOLUTION_CONFIG = [
  {
    sheetName: "Pitcher List", 
    checkboxRange: "RESOLVE_FP_SP", // e.g., 'Pitcher List'!A2
    ranges: [
      { 
        input: "RESOLVE_PL_SP_INPUT",   // Must create this Named Range (e.g., F4:F103)
        output: "RESOLVE_PL_SP_OUTPUT", // 'Pitcher List'!A4:A103
        sourceName: "Pitcher List (SP)" 
      }
    ]
  },
  {
    sheetName: "Pitcher List",
    checkboxRange: "RESOLVE_PL_RP", // 'Pitcher List'!O2
    ranges: [
      { 
        input: "RESOLVE_PL_RP_INPUT",   // Must create this Named Range
        output: "RESOLVE_PL_RP_OUTPUT", // 'Pitcher List'!O4:O103
        sourceName: "Pitcher List (RP)" 
      }
    ]
  }
];

// ============================================================================
//  CHECKBOX TRIGGER FUNCTION (INSTALLABLE TRIGGER)
// ============================================================================

/**
 * Watches for edits. If an edited cell matches a configured checkbox,
 * runs resolution for that sheet and resets the box to FALSE.
 * @param {Object} e - Event object from Google Sheets edit trigger.
 */
function checkboxResolution(e) {
  if (!e || !e.range) return;

  const sheet = e.range.getSheet();
  const sheetName = sheet.getName();
  
  // We must check if the edited range intersects with our named ranges
  const ss = getPrimarySS();
  let matchedConfig = null;

  for (let config of RESOLUTION_CONFIG) {
    if (config.sheetName !== sheetName) continue;
    
    const targetRange = ss.getRangeByName(config.checkboxRange);
    if (!targetRange) continue;
    
    // Check if edited cell is the checkbox
    if (e.range.getRow() === targetRange.getRow() && e.range.getColumn() === targetRange.getColumn()) {
      matchedConfig = config;
      break;
    }
  }

  if (!matchedConfig) return;
  if (e.value !== "TRUE" && e.value !== true) return;

  Logger.log(`Checkbox checked on ${sheetName}! Starting resolution...`);

  const maps = getPlayerMaps('YAHOOID'); 
  _singleSheetResolution(matchedConfig, sheet, maps);
  flushIdMatchingQueue();
}

// ============================================================================
//  CORE RESOLUTION LOGIC
// ============================================================================

/**
 * Executes resolution for a single sheet config and unchecks the box.
 */
function _singleSheetResolution(config, sheet, maps) {
  const ss = getPrimarySS();
  let totalResolved = 0;

  for (let rangePair of config.ranges) {
    const inputRange = ss.getRangeByName(rangePair.input);
    const outputRange = ss.getRangeByName(rangePair.output);
    
    if (!inputRange || !outputRange) {
      _logError('resolveSheet.gs', `Missing Named Range for ${config.sheetName}`, 'HIGH');
      continue;
    }

    const inputValues = inputRange.getValues();
    const outputValues = [];
    
    for (let i = 0; i < inputValues.length; i++) {
      const playerName = inputValues[i][0]; 
      if (playerName) {
        // No platform IDs available here, passing nulls.
        const id = resolvePrimaryId(maps, null, null, null, playerName, rangePair.sourceName, null);
        outputValues.push([id]);
        totalResolved++;
      } else {
        outputValues.push([""]); 
      }
    }
    
    outputRange.setValues(outputValues);
  }

  // Reset checkbox
  ss.getRangeByName(config.checkboxRange).setValue(false);
  Logger.log(`Processed ${totalResolved} names. Checkbox reset to FALSE.`);
}

/**
 * Manually iterate through ALL sheets in the config (Menu button use).
 */
function executeAllSheetResolutions() {
  const ss = getPrimarySS();
  const maps = getPlayerMaps('YAHOOID'); 

  for (let config of RESOLUTION_CONFIG) {
    const sheet = ss.getSheetByName(config.sheetName);
    if (sheet) _singleSheetResolution(config, sheet, maps);
  }
  flushIdMatchingQueue();
}