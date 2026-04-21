/**
 * @file _utilities.gs
 * @description Operational utilities for roster management.
 * Tracks persistent acquisition statuses for keepers and optimizes daily active lineups.
 * @dependencies _helpers.gs
 * @writesTo _ACQUIRED, 'My Team' (Optimized Lineup Slots)
 */

// ============================================================================
//  SAVE ACQUIRED DATA
// ============================================================================

/**
 * Maintains a persistent log of how every player was acquired.
 * Mirrors the current _ROSTERS schema to preserve data across transactions.
 * @writesTo _ACQUIRED
 */
function saveAcquiredData() {
  const dataSS = getDataSS();
  if (!dataSS) return;

  const rosterSheet = dataSS.getSheetByName('_ROSTERS');
  if (!rosterSheet || rosterSheet.getLastRow() < 2) return;

  const rosterData = rosterSheet.getDataRange().getValues();
  const headers = rosterData[0].map(h => h.toString().trim().toUpperCase());
  
  // Strict schema match from _ROSTERS
  const iTid   = headers.indexOf('TEAM_ID');
  const iPid   = headers.indexOf('IDPLAYER');
  const iAcq   = headers.indexOf('ACQUIRED');
  const iDate  = headers.indexOf('DATE');

  // Load existing acquired data to preserve history
  const acquiredSheet = dataSS.getSheetByName('_ACQUIRED');
  const existingMap = new Map();
  if (acquiredSheet && acquiredSheet.getLastRow() > 1) {
    const existingData = acquiredSheet.getDataRange().getValues();
    const exHeaders = existingData[0].map(h => h.toString().trim().toUpperCase());
    const exTid = exHeaders.indexOf('TEAM_ID');
    const exPid = exHeaders.indexOf('IDPLAYER');
    
    for (let i = 1; i < existingData.length; i++) {
      const p = existingData[i][exPid];
      const t = existingData[i][exTid];
      if (p && t) existingMap.set(`${p}|${t}`, existingData[i]);
    }
  }

  const finalRows = [];
  const addedKeys = new Set();

  for (let i = 1; i < rosterData.length; i++) {
    const row = rosterData[i];
    const pId = row[iPid] ? row[iPid].toString().trim() : '';
    const tId = row[iTid] ? row[iTid].toString().trim() : '';
    if (!pId) continue;

    const key = `${pId}|${tId}`;
    if (addedKeys.has(key)) continue;

    if (existingMap.has(key)) {
      const exRow = existingMap.get(key);
      // Overwrite the Acquired and Date columns with freshest _ROSTERS data
      exRow[iAcq] = row[iAcq] || '';
      exRow[iDate] = row[iDate] || '';
      finalRows.push(exRow);
    } else {
      finalRows.push(row);
    }
    addedKeys.add(key);
  }

  if (finalRows.length > 0) {
    writeToData('_ACQUIRED', [rosterData[0], ...finalRows]);
  }
}

// ============================================================================
//  OPTIMIZE LINEUP
// ============================================================================

/**
 * @description Advanced lineup optimization engine. Uses a two-phase allocation 
 * to ensure IL/NA players (identified by images/non-blank cells) are a last resort.
 * @dependencies _helpers.gs
 * @writesTo 'My Team' (MY_TEAM_OPTIMIZED)
 */
function optimizeLineup() {
  const ss = getPrimarySS();
  const dataSS = getDataSS();
  if (!dataSS) return;

  // 1. FETCH DYNAMIC SLOTS FROM _LEAGUE_INFO
  const infoSheet = dataSS.getSheetByName("_LEAGUE_INFO");
  if (!infoSheet) {
    _logError('_utilities.gs', 'Missing _LEAGUE_INFO for slot generation.', 'CRITICAL');
    return;
  }
  
  // Get positions from A2:D where A = roster_positions, D is not blank
  const infoData = infoSheet.getRange("A2:D").getValues();
  let slots = [];
  infoData.forEach(row => {
    const posNameRaw = row[1]?.toString().trim();
    if (row[0] === "roster_positions" && row[3] !== "" && posNameRaw) {
      // Exclude designated Bench or Injury slots from active assignment targets
      if (!["BN", "IL", "NA"].includes(posNameRaw.toUpperCase())) {
        let count = parseInt(row[2]) || 1;
        for (let c = 0; c < count; c++) {
          // Store original name from info sheet
          slots.push(posNameRaw); 
        }
      }
    }
  });

  // 2. FETCH PLAYER DATA VIA NAMED RANGES
  const getVals = (name) => ss.getRangeByName(name)?.getValues() || [];
  const namesData = getVals("MY_TEAM_PLAYER");
  const posData   = getVals("MY_TEAM_POSITION");
  const ilData    = getVals("MY_TEAM_IL");
  const naData    = getVals("MY_TEAM_NA");
  const valData   = getVals("MY_TEAM_VALUE");
  const kRndData  = getVals("MY_TEAM_K_ROUND");
  const outRange  = ss.getRangeByName("MY_TEAM_OPTIMIZED");

  if (!namesData.length || !outRange) {
    _logError('_utilities.gs', 'Missing MY_TEAM named ranges.', 'CRITICAL');
    return;
  }

  // 3. BUILD PLAYER OBJECTS & DETECT UNAVAILABILITY (IMAGES)
  let players = [];
  for (let i = 0; i < namesData.length; i++) {
    let pName = namesData[i][0];
    if (!pName) continue;

    const ilVal = ilData[i][0];
    const naVal = naData[i][0];
    // Image detection: treated as unavailable if cell is not blank
    const isUnavail = (ilVal !== "" && ilVal !== null) || (naVal !== "" && naVal !== null);

    players.push({
      idx: i, 
      name: pName.toString(),
      // Normalize eligibility to uppercase for internal logic comparisons
      pos: posData[i][0].toString().split(',').map(p => p.trim().toUpperCase()),
      unavail: isUnavail,
      val: parseFloat(valData[i][0]),
      kRnd: parseFloat(kRndData[i][0])
    });
  }

  // 4. SORTING LOGIC (Internal Priority)
  // Value (Desc) -> Keeper Round (Asc) -> Original Row (Asc)
  players.sort((a, b) => {
    const vA = !isNaN(a.val) ? a.val : -Infinity;
    const vB = !isNaN(b.val) ? b.val : -Infinity;
    if (vA !== vB) return vB - vA;

    const kA = !isNaN(a.kRnd) ? a.kRnd : Infinity;
    const kB = !isNaN(b.kRnd) ? b.kRnd : Infinity;
    if (kA !== kB) return kA - kB;

    return a.idx - b.idx;
  });

  // 5. TWO-PHASE ALLOCATION ENGINE
  let slotUsed = new Array(slots.length).fill(false);
  let assignments = new Array(namesData.length).fill(["BN"]); 
  let usedPlayers = new Set();

  /**
   * Helper to assign a player to an open slot.
   * Performs case-insensitive matching and enforces "Util" casing.
   */
  function tryAssign(p, choices) {
    if (usedPlayers.has(p.idx)) return false;
    for (let target of choices) {
      // Find slot index using case-insensitive match
      let sIdx = slots.findIndex((s, i) => s.toUpperCase() === target.toUpperCase() && !slotUsed[i]);
      if (sIdx !== -1) {
        slotUsed[sIdx] = true;
        
        // FIX: Force "Util" casing specifically if the matched slot is Utility
        let assignedVal = slots[sIdx].toUpperCase() === "UTIL" ? "Util" : slots[sIdx];
        assignments[p.idx] = [assignedVal]; 
        
        usedPlayers.add(p.idx);
        return true;
      }
    }
    return false;
  }

  const executeAllocation = (pool) => {
    // PASS 1: Fill RP slots first
    pool.forEach(p => { if (p.pos.includes("RP")) tryAssign(p, ["RP"]); });

    // PASS 2: Place RP eligible into P slots
    pool.forEach(p => { if (p.pos.includes("RP")) tryAssign(p, ["P"]); });

    // PASS 3: Place SP eligible pitchers into SP slots
    pool.forEach(p => { if (p.pos.includes("SP")) tryAssign(p, ["SP"]); });

    // PASS 4: Place SP,RP pitchers into any remaining P/SP slots
    pool.forEach(p => {
      const isPitcher = p.pos.some(x => ["SP", "RP", "P"].includes(x));
      if (isPitcher) tryAssign(p, ["P", "SP"]);
    });

    // PASS 5: Batters into primary positions
    pool.forEach(p => {
      const isPitcher = p.pos.some(x => ["SP", "RP", "P"].includes(x));
      if (!isPitcher) {
        // Filter out utility to prioritize specific positions first
        const primaryPos = p.pos.filter(x => x !== "UTIL");
        tryAssign(p, primaryPos);
      }
    });

    // PASS 6: Remaining batters into UTIL
    pool.forEach(p => {
      const isPitcher = p.pos.some(x => ["SP", "RP", "P"].includes(x));
      if (!isPitcher) tryAssign(p, ["UTIL"]);
    });
  };

  // PHASE 1: Process Healthy Players (unavail is false)
  executeAllocation(players.filter(p => !p.unavail));

  // PHASE 2: Fill remaining gaps with Unavailable Players (Images detected)
  executeAllocation(players.filter(p => p.unavail));

  // 6. FINAL CLEANUP & WRITE
  for (let i = 0; i < namesData.length; i++) {
    if (!namesData[i][0]) assignments[i] = [""];
  }
  
  outRange.setValues(assignments);
  _updateTimestamp('UPDATE_OPTIMIZATION');
}