/**
 * @file _calculations.gs
 * @description Handles complex mathematical logic. Blends disparate projection 
 * systems into a consensus using a full 2D Stat-by-Stat weight matrix, regresses 
 * them dynamically using Statcast true-talent data, and calculates SGP/PAR values.
 * @dependencies _helpers.gs
 * @writesTo _BLEND, _VALUE
 */

// ============================================================================
//  BLEND & REGRESS PROJECTIONS
// ============================================================================

function buildBlendedProjections() {
  const ss = getPrimarySS();
  const dataSS = getDataSS();
  if (!dataSS) return;

  // 1. Load 2D Stat-by-Stat Weights Matrix
  const weightsRange = ss.getRangeByName("WEIGHTS_STATS_SYSTEMS");
  if (!weightsRange) {
    _logError('_calculations.gs', 'Missing Named Range: WEIGHTS_STATS_SYSTEMS', 'CRITICAL');
    return;
  }
  
  const weightData = weightsRange.getValues();
  const sysHeaders = weightData[0].map(h => h.toString().trim());
  const statWeightsMap = {}; // Structure: { "HR": { "Steamer": 0.40, "ZiPS": 0.30 }, ... }
  
  for (let r = 1; r < weightData.length; r++) {
    const statName = weightData[r][0]?.toString().trim();
    if (!statName) continue;
    
    statWeightsMap[statName] = {};
    for (let c = 1; c < sysHeaders.length; c++) {
      const sysName = sysHeaders[c];
      const weight = parseFloat(weightData[r][c]);
      if (sysName && !isNaN(weight)) statWeightsMap[statName][sysName] = weight;
    }
  }

  // 2. Fetch Position Mapping from _PLAYERS
  const playersSheet = dataSS.getSheetByName("_PLAYERS");
  const posMap = {};
  if (playersSheet && playersSheet.getLastRow() > 1) {
    const playersData = playersSheet.getDataRange().getValues();
    const idIdx = playersData[0].map(h => h.toString().trim().toUpperCase()).indexOf("IDPLAYER");
    const posIdx = playersData[0].map(h => h.toString().trim().toUpperCase()).indexOf("POSITION");
    
    if (idIdx > -1 && posIdx > -1) {
      for (let i = 1; i < playersData.length; i++) {
        const pid = playersData[i][idIdx]?.toString().trim();
        if (pid) posMap[pid] = playersData[i][posIdx] || "";
      }
    }
  }

  // 3. Blend Data using 2D Matrix
  const bStats = ["PA", "R", "HR", "RBI", "SB", "CS", "OBP", "SLG"];
  const pStats = ["IP", "SO", "QS", "SV", "HLD", "ERA", "WHIP"];
  
  let blendedBatters = _blendDataset(dataSS, "_FG_PROJ_B", statWeightsMap, "Batter", bStats);
  let blendedPitchers = _blendDataset(dataSS, "_FG_PROJ_P", statWeightsMap, "Pitcher", pStats);

  // 4. LAYER 2: Apply Statcast Regression (In-Season Only)
  const infoSheet = dataSS.getSheetByName("_LEAGUE_INFO");
  let currentWeek = 1;
  if (infoSheet) {
    const infoData = infoSheet.getDataRange().getValues();
    const weekRow = infoData.find(row => row[1] === "current_week");
    if (weekRow) currentWeek = parseInt(weekRow[2]) || 1;
  }
  
  blendedBatters = _applySavantRegression(blendedBatters, dataSS, "Batter", currentWeek);
  blendedPitchers = _applySavantRegression(blendedPitchers, dataSS, "Pitcher", currentWeek);

  // 5. Output Schema
  const outputRows = [["IDPLAYER", "Player", "TEAM", "Position", "Type", "PA", "R", "HR", "RBI", "NSB", "OPS", "IP", "K", "QS", "NSVH", "ERA", "WHIP"]];

  Object.values(blendedBatters).forEach(p => {
    const nsb = (p.stats["SB"] || 0) - (p.stats["CS"] || 0);
    const ops = (p.stats["OBP"] || 0) + (p.stats["SLG"] || 0);
    
    outputRows.push([
      p.id, p.name, p.team, posMap[p.id] || "", "Batter", 
      p.stats["PA"].toFixed(0), p.stats["R"].toFixed(1), p.stats["HR"].toFixed(1), 
      p.stats["RBI"].toFixed(1), nsb.toFixed(1), ops.toFixed(3), 
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

function _blendDataset(dataSS, sheetName, statWeightsMap, playerType, statsToBlend) {
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
    
    // Check if system is in our matrix headers by looking at the PA or IP weight mappings
    const anchorStat = playerType === "Batter" ? "PA" : "IP";
    if (!pid || !statWeightsMap[anchorStat] || statWeightsMap[anchorStat][sys] === undefined || row[getCol("TYPE")] !== "Pre-Season") continue;

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
    const availableSystems = Object.keys(p.systems);
    if (availableSystems.length === 0) return;

    const blended = { id: p.id, name: p.name, team: p.team, stats: {} };
    
    const volStats = playerType === "Batter" ? ["PA", "R", "HR", "RBI", "SB", "CS"] : ["IP", "SO", "QS", "SV", "HLD", "_ER", "_WH"];
    
    // Dynamically sum weights PER STAT to ensure normalization if a system is missing for this player
    volStats.forEach(stat => {
      // For intermediate stats (_ER, _WH) use their parent stat's weight mappings
      const weightLookupStat = stat === "_ER" ? "ERA" : (stat === "_WH" ? "WHIP" : stat);
      const specificWeights = statWeightsMap[weightLookupStat] || {};

      let totalWeightForStat = 0;
      availableSystems.forEach(sys => totalWeightForStat += (specificWeights[sys] || 0));

      let sum = 0;
      if (totalWeightForStat > 0) {
        availableSystems.forEach(sys => {
          sum += (p.systems[sys][stat] || 0) * ((specificWeights[sys] || 0) / totalWeightForStat);
        });
      }
      blended.stats[stat] = sum;
    });
    
    // Process Rate Stats Independently using their specific weights
    if (playerType === "Pitcher") {
      blended.stats["ERA"] = blended.stats["IP"] > 0 ? (blended.stats["_ER"] * 9) / blended.stats["IP"] : 4.50;
      blended.stats["WHIP"] = blended.stats["IP"] > 0 ? blended.stats["_WH"] / blended.stats["IP"] : 1.35;
    } else {
      let obpSum = 0, slgSum = 0;
      let obpWeight = 0, slgWeight = 0;

      availableSystems.forEach(sys => {
        obpWeight += (statWeightsMap["OBP"]?.[sys] || 0);
        slgWeight += (statWeightsMap["SLG"]?.[sys] || 0);
      });

      availableSystems.forEach(sys => {
        if (obpWeight > 0) obpSum += (p.systems[sys]["OBP"] || 0) * ((statWeightsMap["OBP"]?.[sys] || 0) / obpWeight);
        if (slgWeight > 0) slgSum += (p.systems[sys]["SLG"] || 0) * ((statWeightsMap["SLG"]?.[sys] || 0) / slgWeight);
      });

      blended.stats["OBP"] = obpSum;
      blended.stats["SLG"] = slgSum;
    }
    blendedPlayers[p.id] = blended;
  });
  
  return blendedPlayers;
}

// ============================================================================
//  LAYER 2: SAVANT REGRESSION ENGINE
// ============================================================================

function _applySavantRegression(blendedMap, dataSS, type, currentWeek) {
  let savantWeight = 0;
  if (currentWeek > 2) {
    savantWeight = Math.min(0.75, (currentWeek - 2) * 0.05); 
  }
  
  if (savantWeight <= 0) return blendedMap; 

  const sheetName = type === "Batter" ? "_BS_RAW_B" : "_BS_RAW_P";
  const rawSheet = dataSS.getSheetByName(sheetName);
  
  if (!rawSheet || rawSheet.getLastRow() < 2) return blendedMap;

  const data = rawSheet.getDataRange().getValues();
  const headers = data[0].map(h => h.toString().trim().toLowerCase());
  const idxId = headers.indexOf("idplayer");
  
  if (idxId === -1) return blendedMap;

  const savantDataMap = {};
  for (let i = 1; i < data.length; i++) {
    const pid = data[i][idxId]?.toString().trim();
    if (pid) savantDataMap[pid] = data[i];
  }

  Object.keys(blendedMap).forEach(pid => {
    const player = blendedMap[pid];
    const sData = savantDataMap[pid];
    
    if (!sData) return; 

    if (type === "Batter") {
      const idxXOBP = headers.indexOf("xobp");
      const idxXSLG = headers.indexOf("xslg");
      
      if (idxXOBP > -1 && sData[idxXOBP]) {
        const xOBP = parseFloat(sData[idxXOBP]);
        player.stats["OBP"] = (player.stats["OBP"] * (1 - savantWeight)) + (xOBP * savantWeight);
      }
      if (idxXSLG > -1 && sData[idxXSLG]) {
        const xSLG = parseFloat(sData[idxXSLG]);
        player.stats["SLG"] = (player.stats["SLG"] * (1 - savantWeight)) + (xSLG * savantWeight);
      }
    } 
    else if (type === "Pitcher") {
      const idxXERA = headers.indexOf("xera");
      const idxXBA = headers.indexOf("xba");
      const idxBBPct = headers.indexOf("bb_percent");
      
      if (idxXERA > -1 && sData[idxXERA]) {
        const xERA = parseFloat(sData[idxXERA]);
        player.stats["ERA"] = (player.stats["ERA"] * (1 - savantWeight)) + (xERA * savantWeight);
      }
      if (idxXBA > -1 && idxBBPct > -1 && sData[idxXBA] && sData[idxBBPct]) {
        const xBA = parseFloat(sData[idxXBA]);
        const bbPct = parseFloat(sData[idxBBPct]) / 100;
        const estimated_xWHIP = (xBA * 4.0) + (bbPct * 4.0); 
        
        player.stats["WHIP"] = (player.stats["WHIP"] * (1 - savantWeight)) + (estimated_xWHIP * savantWeight);
      }
    }
  });

  return blendedMap;
}

// ============================================================================
//  CALCULATE PLAYER VALUES
// ============================================================================

function calcPlayerValues() {
  const ss = getPrimarySS();
  const dataSS = getDataSS();
  if (!dataSS) return;

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

  const sortedData = outputRows.slice(1).sort((a, b) => b[7] - a[7]);
  writeToData("_VALUE", [outputRows[0], ...sortedData]);
  _updateTimestamp("UPDATE_VALUE");
}