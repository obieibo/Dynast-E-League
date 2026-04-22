/**
 * @file _calibration.gs
 * @description The empirical calibration engine. Dynamically calculates SGP denominators,
 * rate stat baselines, and positional replacement levels based on your specific 
 * 12-team league history and active roster settings.
 * @dependencies _helpers.gs
 * @writesTo Named Ranges in Primary Workbook (WEIGHTS_FACTORS, WEIGHTS_BASELINES, WEIGHTS_RLP_RANKS)
 */

// ============================================================================
//  MAIN EXECUTION WRAPPER
// ============================================================================

/**
 * Runs all calibration engines and updates the primary workbook named ranges.
 */
function runAllCalibrations() {
  Logger.log("Starting empirical league calibration...");
  
  _calibrateSGPFactors();
  _calibrateBaselines();
  _calibrateReplacementLevels();
  
  _updateTimestamp('UPDATE_CALIBRATION'); // Assuming you add this named range
  Logger.log("Calibration complete.");
}

// ============================================================================
//  1. SGP DENOMINATOR CALIBRATION
// ============================================================================

/**
 * Calculates empirical SGP denominators from historical _TEAM_STATS.
 * Updates the WEIGHTS_FACTORS named range.
 */
function _calibrateSGPFactors() {
  const archiveSS = getArchiveSS();
  const primarySS = getPrimarySS();
  if (!archiveSS || !primarySS) return;

  const teamStatsSheet = archiveSS.getSheetByName('_TEAM_STATS');
  if (!teamStatsSheet || teamStatsSheet.getLastRow() < 2) {
    Logger.log("Not enough historical data to calibrate SGP factors. Skipping.");
    return;
  }

  const data = teamStatsSheet.getDataRange().getValues();
  const headers = data[0].map(h => h.toString().trim().toUpperCase());
  
  // Stats we need to calculate denominators for
  const targetStats = ["R", "HR", "RBI", "SB", "OPS", "K", "QS", "SV", "HLD", "ERA", "WHIP"];
  const empiricalFactors = {};

  targetStats.forEach(stat => {
    // Handle split categories like NSB (Net Stolen Bases) or NSVH (Net Saves + Holds)
    let colIdx1 = -1, colIdx2 = -1;
    let isSplit = false, isInverse = false;
    
    if (stat === "SB") colIdx1 = headers.indexOf("SB"); // Assume SB maps to NSB if CS isn't tracked historically
    else if (stat === "SV" || stat === "HLD") {
      colIdx1 = headers.indexOf("SV");
      colIdx2 = headers.indexOf("HLD");
      isSplit = true;
    } else {
      colIdx1 = headers.indexOf(stat);
    }
    
    if (stat === "ERA" || stat === "WHIP") isInverse = true; // Lower is better

    if (colIdx1 === -1 && !isSplit) return;

    // Extract all team totals for this stat across all available historical years
    const yearTotals = {};
    for (let i = 1; i < data.length; i++) {
      const year = data[i][0];
      if (!yearTotals[year]) yearTotals[year] = [];
      
      let val = 0;
      if (isSplit && colIdx1 > -1 && colIdx2 > -1) {
        val = (parseFloat(data[i][colIdx1]) || 0) + (parseFloat(data[i][colIdx2]) || 0);
      } else if (colIdx1 > -1) {
        val = parseFloat(data[i][colIdx1]) || 0;
      }
      yearTotals[year].push(val);
    }

    // Calculate the SGP Gap for each year (1st place vs 12th place)
    let totalGap = 0;
    let validYears = 0;

    Object.keys(yearTotals).forEach(year => {
      let totals = yearTotals[year].sort((a, b) => isInverse ? a - b : b - a);
      if (totals.length >= 12) {
        const top = totals[0]; // 1st place
        const bottom = totals[11]; // 12th place
        const gap = Math.abs(top - bottom);
        
        // Divide the gap by 11 to find the value of exactly 1 standings point
        totalGap += (gap / 11); 
        validYears++;
      }
    });

    if (validYears > 0) {
      let finalFactor = totalGap / validYears;
      
      // SCARCITY ADJUSTMENT: 
      // Saves/Holds and Stolen Bases are hoarded by fewer players. 
      // We reduce the denominator slightly (multiplying by ~0.85) to reflect that 
      // an elite SB/SV guy is mathematically scarcer than an elite HR guy.
      if (stat === "SB" || stat === "SV" || stat === "HLD") finalFactor *= 0.85;

      empiricalFactors[stat] = finalFactor;
    }
  });

  // Write factors back to the WEIGHTS_FACTORS named range
  const factorsRange = primarySS.getRangeByName("WEIGHTS_FACTORS");
  const categoriesRange = primarySS.getRangeByName("WEIGHTS_CATEGORIES");
  
  if (factorsRange && categoriesRange) {
    const categories = categoriesRange.getValues();
    const newFactors = [];
    
    categories.forEach(row => {
      const cat = row[0]?.toString().trim();
      let factorValue = "";
      
      if (cat === "NSB" && empiricalFactors["SB"]) factorValue = empiricalFactors["SB"].toFixed(3);
      else if (cat === "NSVH" && empiricalFactors["SV"]) factorValue = empiricalFactors["SV"].toFixed(3);
      else if (empiricalFactors[cat]) factorValue = empiricalFactors[cat].toFixed(3);
      else factorValue = 1; // Fallback
      
      newFactors.push([factorValue]);
    });
    
    factorsRange.setValues(newFactors);
  }
}

// ============================================================================
//  2. RATE STAT BASELINE CALIBRATION
// ============================================================================

/**
 * Calculates league average rate stats (ERA, WHIP, OPS) dynamically from the top 
 * projected players to ensure SGP formulas reflect the actual player pool environment.
 * Updates WEIGHTS_BASELINES.
 */
function _calibrateBaselines() {
  const dataSS = getDataSS();
  const primarySS = getPrimarySS();
  if (!dataSS || !primarySS) return;

  const blendSheet = dataSS.getSheetByName('_BLEND');
  if (!blendSheet || blendSheet.getLastRow() < 2) return;

  const data = blendSheet.getDataRange().getValues();
  const headers = data[0].map(h => h.toString().trim().toUpperCase());
  
  const getCol = (name) => headers.indexOf(name);
  
  // Aggregate stats to find the true mean of the rosterable universe
  let totalPA = 0, totalOBP_PA = 0, totalSLG_PA = 0;
  let totalIP = 0, totalER = 0, totalWH = 0;

  // We only want to look at the top ~160 hitters and top ~120 pitchers (standard 12-team active depth)
  let hitters = [];
  let pitchers = [];

  for (let i = 1; i < data.length; i++) {
    const type = data[i][getCol("TYPE")];
    if (type === "Batter") hitters.push(data[i]);
    if (type === "Pitcher") pitchers.push(data[i]);
  }

  // Sort by PA and IP to grab the players who will actually play
  hitters.sort((a, b) => (b[getCol("PA")] || 0) - (a[getCol("PA")] || 0));
  pitchers.sort((a, b) => (b[getCol("IP")] || 0) - (a[getCol("IP")] || 0));

  hitters.slice(0, 160).forEach(row => {
    const pa = parseFloat(row[getCol("PA")]) || 0;
    // We recreate OBP and SLG math from OPS just for the aggregate baseline
    const ops = parseFloat(row[getCol("OPS")]) || 0; 
    totalPA += pa;
    totalOBP_PA += (ops * pa); // Using OPS as a proxy weight for the baseline mean
  });

  pitchers.slice(0, 120).forEach(row => {
    const ip = parseFloat(row[getCol("IP")]) || 0;
    const era = parseFloat(row[getCol("ERA")]) || 0;
    const whip = parseFloat(row[getCol("WHIP")]) || 0;
    
    totalIP += ip;
    totalER += (era * ip) / 9;
    totalWH += (whip * ip);
  });

  const baselineOPS = totalPA > 0 ? (totalOBP_PA / totalPA) : 0.750;
  const baselineERA = totalIP > 0 ? (totalER * 9) / totalIP : 3.80;
  const baselineWHIP = totalIP > 0 ? (totalWH / totalIP) : 1.20;

  const baselinesRange = primarySS.getRangeByName("WEIGHTS_BASELINES");
  if (baselinesRange) {
    const currentBaselines = baselinesRange.getValues();
    const newBaselines = currentBaselines.map(row => {
      const stat = row[0]?.toString().trim();
      if (stat === "OPS") return [stat, baselineOPS.toFixed(3)];
      if (stat === "ERA") return [stat, baselineERA.toFixed(2)];
      if (stat === "WHIP") return [stat, baselineWHIP.toFixed(2)];
      return row;
    });
    baselinesRange.setValues(newBaselines);
  }
}

// ============================================================================
//  3. POSITIONAL REPLACEMENT LEVEL CALIBRATION
// ============================================================================

/**
 * Calculates how deep into each position the league goes before hitting the waiver wire.
 * Uses _LEAGUE_INFO roster slot data. Updates WEIGHTS_RLP_RANKS.
 */
function _calibrateReplacementLevels() {
  const dataSS = getDataSS();
  const primarySS = getPrimarySS();
  if (!dataSS || !primarySS) return;

  const infoSheet = dataSS.getSheetByName("_LEAGUE_INFO");
  if (!infoSheet) return;

  const infoData = infoSheet.getDataRange().getValues();
  const numTeams = 12; // Assuming 12 teams, can also be dynamically pulled if tracked
  
  // Read exactly how many slots exist per position
  const activeSlots = {};
  let totalBench = 0;
  let totalUtil = 0;

  infoData.forEach(row => {
    if (row[0] === "roster_positions" && row[3] !== "") {
      const pos = row[1]?.toString().trim().toUpperCase();
      const count = parseInt(row[2]) || 0;
      
      if (pos === "BN") totalBench += count;
      else if (pos === "UTIL") totalUtil += count;
      else if (pos !== "IL" && pos !== "NA") activeSlots[pos] = count;
    }
  });

  const rlpRanks = {};

  // Standard Formula: (Slots * 12 Teams) + (Bench Buffer)
  // For specialized positions (C, 1B), teams rarely roster bench depth.
  // For MI/CI/OF and Pitchers, they absorb most of the bench/utility spots.

  Object.keys(activeSlots).forEach(pos => {
    let baseDrafted = activeSlots[pos] * numTeams;
    let buffer = 0;

    if (pos === "C") buffer = 0; // Nobody drafts bench catchers
    else if (pos === "1B" || pos === "3B" || pos === "CI") buffer = 2; 
    else if (pos === "2B" || pos === "SS" || pos === "MI") buffer = 2;
    else if (pos === "OF") buffer = 6; // Outfielders eat up Util and Bench spots
    else if (pos === "SP" || pos === "RP" || pos === "P") {
      // Pitchers take up ~60% of the bench typically
      buffer = Math.round((totalBench * numTeams) * 0.15); 
    }

    rlpRanks[pos] = baseDrafted + buffer;
  });

  // Calculate generic Utility and Pitcher replacement floors
  let totalBatters = 0;
  let totalPitchers = 0;
  
  Object.keys(activeSlots).forEach(pos => {
    if (["SP", "RP", "P"].includes(pos)) totalPitchers += activeSlots[pos];
    else totalBatters += activeSlots[pos];
  });

  // The overall Utility/Batter replacement level is total batters + all utils + half the bench
  rlpRanks["Util"] = (totalBatters * numTeams) + (totalUtil * numTeams) + ((totalBench * numTeams) / 2);
  
  // The overall Pitcher replacement level
  rlpRanks["P"] = (totalPitchers * numTeams) + ((totalBench * numTeams) / 2);

  // Write back to Sheet
  const rlpRange = primarySS.getRangeByName("WEIGHTS_RLP_RANKS");
  if (rlpRange) {
    const currentRanks = rlpRange.getValues();
    const newRanks = currentRanks.map(row => {
      const pos = row[0]?.toString().trim();
      if (rlpRanks[pos]) return [pos, Math.round(rlpRanks[pos])];
      return row; // Unchanged if not calculated
    });
    rlpRange.setValues(newRanks);
  }
}