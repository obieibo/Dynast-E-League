/**
 * FILE: sheetResolution.gs
 * PURPOSE: A flexible, configuration-driven script that reads player names 
 * from multiple designated sheets and ranges, runs them through 
 * the universal player resolution system, and writes the resolved 
 * master IDPLAYERs back to their respective output ranges.
 * * Includes a checkbox trigger to run specific sheets on demand 
 * and unchecks the box when the process completes.
 * * DEPENDENCIES: playerResolution.gs, helperFunctions.gs
 */

// ============================================================
//  CONFIGURATION
//  Define all your sheets, input ranges, output ranges, and 
//  the specific checkbox cell to trigger the update here.
// ============================================================

const RESOLUTION_CONFIG = [
  {
    sheetName: "Pitcher List", 
    checkboxCell: "A2",
    ranges: [
      { 
        input: "F4:F103", 
        nameCol: "F",      // NEW: The column containing the player names
        logoCol: "G",      // NEW: The column containing the generated logos
        output: "A4:A103", 
        sourceName: "Pitcher List (SP)" 
      }
    ]
  },
  {
    sheetName: "Pitcher List",
    checkboxCell: "O2",
    ranges: [
      { 
        input: "S4:S103", 
        nameCol: "S", 
        logoCol: "T",      // Assuming logos for RP are in T, change as needed
        output: "O4:O103", 
        sourceName: "Pitcher List (RP)" 
      }
    ]
  }
];


// ============================================================
//  CHECKBOX TRIGGER FUNCTION (INSTALLABLE TRIGGER)
// ============================================================

/**
 * Watches for edits on the spreadsheet. If the edited cell matches 
 * a checkboxCell in our config and is set to TRUE, it runs the 
 * resolution script for that specific sheet.
 * * @param {Object} e - The event object provided by the edit trigger
 */
function checkboxResolution(e) {
  if (!e || !e.range) return;

  const sheet = e.range.getSheet();
  const sheetName = sheet.getName();
  const editedCell = e.range.getA1Notation();
  const newValue = e.value;

  // 1. Check if the new value is TRUE (checked)
  if (newValue !== "TRUE" && newValue !== true) return;

  // 2. Check if the edit happened on a configured sheet and cell
  const config = RESOLUTION_CONFIG.find(c => c.sheetName === sheetName && c.checkboxCell === editedCell);
  if (!config) return; 

  Logger.log(`checkboxResolution: Checkbox checked on ${sheetName}! Starting resolution...`);

  // 3. Load maps and process the specific sheet
  const maps = getPlayerMaps('YAHOOID'); 
  singleSheetResolution(config, sheet, maps);

  // 4. Flush the ID Matching Queue for any unresolved players
  flushIdMatchingQueue();
  
  Logger.log(`checkboxResolution: Completed resolution for ${sheetName}.`);
}


// ============================================================
//  CORE RESOLUTION LOGIC
// ============================================================

/**
 * Helper function that executes the resolution for a single sheet's config,
 * and sets the checkbox cell to FALSE when finished.
 * * @param {Object} config - The specific sheet configuration object
 * @param {Sheet} sheet - The Google Sheet object being processed
 * @param {Object} maps - The player maps loaded into memory
 */
function singleSheetResolution(config, sheet, maps) {
  let totalResolved = 0;

  // 1. Loop through every range pair defined for this specific sheet
  for (let r = 0; r < config.ranges.length; r++) {
    const rangePair = config.ranges[r];
    
    // Read the raw names from the input range
    const inputValues = sheet.getRange(rangePair.input).getValues();
    const outputValues = [];
    
    // 2. Resolve each name in the range
    for (let i = 0; i < inputValues.length; i++) {
      const playerName = inputValues[i][0]; 
      
      // NEW: Pass the sheet and column config directly to the universal resolver
      let teamInfo = "";
      if (rangePair.nameCol && rangePair.logoCol) {
        teamInfo = {
          sheetName: config.sheetName,
          nameCol: rangePair.nameCol,
          logoCol: rangePair.logoCol
        };
      }
      
      if (playerName) {
        // Pass the teamInfo object into the Universal Resolver as the 6th parameter
        const id = resolveMasterId(maps, null, null, playerName, rangePair.sourceName, teamInfo);
        outputValues.push([id]);
        totalResolved++;
      } else {
        // Keep the output array aligned with blank rows in the input
        outputValues.push([""]); 
      }
    }
    
    // 3. Write the resolved IDs back to the output range in bulk
    sheet.getRange(rangePair.output).setValues(outputValues);
  }

  // 4. UNCHECK THE BOX
  // Sets the triggering cell reference back to false
  sheet.getRange(config.checkboxCell).setValue(false);
  
  Logger.log(`  -> Processed ${totalResolved} names on ${config.sheetName}. Reset checkbox ${config.checkboxCell} to FALSE.`);
}


// ============================================================
//  BULK RUNNER (OPTIONAL)
// ============================================================

/**
 * Manually iterates through ALL sheets in the config and processes them.
 * Useful if you want to update everything at once from the menu.
 */
function allSheetsResolution() {
  Logger.log("allSheetsResolution: Starting bulk resolution for all sheets...");
  const ss = getPrimarySS();
  const maps = getPlayerMaps('YAHOOID'); 

  for (let s = 0; s < RESOLUTION_CONFIG.length; s++) {
    const config = RESOLUTION_CONFIG[s];
    const sheet = ss.getSheetByName(config.sheetName);
    
    if (sheet) {
      singleSheetResolution(config, sheet, maps);
    }
  }

  flushIdMatchingQueue();
  Logger.log("allSheetsResolution: Completed all sheets.");
}