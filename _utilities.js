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
//  OPTIMIZE ACTIVE LINEUPS
// ============================================================================

/**
 * Optimizes the active lineup on the 'My Team' dashboard.
 * Uses a strict 5-tier sorting algorithm and named ranges to assign positions.
 * @writesTo 'My Team' (MY_TEAM_OPTIMIZED)
 */
function optimizeActiveLineups() {
  const ss = getPrimarySS();
  const dataSS = getDataSS();
  if (!dataSS) return;

  // 1. Fetch Dynamic Slots from _LEAGUE_INFO
  const infoSheet = dataSS.getSheetByName("_LEAGUE_INFO");
  if (!infoSheet) {
    _logError('_utilities.gs', 'Missing _LEAGUE_INFO for slot generation.', 'CRITICAL');
    return;
  }
  const infoData = infoSheet.getRange("A2:C").getValues();
  let slots = [];
  infoData.forEach(row => {
    if (row[0] === "Roster Position" && row[1] !== "BN" && row[1] !== "") {
      let count = parseInt(row[2]) || 1;
      for (let c = 0; c < count; c++) slots.push(row[1]);
    }
  });

  // 2. Fetch Player Data via Named Ranges
  const getVals = (name) => ss.getRangeByName(name)?.getValues() || [];
  const namesData = getVals("MY_TEAM_PLAYER");
  const posData   = getVals("MY_TEAM_POSITION");
  const ilData    = getVals("MY_TEAM_IL");
  const naData    = getVals("MY_TEAM_NA");
  const valData   = getVals("MY_TEAM_VALUE");
  const kRndData  = getVals("MY_TEAM_K_ROUND");
  const acqData   = getVals("MY_TEAM_ACQUIRE");
  const outRange  = ss.getRangeByName("MY_TEAM_OPTIMIZED");

  if (!namesData.length || !outRange) {
    _logError('_utilities.gs', 'Missing MY_TEAM named ranges.', 'CRITICAL');
    return;
  }

  // 3. Build Player Objects
  let players = [];
  for (let i = 0; i < namesData.length; i++) {
    // Handle 2-column MY_TEAM_PLAYER range (Use first column text)
    let pName = Array.isArray(namesData[i]) ? namesData[i][0] : namesData[i];
    if (!pName) continue;

    players.push({
      idx: i, 
      name: pName.toString(),
      pos: (posData[i]?.[0] || "").toString().split(',').map(p => p.trim()),
      unavail: (ilData[i]?.[0] === true || naData[i]?.[0] === true || ilData[i]?.[0] === "TRUE"),
      val: parseFloat(valData[i]?.[0]),
      kRnd: parseFloat(kRndData[i]?.[0]),
      acq: (acqData[i]?.[0] || "").toString()
    });
  }

  // 4. Multi-Tier Sorting Algorithm
  players.sort((a, b) => {
    // Tier 1: Value (Desc)
    const vA = !isNaN(a.val) ? a.val : -Infinity;
    const vB = !isNaN(b.val) ? b.val : -Infinity;
    if (vA !== vB) return vB - vA;

    // Tier 2: Keeper Round (Asc)
    const kA = !isNaN(a.kRnd) ? a.kRnd : Infinity;
    const kB = !isNaN(b.kRnd) ? b.kRnd : Infinity;
    if (kA !== kB) return kA - kB;

    // Tier 3: Acquisition Numerical (Asc)
    const acqNumA = parseFloat(a.acq), acqNumB = parseFloat(b.acq);
    const hasNumA = !isNaN(acqNumA), hasNumB = !isNaN(acqNumB);
    if (hasNumA && !hasNumB) return -1;
    if (!hasNumA && hasNumB) return 1;
    if (hasNumA && hasNumB && acqNumA !== acqNumB) return acqNumA - acqNumB;

    // Tier 4: Acquisition Text Rank (Trade > FA/W > Other)
    const getRank = (str) => {
      const s = str.toLowerCase();
      if (s.includes('trade')) return 1;
      if (s === 'fa' || s === 'w' || s.includes('waiver') || s.includes('free')) return 2;
      return 3;
    };
    const rankA = getRank(a.acq), rankB = getRank(b.acq);
    if (rankA !== rankB) return rankA - rankB;

    // Tier 5: Alphabetical A-Z
    return a.name.localeCompare(b.name);
  });

  // 5. Allocate Slots
  let slotUsed = new Array(slots.length).fill(false);
  let assignments = new Array(namesData.length).fill(["BN"]); 
  let used = new Set();

  function assign(p, choices) {
    for (let target of choices) {
      let idx = slots.findIndex((s, i) => s === target && !slotUsed[i]);
      if (idx !== -1) {
        slotUsed[idx] = true;
        assignments[p.idx] = [target];
        used.add(p.name);
        return true;
      }
    }
    return false;
  }

  // Pass 1-3: Pitchers (Pure RP -> Dual SP/RP -> Pure SP)
  players.forEach(p => {
    if (p.unavail || used.has(p.name)) return;
    const isSP = p.pos.includes("SP"), isRP = p.pos.includes("RP") || p.pos.includes("P");
    if (isRP && !isSP) assign(p, ["RP", "P"]);
  });
  players.forEach(p => {
    if (p.unavail || used.has(p.name)) return;
    const isSP = p.pos.includes("SP"), isRP = p.pos.includes("RP") || p.pos.includes("P");
    if (isRP && isSP) assign(p, ["RP", "P", "SP"]);
  });
  players.forEach(p => {
    if (p.unavail || used.has(p.name)) return;
    const isSP = p.pos.includes("SP"), isRP = p.pos.includes("RP") || p.pos.includes("P");
    if (isSP && !isRP) assign(p, ["SP", "P"]);
  });

  // Pass 4-6: Batters (Strict 1-Pos -> Primary -> Flex)
  players.forEach(p => {
    if (p.unavail || used.has(p.name)) return;
    const isP = p.pos.some(x => ["SP","RP","P"].includes(x));
    if (!isP && p.pos.length === 1) assign(p, [p.pos[0]]);
  });
  players.forEach(p => {
    if (p.unavail || used.has(p.name)) return;
    const isP = p.pos.some(x => ["SP","RP","P"].includes(x));
    if (!isP) assign(p, p.pos);
  });
  players.forEach(p => {
    if (p.unavail || used.has(p.name)) return;
    const isP = p.pos.some(x => ["SP","RP","P"].includes(x));
    if (!isP) {
      let done = false;
      for (let pos of p.pos) {
        if (["1B", "3B"].includes(pos)) done = assign(p, ["CI"]);
        else if (["2B", "SS"].includes(pos)) done = assign(p, ["MI"]);
        if (done) break;
      }
      if (!done) assign(p, ["UTIL"]);
    }
  });

  // Clear blanks
  for (let i = 0; i < namesData.length; i++) {
    let pName = Array.isArray(namesData[i]) ? namesData[i][0] : namesData[i];
    if (!pName) assignments[i] = [""];
  }
  
  // Write
  outRange.setValues(assignments);
}