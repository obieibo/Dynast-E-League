/**
 * @file _calculations.gs
 * @description Handles complex mathematical logic. Blends disparate projection 
 * systems into a weighted consensus, and calculates SGP/PAR values based on 
 * dynamic league baselines and replacement levels.
 * @dependencies _helpers.gs
 * @writesTo _BLEND, _VALUE
 */

// ============================================================================
//  BLEND PROJECTIONS
// ============================================================================

/**
 * Blends various FanGraphs projection systems into a single composite projection.
 * @writesTo _BLEND
 */
function buildBlendedProjections() {
  const ss = getPrimarySS();
  const dataSS = getDataSS();
  if (!dataSS) return;

  // 1. Load System Weights
  const weightsRange = ss.getRangeByName("WEIGHTS_SYSTEMS");
  if (!weightsRange) {
    _logError('_calculations.gs', 'Missing Named Range: WEIGHTS_SYSTEMS', 'CRITICAL');
    return;
  }
  const weightData = weightsRange.getValues();
  const systemWeights = {};
  weightData.forEach(row => {
    const sysName = row[0]?.toString().trim();
    const sysWeight = parseFloat(row[2]);
    if (sysName && !isNaN(sysWeight)) systemWeights[sysName] = sysWeight;
  });

  // 2. Fetch Position Mapping from _PLAYERS
  const playersSheet = dataSS.getSheetByName("_PLAYERS");
  const posMap = {};
  if (playersSheet && playersSheet.getLastRow() > 1) {
    const playersData = playersSheet.getDataRange().getValues();
    const headers = playersData[0].map(h => h.toString().trim().toUpperCase());
    const idIdx = headers.indexOf("IDPLAYER");
    const posIdx = headers.indexOf("POSITION");
    
    if (idIdx > -1 && posIdx > -1) {
      for (let i = 1; i < playersData.length; i++) {
        const pid = playersData[i][idIdx]?.toString().trim();
        if (pid) posMap[pid] = playersData[i][posIdx] || "";
      }
    }
  }

  // 3. Blend Data
  const bStats = ["PA", "R", "HR", "RBI", "SB", "CS", "OPS"];
  const pStats = ["IP", "SO", "QS", "SV", "HLD", "ERA", "WHIP"];
  
  const blendedBatters = _blendDataset(dataSS, "_FG_PROJ_B", systemWeights, "Batter", bStats);
  const blendedPitchers = _blendDataset(dataSS, "_FG_PROJ_P", systemWeights, "Pitcher", pStats);

  // 4. Output Schema: IDPLAYER, Player, TEAM, Position, Type, PA, R, HR, RBI, NSB, OPS, IP, K, QS, NSVH, ERA, WHIP
  const outputRows = [["IDPLAYER", "Player", "TEAM", "Position", "Type", "PA", "R", "HR", "RBI", "NSB", "OPS", "IP", "K", "QS", "NSVH", "ERA", "WHIP"]];

  Object.values(blendedBatters).forEach(p => {
    const nsb = (p.stats["SB"] || 0) - (p.stats["CS"] || 0);
    outputRows.push([
      p.id, p.name, p.team, posMap[p.id] || "", "Batter", 
      p.stats["PA"].toFixed(0), p.stats["R"].toFixed(1), p.stats["HR"].toFixed(1), 
      p.stats["RBI"].toFixed(1), nsb.toFixed(1), p.stats["OPS"].toFixed(3), 
      "", "", "", "", "", ""
    ]);
  });

  Object.values(blendedPitchers).forEach(p => {
    const nsvh = (p.stats["SV"] || 0) + (p.stats["HLD"] || 0);
    outputRows.push([
      p.id, p.name, p.team, posMap[p.id] || "", "Pitcher", 
      "", "", "", "", "", "", 
      p.stats["IP"].toFixed(1), p.stats["SO"].toFixed(1), p.stats["QS"].toFixed(1), 
      nsvh.toFixed(1), p.stats["ERA"].toFixed(3), p.stats["WHIP"].toFixed(3)
    ]);
  });

  writeToData("_BLEND", outputRows);
  _updateTimestamp("UPDATE_BLEND");
}

/**
 * Helper to process the blending logic for a specific dataset (batters or pitchers).
 */
function _blendDataset(dataSS, sheetName, weightsMap, playerType, statsToBlend) {
  const sheet = dataSS.getSheetByName(sheetName);
  if (!sheet || sheet.getLastRow() < 2) return {};
  
  const data = sheet.getDataRange().getValues();
  const headers = data[0].map(h => h.toString().trim().toUpperCase());
  const getCol = (name) => headers.indexOf(name.toUpperCase());
  
  const rawPlayerMap = {};

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const pid = row[getCol("IDPLAYER")]?.toString().trim();
    const sys = row[getCol("PROJECTIONS")]?.toString().trim();
    
    if (!pid || !weightsMap[sys] || row[getCol("TYPE")] !== "Pre-Season") continue;

    if (!rawPlayerMap[pid]) {
      const pName = row[getCol("PLAYERNAME")] || row[getCol("NAME")] || row[getCol("PLAYER")] || "Unknown";
      const pTeam = row[getCol("TEAMNAMEABB")] || row[getCol("TEAM")] || "";
      rawPlayerMap[pid] = { id: pid, name: pName, team: pTeam, systems: {} };
    }

    const stats = {};
    statsToBlend.forEach(stat => { stats[stat] = parseFloat(row[getCol(stat)]) || 0; });
    if (playerType === "Pitcher") {
      stats["_ER"] = (stats["ERA"] * stats["IP"]) / 9;
      stats["_WH"] = (stats["WHIP"] * stats["IP"]);
    }
    rawPlayerMap[pid].systems[sys] = stats;
  }

  const blendedPlayers = {};
  Object.values(rawPlayerMap).forEach(p => {
    let totalWeight = 0;
    const availableSystems = Object.keys(p.systems);
    availableSystems.forEach(sys => totalWeight += weightsMap[sys]);
    
    if (totalWeight === 0) return;

    const blended = { id: p.id, name: p.name, team: p.team, stats: {} };
    const volStats = playerType === "Batter" ? ["PA", "R", "HR", "RBI", "SB", "CS"] : ["IP", "SO", "QS", "SV", "HLD", "_ER", "_WH"];
    
    volStats.forEach(stat => {
      let sum = 0;
      availableSystems.forEach(sys => sum += (p.systems[sys][stat] || 0) * (weightsMap[sys] / totalWeight));
      blended.stats[stat] = sum;
    });
    
    if (playerType === "Pitcher") {
      blended.stats["ERA"] = blended.stats["IP"] > 0 ? (blended.stats["_ER"] * 9) / blended.stats["IP"] : 4.50;
      blended.stats["WHIP"] = blended.stats["IP"] > 0 ? blended.stats["_WH"] / blended.stats["IP"] : 1.35;
    } else {
      let opsSum = 0;
      availableSystems.forEach(sys => opsSum += (p.systems[sys]["OPS"] || 0) * (weightsMap[sys] / totalWeight));
      blended.stats["OPS"] = opsSum;
    }
    blendedPlayers[p.id] = blended;
  });
  
  return blendedPlayers;
}

// ============================================================================
//  CALCULATE PLAYER VALUES
// ============================================================================

/**
 * Computes SGP and PAR values using dynamically blended projections.
 * @writesTo _VALUE
 */
function calcPlayerValues() {
  const ss = getPrimarySS();
  const dataSS = getDataSS();
  if (!dataSS) return;

  // 1. Load Named Ranges
  const statCats = ss.getRangeByName("WEIGHTS_CATEGORIES")?.getValues() || [];
  const statFacts = ss.getRangeByName("WEIGHTS_FACTORS")?.getValues() || [];
  const baseData = ss.getRangeByName("WEIGHTS_BASELINES")?.getValues() || [];
  const rlpData = ss.getRangeByName("WEIGHTS_RLP_RANKS")?.getValues() || [];

  const denoms = {};
  for (let i = 0; i < statCats.length; i++) {
    let stat = statCats[i][0]?.toString().trim();
    if (stat) denoms[stat] = parseFloat(statFacts[i]?.[0]) || 1;
  }

  const baselines = { "OPS": 0.750, "ERA": 3.80, "WHIP": 1.20 }; 
  baseData.forEach(row => { if (row[0]) baselines[row[0].toString().trim()] = parseFloat(row[1]); });

  const rlpRanks = {};
  rlpData.forEach(row => { if (row[0]) rlpRanks[row[0].toString().trim()] = parseInt(row[1]) || 0; });

  // 2. Load Projections (Updated to _BLEND)
  const projSheet = dataSS.getSheetByName("_BLEND");
  if (!projSheet || projSheet.getLastRow() < 2) return;
  
  const projData = projSheet.getDataRange().getValues();
  const headers = projData[0].map(h => h.toString().trim().toUpperCase());
  const getCol = (name) => headers.indexOf(name.toUpperCase());
  
  const playerSGPs = [];
  
  for (let i = 1; i < projData.length; i++) {
    const row = projData[i];
    const pid = row[getCol("IDPLAYER")];
    const type = row[getCol("TYPE")];
    let pos = row[getCol("POSITION")] || "";
    
    if (!type || !pid) continue;
    if (pos === "") pos = (type === "Batter") ? "Util" : "P";

    let totalSGP = 0;
    try {
      if (type === "Batter") {
        const pa = parseFloat(row[getCol("PA")]) || 0;
        const ops = parseFloat(row[getCol("OPS")]) || 0;
        const opsSGP = (((ops - (baselines["OPS"] || 0.750)) * pa) / 500) / (denoms["OPS"] || 1); 
        totalSGP = (parseFloat(row[getCol("R")])/denoms["R"]) + (parseFloat(row[getCol("HR")])/denoms["HR"]) + 
                   (parseFloat(row[getCol("RBI")])/denoms["RBI"]) + (parseFloat(row[getCol("NSB")])/denoms["NSB"]) + opsSGP;
      } else {
        const ip = parseFloat(row[getCol("IP")]) || 0;
        const era = parseFloat(row[getCol("ERA")]) || 4.00;
        const whip = parseFloat(row[getCol("WHIP")]) || 1.25;
        const eraSGP = (((baselines["ERA"] || 4.00) - era) * ip / 150) / (denoms["ERA"] || 1);
        const whipSGP = (((baselines["WHIP"] || 1.25) - whip) * ip / 150) / (denoms["WHIP"] || 1);
        totalSGP = (parseFloat(row[getCol("K")])/denoms["K"]) + (parseFloat(row[getCol("QS")])/denoms["QS"]) + 
                   (parseFloat(row[getCol("NSVH")])/denoms["NSVH"]) + eraSGP + whipSGP;
      }
    } catch (e) { totalSGP = 0; }

    playerSGPs.push({ id: pid, name: row[getCol("PLAYER")], team: row[getCol("TEAM")], pos: pos, type: type, sgp: totalSGP });
  }

  // 3. Determine Positional Floors
  const posRLP_SGP = {};
  Object.keys(rlpRanks).forEach(pos => {
    let pool = [];
    if (pos === "Util") pool = playerSGPs.filter(p => p.type === "Batter");
    else if (pos === "P") pool = playerSGPs.filter(p => p.type === "Pitcher");
    else {
      pool = playerSGPs.filter(p => {
        const pPosArray = p.pos.split(",").map(s => s.trim());
        return pPosArray.includes(pos) || (pos.match(/LF|CF|RF/) && pPosArray.includes("OF"));
      });
    }
    pool.sort((a, b) => b.sgp - a.sgp);
    const idx = Math.min(rlpRanks[pos] - 1, pool.length - 1);
    posRLP_SGP[pos] = (pool.length > 0 && idx >= 0) ? pool[idx].sgp : 0;
  });

  // 4. Calculate PAR and Write Output
  // Schema: IDPLAYER, Player, TEAM, Position, Type, Total SGP, Scarcity, PAR Value
  const outputRows = [["IDPLAYER", "Player", "TEAM", "Position", "Type", "Total SGP", "Scarcity", "PAR Value"]];
  
  playerSGPs.forEach(p => {
    let floor = 999;
    const pPos = p.pos.split(",").map(s => s.trim());
    if (p.type === "Batter") pPos.push("Util");
    if (p.type === "Pitcher") pPos.push("P");

    pPos.forEach(pos => {
      if (pos === "OF") ["LF", "CF", "RF"].forEach(of => { if (posRLP_SGP[of] && posRLP_SGP[of] < floor) floor = posRLP_SGP[of]; });
      if (posRLP_SGP[pos] !== undefined && posRLP_SGP[pos] < floor && posRLP_SGP[pos] !== 0) floor = posRLP_SGP[pos];
    });
    
    if (floor === 999) floor = 0;
    const parValue = p.sgp - floor;
    
    outputRows.push([
      p.id, p.name, p.team, p.pos, p.type, 
      p.sgp.toFixed(2), (floor * -1).toFixed(2), parValue.toFixed(2)
    ]);
  });

  // Sort by PAR Value descending
  const sortedData = outputRows.slice(1).sort((a, b) => b[7] - a[7]);
  writeToData("_VALUE", [outputRows[0], ...sortedData]);
  
  // NOTE: Changed to UPDATE_VALUE to match the sheet name conventions perfectly.
  _updateTimestamp("UPDATE_VALUE");
}