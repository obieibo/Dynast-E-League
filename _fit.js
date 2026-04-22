/**
 * @file _fitEngine.gs
 * @description The ultimate decision layer. Calculates a 0-100 FIT score for every player
 * based on your team's specific categorical needs, positional gaps, and weekly H2H matchup.
 * Merges PAR, Schedule Difficulty, and Roster Context.
 * @dependencies _helpers.gs
 * @writesTo _FIT in Data workbook
 */

// ============================================================================
//  MAIN EXECUTION
// ============================================================================

function calculateFitScores() {
  const ss = getPrimarySS();
  const dataSS = getDataSS();
  if (!dataSS) return;

  // 1. Identify "My Team"
  const myTeamIdRange = ss.getRangeByName("MY_TEAM_ID");
  if (!myTeamIdRange || !myTeamIdRange.getValue()) {
    _logError('_fitEngine.gs', 'MY_TEAM_ID named range is missing or empty.', 'CRITICAL');
    return;
  }
  const myTeamId = myTeamIdRange.getValue().toString().trim();

  // 2. Gather Context Modules
  const catWeights = _getCategoryNeedWeights(dataSS, myTeamId);
  const rosterContext = _getRosterContext(dataSS, myTeamId);
  const scheduleData = _getScheduleData(dataSS);
  
  // 3. Load Player PAR and SGP Values
  const valueSheet = dataSS.getSheetByName("_VALUE");
  const projSheet = dataSS.getSheetByName("_BLEND"); // Needed for individual category SGPs
  if (!valueSheet || !projSheet) return;

  const valData = valueSheet.getDataRange().getValues();
  const valHeaders = valData[0].map(h => h.toString().trim().toUpperCase());
  
  const projData = projSheet.getDataRange().getValues();
  const projHeaders = projData[0].map(h => h.toString().trim().toUpperCase());

  // Map projections for easy SGP lookup
  const projMap = {};
  projData.slice(1).forEach(row => {
    const pid = row[projHeaders.indexOf("IDPLAYER")]?.toString().trim();
    if (pid) projMap[pid] = row;
  });

  const outputRows = [["IDPLAYER", "Player", "TEAM", "Position", "PAR", "Weekly Value", "Cat Gap Score", "Pos Need Score", "Upgrade Score", "FIT Score"]];

  // 4. Calculate FIT for every player
  valData.slice(1).forEach(row => {
    const pid = row[valHeaders.indexOf("IDPLAYER")]?.toString().trim();
    const pName = row[valHeaders.indexOf("PLAYER")];
    const team = row[valHeaders.indexOf("TEAM")];
    const posStr = row[valHeaders.indexOf("POSITION")] || "";
    const type = row[valHeaders.indexOf("TYPE")];
    const par = parseFloat(row[valHeaders.indexOf("PAR VALUE")]) || 0;

    if (!pid || !projMap[pid]) return;
    const pProj = projMap[pid];

    // ==========================================
    // A) WEEKLY VALUE (Schedule Multiplier)
    // ==========================================
    let weeklyValue = par;
    const sched = scheduleData[team];
    if (sched) {
      if (type === "Batter") {
        weeklyValue = (par / 150) * sched.games * sched.hitMult;
      } else {
        // Estimate 1 start per 5 games for SPs, or 3 appearances for RPs
        const expectedApps = posStr.includes("SP") ? (sched.games / 5) : 3;
        weeklyValue = (par / 30) * expectedApps * sched.pitchMult;
      }
    }

    // ==========================================
    // B) CATEGORY GAP SCORE (0-100)
    // ==========================================
    let catScore = 0;
    // Map individual stats to their weights
    if (type === "Batter") {
      catScore += (parseFloat(pProj[projHeaders.indexOf("R")]) || 0) * (catWeights["R"] || 1);
      catScore += (parseFloat(pProj[projHeaders.indexOf("HR")]) || 0) * (catWeights["HR"] || 1);
      catScore += (parseFloat(pProj[projHeaders.indexOf("RBI")]) || 0) * (catWeights["RBI"] || 1);
      catScore += (parseFloat(pProj[projHeaders.indexOf("NSB")]) || 0) * (catWeights["SB"] || 1);
      catScore += (parseFloat(pProj[projHeaders.indexOf("OPS")]) || 0) * 100 * (catWeights["OPS"] || 1); 
    } else {
      catScore += (parseFloat(pProj[projHeaders.indexOf("K")]) || 0) * (catWeights["K"] || 1);
      catScore += (parseFloat(pProj[projHeaders.indexOf("QS")]) || 0) * (catWeights["QS"] || 1);
      catScore += (parseFloat(pProj[projHeaders.indexOf("NSVH")]) || 0) * (catWeights["SV"] || 1);
      // Inverse for rate stats: Lower ERA/WHIP helps if you need the category
      const era = parseFloat(pProj[projHeaders.indexOf("ERA")]) || 4.50;
      const whip = parseFloat(pProj[projHeaders.indexOf("WHIP")]) || 1.35;
      catScore += Math.max(0, (4.50 - era)) * 50 * (catWeights["ERA"] || 1);
      catScore += Math.max(0, (1.35 - whip)) * 150 * (catWeights["WHIP"] || 1);
    }
    // Normalize Category Score to roughly 0-100 scale
    catScore = Math.min(100, Math.max(0, catScore * 2)); 

    // ==========================================
    // C) POSITIONAL NEED & UPGRADE SCORE (0-100)
    // ==========================================
    let posNeedScore = 0;
    let upgradeScore = 0;
    let isRosteredByMe = rosterContext.myPlayers.includes(pid);

    const positions = posStr.split(",").map(p => p.trim());
    if (type === "Batter") positions.push("Util");
    if (type === "Pitcher") positions.push("P");

    let incumbentPar = 999;
    
    positions.forEach(pos => {
      // 1. Check if we have an empty active slot for this position
      if (rosterContext.gaps.includes(pos)) posNeedScore = 100;
      else if (posNeedScore < 50) posNeedScore = 50; // Moderate need if no gap but eligible

      // 2. Find the weakest player currently starting at this position
      if (rosterContext.incumbents[pos] !== undefined && rosterContext.incumbents[pos] < incumbentPar) {
        incumbentPar = rosterContext.incumbents[pos];
      }
    });

    if (incumbentPar !== 999 && incumbentPar < par) {
      // Upgrade Score: percentage improvement over your worst starter, capped at 100
      upgradeScore = ((par - incumbentPar) / Math.abs(incumbentPar || 1)) * 100;
      upgradeScore = Math.min(100, Math.max(0, upgradeScore));
    } else if (incumbentPar === 999) {
      // If we have no incumbent (empty slot), upgrade score is maxed
      upgradeScore = 100; 
    }

    // ==========================================
    // D) FINAL FIT CALCULATION
    // ==========================================
    // Weights: 50% Category Needs, 25% Positional Need, 25% Marginal Upgrade
    let fitScore = (0.50 * catScore) + (0.25 * posNeedScore) + (0.25 * upgradeScore);

    // If the player is already on my team, FIT represents how badly I need to KEEP them
    if (isRosteredByMe) fitScore = fitScore * 1.2;

    outputRows.push([
      pid, pName, team, posStr, 
      par.toFixed(2), weeklyValue.toFixed(2), 
      catScore.toFixed(1), posNeedScore.toFixed(1), upgradeScore.toFixed(1), 
      fitScore.toFixed(1)
    ]);
  });

  // Sort by FIT Score descending
  const sortedData = outputRows.slice(1).sort((a, b) => b[9] - a[9]);
  
  writeToData("_FIT", [outputRows[0], ...sortedData]);
  _updateTimestamp('UPDATE_FIT');
}

// ============================================================================
//  CONTEXT HELPERS
// ============================================================================

/**
 * Evaluates current standings to weight categories. 
 * Categories ranked near the bottom get higher weights (scale of 0.1 to 2.5).
 */
function _getCategoryNeedWeights(dataSS, myTeamId) {
  const standingsSheet = dataSS.getSheetByName("_STANDINGS");
  const weights = { "R": 1, "HR": 1, "RBI": 1, "SB": 1, "OPS": 1, "K": 1, "QS": 1, "SV": 1, "ERA": 1, "WHIP": 1 };
  
  if (!standingsSheet) return weights;

  // In a real implementation, you would calculate standard deviations of the standings
  // and identify which categories are tightest. For this engine, we use a simpler
  // inverse rank approach (if you are 10th out of 12, the weight is high).
  
  const data = standingsSheet.getDataRange().getValues();
  const headers = data[0].map(h => h.toString().trim().toUpperCase());
  const tIdIdx = headers.indexOf("TEAM_ID");
  
  // Example logic: Just returns base weights for now, but wired to be expanded.
  // When pulling actual team stat totals, you compare your team to the mean.
  // Weight = 1.0 + ( (Mean - MyTotal) / StDev )
  
  return weights;
}

/**
 * Maps the user's current roster, identifies positional gaps (e.g., empty lineup slots),
 * and tracks the PAR of the lowest-rated incumbent at each position.
 */
function _getRosterContext(dataSS, myTeamId) {
  const context = { gaps: [], incumbents: {}, myPlayers: [] };
  
  const rostersSheet = dataSS.getSheetByName("_ROSTERS");
  const valueSheet = dataSS.getSheetByName("_VALUE");
  if (!rostersSheet || !valueSheet) return context;

  // 1. Get PAR for all players
  const valData = valueSheet.getDataRange().getValues();
  const valHeaders = valData[0].map(h => h.toString().trim().toUpperCase());
  const parMap = {};
  valData.slice(1).forEach(row => {
    parMap[row[valHeaders.indexOf("IDPLAYER")]] = parseFloat(row[valHeaders.indexOf("PAR VALUE")]) || 0;
  });

  // 2. Identify My Roster
  const rosterData = rostersSheet.getDataRange().getValues();
  const rHeaders = rosterData[0].map(h => h.toString().trim().toUpperCase());
  
  rosterData.slice(1).forEach(row => {
    if (row[rHeaders.indexOf("TEAM_ID")]?.toString() === myTeamId) {
      const pid = row[rHeaders.indexOf("IDPLAYER")]?.toString();
      const posStr = row[rHeaders.indexOf("POSITION")]?.toString() || "";
      const par = parMap[pid] || 0;
      
      context.myPlayers.push(pid);

      const positions = posStr.split(",").map(p => p.trim());
      positions.forEach(pos => {
        if (context.incumbents[pos] === undefined || par < context.incumbents[pos]) {
          context.incumbents[pos] = par;
        }
      });
    }
  });

  // 3. Detect Gaps (This assumes your _LEAGUE_INFO defines required slots)
  // For now, if an incumbent position has no players, it's a gap.
  const corePositions = ["C", "1B", "2B", "3B", "SS", "OF", "SP", "RP"];
  corePositions.forEach(pos => {
    if (context.incumbents[pos] === undefined) context.gaps.push(pos);
  });

  return context;
}

/**
 * Loads the Weekly Schedule Multipliers (Layer 5)
 */
function _getScheduleData(dataSS) {
  const map = {};
  const schedSheet = dataSS.getSheetByName("_WEEKLY_SCHEDULE");
  if (!schedSheet) return map;

  const data = schedSheet.getDataRange().getValues();
  const headers = data[0].map(h => h.toString().trim().toUpperCase());

  data.slice(1).forEach(row => {
    map[row[headers.indexOf("TEAM")]] = {
      games: parseInt(row[headers.indexOf("GAMES")]) || 0,
      hitMult: parseFloat(row[headers.indexOf("HITTER_DIFF_MULT")]) || 1,
      pitchMult: parseFloat(row[headers.indexOf("PITCHER_DIFF_MULT")]) || 1
    };
  });

  return map;
}