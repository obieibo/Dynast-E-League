/**
 * @file _engine.gs
 * @description The Master Math & Valuation Engine. 
 * Consolidates Accuracy Weighting, Historical SGP Calibration, and the 
 * Master Valuation sequence (Blending -> Baselines -> PAR -> FIT).
 * @dependencies _helpers.gs
 */

const PROJECTION_SYSTEMS = [
  { name: 'ATC',          prefix: 'ENGINE_ATC',          fgId: 'atc' },
  { name: 'Depth Charts', prefix: 'ENGINE_DEPTH_CHARTS', fgId: 'fangraphsdc' },
  { name: 'ZiPS DC',      prefix: 'ENGINE_ZIPS_DC',      fgId: 'zipsdc' },
  { name: 'Steamer',      prefix: 'ENGINE_STEAMER',      fgId: 'steamer' },
  { name: 'ZiPS',         prefix: 'ENGINE_ZIPS',         fgId: 'zips' },
  { name: 'THE BAT',      prefix: 'ENGINE_THE_BAT',      fgId: 'thebat' },
  { name: 'THE BAT X',    prefix: 'ENGINE_THE_BAT_X',    fgId: 'thebatx' },
  { name: 'OOPSY',        prefix: 'ENGINE_OOPSY',        fgId: 'oopsy' }
];

// ============================================================================
//  PART 1: HISTORICAL SGP CALIBRATION
// ============================================================================

function calibrateHistoricalSGP() {
  const archiveSS = getArchiveSS();
  const ss = getPrimarySS();
  if (!archiveSS || !ss) return;

  const teamStatsSheet = archiveSS.getSheetByName('_TEAM_STATS');
  if (!teamStatsSheet || teamStatsSheet.getLastRow() < 2) {
    Logger.log("Not enough historical data to calibrate SGP factors.");
    return;
  }

  const data = teamStatsSheet.getDataRange().getValues();
  const headers = data[0].map(h => h.toString().trim().toUpperCase());
  
  const targetStats = ["R", "HR", "RBI", "SB", "OPS", "K", "QS", "SV", "HLD", "ERA", "WHIP"];
  const empiricalFactors = {};

  targetStats.forEach(stat => {
    let colIdx1 = -1, colIdx2 = -1;
    let isSplit = false, isInverse = false;
    
    if (stat === "SB") colIdx1 = headers.indexOf("SB"); 
    else if (stat === "SV" || stat === "HLD") {
      colIdx1 = headers.indexOf("SV");
      colIdx2 = headers.indexOf("HLD");
      isSplit = true;
    } else {
      colIdx1 = headers.indexOf(stat);
    }
    
    if (stat === "ERA" || stat === "WHIP") isInverse = true;

    if (colIdx1 === -1 && !isSplit) return;

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

    let totalGap = 0;
    let validYears = 0;

    Object.keys(yearTotals).forEach(year => {
      let totals = yearTotals[year].sort((a, b) => isInverse ? a - b : b - a);
      if (totals.length >= 12) {
        const top = totals[0]; 
        const bottom = totals[11]; 
        const gap = Math.abs(top - bottom);
        totalGap += (gap / 11); 
        validYears++;
      }
    });

    if (validYears > 0) {
      let finalFactor = totalGap / validYears;
      
      if (stat === "SB") finalFactor *= getDashboardSetting("ENGINE_SCARCITY", "NSB scarcity multiplier", 0.85);
      if (stat === "QS") finalFactor *= getDashboardSetting("ENGINE_SCARCITY", "QS scarcity multiplier", 0.85);
      if (stat === "SV" || stat === "HLD") {
        const svScarcity = getDashboardSetting("ENGINE_SCARCITY", "SV scarcity multiplier", 0.85);
        const hldScarcity = getDashboardSetting("ENGINE_SCARCITY", "HLD scarcity multiplier", 0.90);
        finalFactor *= ((svScarcity + hldScarcity) / 2);
      }

      empiricalFactors[stat] = finalFactor;
    }
  });

  const scalingRange = ss.getRangeByName("ENGINE_CATEGORY_SCALING");
  const scalingData = scalingRange.getValues();
  
  const newScalingData = scalingData.map(row => {
    const key = row[0]?.toString().trim().toLowerCase();
    if (key === "r factor" && empiricalFactors["R"]) return [row[0], empiricalFactors["R"].toFixed(3)];
    if (key === "hr factor" && empiricalFactors["HR"]) return [row[0], empiricalFactors["HR"].toFixed(3)];
    if (key === "rbi factor" && empiricalFactors["RBI"]) return [row[0], empiricalFactors["RBI"].toFixed(3)];
    if (key === "nsb factor" && empiricalFactors["SB"]) return [row[0], empiricalFactors["SB"].toFixed(3)];
    if (key === "ops factor" && empiricalFactors["OPS"]) return [row[0], empiricalFactors["OPS"].toFixed(3)];
    if (key === "k factor" && empiricalFactors["K"]) return [row[0], empiricalFactors["K"].toFixed(3)];
    if (key === "qs factor" && empiricalFactors["QS"]) return [row[0], empiricalFactors["QS"].toFixed(3)];
    if (key === "nsvh factor" && empiricalFactors["SV"]) return [row[0], empiricalFactors["SV"].toFixed(3)];
    if (key === "era factor" && empiricalFactors["ERA"]) return [row[0], empiricalFactors["ERA"].toFixed(3)];
    if (key === "whip factor" && empiricalFactors["WHIP"]) return [row[0], empiricalFactors["WHIP"].toFixed(3)];
    return row;
  });

  scalingRange.setValues(newScalingData);
  _updateTimestamp('UPDATE_CALIBRATION');
}

// ============================================================================
//  PART 2: ACCURACY & SYSTEM WEIGHTING
// ============================================================================

function vaultPreSeasonProjections() {
  const ss = getPrimarySS();
  const dataSS = getDataSS();
  const archiveSS = getArchiveSS();
  
  if (!dataSS || !archiveSS) return;

  const currentYear = parseInt(ss.getRangeByName('CURRENT_YEAR')?.getValue(), 10);
  if (!currentYear) return;

  const sheetsToVault = [
    { src: '_FG_PROJ_B', dest: '_ARCHIVE_PROJ_B' },
    { src: '_FG_PROJ_P', dest: '_ARCHIVE_PROJ_P' }
  ];

  sheetsToVault.forEach(mapping => {
    const srcSheet = dataSS.getSheetByName(mapping.src);
    if (!srcSheet || srcSheet.getLastRow() < 2) return;

    const srcData = srcSheet.getDataRange().getValues();
    const headers = srcData[0].map(h => h.toString().trim().toUpperCase());
    const typeIdx = headers.indexOf('TYPE');
    const yearIdx = headers.indexOf('YEAR');

    const filteredData = srcData.filter((row, index) => {
      if (index === 0) return true; 
      return row[typeIdx] === 'Pre-Season';
    });

    if (filteredData.length <= 1) return;

    let destSheet = archiveSS.getSheetByName(mapping.dest);
    if (!destSheet) {
      destSheet = archiveSS.insertSheet(mapping.dest);
      destSheet.appendRow(filteredData[0]); 
    }

    const existingData = destSheet.getDataRange().getValues();
    const cleanArchive = existingData.filter((row, index) => {
      if (index === 0) return true;
      return String(row[yearIdx]) !== String(currentYear);
    });

    cleanArchive.push(...filteredData.slice(1));
    writeToArchive(mapping.dest, cleanArchive);
  });

  _updateTimestamp('UPDATE_VAULT');
}

function calibrateSystemWeights() {
  const ss = getPrimarySS();
  const archiveSS = getArchiveSS();
  if (!archiveSS) return;

  const currentYear = parseInt(ss.getRangeByName('CURRENT_YEAR')?.getValue(), 10);
  const targetYear = currentYear - 1; 

  const minPA = getDashboardSetting("ENGINE_ACCURACY_WEIGHTING", "Minimum batter PA", 300);
  const minIP = getDashboardSetting("ENGINE_ACCURACY_WEIGHTING", "Minimum RP IP", 25);

  const statList = ss.getRangeByName("ENGINE_STAT").getValues().map(r => r[0]?.toString().trim()).filter(String);
  const bData = _getVaultedErrorData(archiveSS, '_FG_B', '_ARCHIVE_PROJ_B', targetYear, 'Batter', minPA);
  const pData = _getVaultedErrorData(archiveSS, '_FG_P', '_ARCHIVE_PROJ_P', targetYear, 'Pitcher', minIP);

  // 1. Gather Raw MAEs and Calculate Averages
  const rawMaes = {}; 
  statList.forEach(stat => {
    rawMaes[stat] = {};
    const isPitcherStat = ["IP", "TBF", "H", "R", "ER", "HR", "BB", "SO", "QS", "SV", "HLD", "ERA", "WHIP", "K/9", "BB/9"].includes(stat);
    const vaultData = isPitcherStat ? pData : bData;

    let statTotalMae = 0;
    let statValidCount = 0;

    PROJECTION_SYSTEMS.forEach(sys => {
      const sysName = sys.name.toLowerCase();
      if (vaultData.errors[stat] && vaultData.errors[stat][sysName]) {
        const errors = vaultData.errors[stat][sysName];
        if (errors.count > 0) {
          const mae = errors.totalError / errors.count;
          rawMaes[stat][sysName] = mae;
          statTotalMae += mae;
          statValidCount++;
        }
      }
    });
    rawMaes[stat].average = statValidCount > 0 ? (statTotalMae / statValidCount) : 0;
  });

  // 2. Calculate and Write System MAE and Accuracy+ to UI
  PROJECTION_SYSTEMS.forEach(sys => {
    const maeOutput = [];
    const accPlusOutput = [];
    const sysName = sys.name.toLowerCase();

    statList.forEach(stat => {
      const sysMae = rawMaes[stat][sysName];
      const avgMae = rawMaes[stat].average;
      if (sysMae !== undefined && avgMae > 0) {
        maeOutput.push([sysMae.toFixed(3)]);
        accPlusOutput.push([Math.round((avgMae / sysMae) * 100)]);
      } else {
        maeOutput.push([""]); accPlusOutput.push([""]); 
      }
    });

    ss.getRangeByName(`${sys.prefix}_MAE`)?.setValues(maeOutput);
    ss.getRangeByName(`${sys.prefix}_ACCURACY`)?.setValues(accPlusOutput);
  });

  // 3. Read UI Data into Memory
  const uiData = {};
  PROJECTION_SYSTEMS.forEach(sys => {
    uiData[sys.prefix] = {
      isChecked: ss.getRangeByName(sys.prefix)?.getValue() === true,
      maes: ss.getRangeByName(`${sys.prefix}_MAE`)?.getValues().map(r => parseFloat(r[0])) || [],
      overrides: ss.getRangeByName(`${sys.prefix}_OVERRIDE`)?.getValues().map(r => r[0]) || []
    };
  });

  // System Classifications for Fallback Logic
  const indSystems = ['steamer', 'zips', 'the bat', 'the bat x', 'oopsy'];
  const blendSystems = ['atc', 'depth charts', 'zips dc'];

  const obMaeOutput = [];
  const obAccPlusOutput = [];
  const systemWeightOutputs = {};
  PROJECTION_SYSTEMS.forEach(sys => systemWeightOutputs[sys.prefix] = []);

  // Helper Function: Tests a specific weight distribution to find its resulting MAE
  const testWeights = (weightObj, actMap, projMap) => {
    let obTotalError = 0;
    let obCount = 0;
    Object.keys(actMap).forEach(pid => {
      let blendedVal = 0;
      let wSum = 0;
      const pProjs = projMap[pid] || {};

      PROJECTION_SYSTEMS.forEach(sys => {
        const sysName = sys.name.toLowerCase();
        const w = weightObj[sysName] || 0;
        if (w > 0 && pProjs[sysName] !== undefined) {
          blendedVal += pProjs[sysName] * w;
          wSum += w;
        }
      });
      if (wSum > 0) {
        blendedVal /= wSum; 
        obTotalError += Math.abs(blendedVal - actMap[pid]);
        obCount++;
      }
    });
    return obCount > 0 ? (obTotalError / obCount) : Infinity;
  };

  // Helper Function: Calculates weights based on a given pool of systems
  const calcWeights = (pool) => {
    let wObj = {};
    let avail = 1.0;
    let inv = 0;
    pool.forEach(s => {
      if (s.isOverride) {
        wObj[s.name] = s.val;
        avail -= s.val;
      } else {
        inv += (1 / s.mae);
      }
    });
    if (avail < 0) avail = 0;
    pool.forEach(s => {
      if (!s.isOverride) {
        wObj[s.name] = inv > 0 ? ((1 / s.mae) / inv) * avail : 0;
      }
    });
    return wObj;
  };

  // 4. Calculate Weights via the Cascading Decision Tree
  statList.forEach((stat, rIdx) => {
    const isPitcherStat = ["IP", "TBF", "H", "R", "ER", "HR", "BB", "SO", "QS", "SV", "HLD", "ERA", "WHIP", "K/9", "BB/9"].includes(stat);
    const vaultData = isPitcherStat ? pData : bData;
    const avgMae = rawMaes[stat]?.average || 0;
    const actMap = vaultData.actuals[stat] || {};
    const projMap = vaultData.projections[stat] || {};

    // Get Active Pool (Checked or Overridden)
    const activeSystems = [];
    PROJECTION_SYSTEMS.forEach(sys => {
      const sysName = sys.name.toLowerCase();
      const myOverride = uiData[sys.prefix].overrides[rIdx];
      const isChecked = uiData[sys.prefix].isChecked;
      const sysMAE = uiData[sys.prefix].maes[rIdx];

      if (myOverride !== "" && myOverride !== null) {
        activeSystems.push({ name: sysName, isOverride: true, val: parseFloat(myOverride), mae: sysMAE });
      } else if (isChecked && sysMAE > 0) {
        activeSystems.push({ name: sysName, isOverride: false, mae: sysMAE });
      }
    });

    // Step A: Base Optimal Blend
    let currentWeights = calcWeights(activeSystems);
    let currentMae = testWeights(currentWeights, actMap, projMap);

    // Count how many individual models beat the Base OB
    let indBeatingCount = 0;
    indSystems.forEach(s => {
      if (rawMaes[stat][s] !== undefined && rawMaes[stat][s] < currentMae) indBeatingCount++;
    });

    // Step B: The "Two or More" Recalculation Trap
    if (indBeatingCount >= 2) {
      let elitePool = activeSystems.filter(s => {
        if (!s.mae) return false;
        const accPlus = (avgMae / s.mae) * 100;
        return accPlus >= 100; // Only models with 100+ Accuracy
      });

      if (elitePool.length > 0) {
        currentWeights = calcWeights(elitePool);
        currentMae = testWeights(currentWeights, actMap, projMap);
      } else {
        // Fallback: If no elite models exist, use models that beat the failed OB
        let fallbackPool = activeSystems.filter(s => s.mae && s.mae < currentMae);
        if (fallbackPool.length > 0) {
          currentWeights = calcWeights(fallbackPool);
          currentMae = testWeights(currentWeights, actMap, projMap);
        }
      }
    }

    // Step C: The Aggregator Final Boss
    let bestBlendMae = Infinity;
    let bestBlendSys = null;
    blendSystems.forEach(s => {
      if (rawMaes[stat][s] !== undefined && rawMaes[stat][s] < bestBlendMae) {
        bestBlendMae = rawMaes[stat][s];
        bestBlendSys = s;
      }
    });

    // If an aggregator beats our OB, the aggregator wins 100% of the weight
    if (bestBlendSys && bestBlendMae < currentMae) {
      currentWeights = {};
      currentWeights[bestBlendSys] = 1.0;
      currentMae = bestBlendMae;
    }

    // Step D: Output Final Weights & Final OB Metrics
    PROJECTION_SYSTEMS.forEach(sys => {
      const sysName = sys.name.toLowerCase();
      const w = currentWeights[sysName] || 0;
      const isChecked = uiData[sys.prefix].isChecked;
      const hasOverride = uiData[sys.prefix].overrides[rIdx] !== "" && uiData[sys.prefix].overrides[rIdx] !== null;
      
      // If a system ended up with weight > 0, populate it regardless of checkbox status
      if (w > 0 || isChecked || hasOverride) {
        systemWeightOutputs[sys.prefix].push([w]);
      } else {
        systemWeightOutputs[sys.prefix].push([""]);
      }
    });

    if (currentMae !== Infinity && avgMae > 0) {
      obMaeOutput.push([currentMae.toFixed(3)]);
      obAccPlusOutput.push([Math.round((avgMae / currentMae) * 100)]);
    } else {
      obMaeOutput.push([""]);
      obAccPlusOutput.push([""]);
    }
  });

  // Write Data to Dashboard
  PROJECTION_SYSTEMS.forEach(sys => {
    ss.getRangeByName(`${sys.prefix}_WEIGHT`)?.setValues(systemWeightOutputs[sys.prefix]);
  });
  ss.getRangeByName(`ENGINE_OB_MAE`)?.setValues(obMaeOutput);
  ss.getRangeByName(`ENGINE_OB_ACCURACY`)?.setValues(obAccPlusOutput);

  _updateTimestamp('UPDATE_ACCURACY');
}

function _getVaultedErrorData(archiveSS, actualsSheetName, projSheetName, targetYear, type, minThreshold) {
  const actualsSheet = archiveSS.getSheetByName(actualsSheetName);
  const projSheet = archiveSS.getSheetByName(projSheetName);
  if (!actualsSheet || !projSheet) return { errors: {}, actuals: {}, projections: {} };

  const aData = actualsSheet.getDataRange().getValues();
  const pData = projSheet.getDataRange().getValues();
  
  const aHeaders = aData[0].map(h => h.toString().trim().toUpperCase());
  const pHeaders = pData[0].map(h => h.toString().trim().toUpperCase());

  const getA = (name) => aHeaders.indexOf(name);
  const getP = (name) => pHeaders.indexOf(name);

  const thresholdCol = type === 'Batter' ? "PA" : "IP";
  const tIdx = getA(thresholdCol);

  const actualsMap = {};
  const actualsByStat = {};
  const projByStat = {};

  aData.slice(1).forEach(row => {
    if (String(row[getA("YEAR")]) !== String(targetYear)) return;
    const tVal = parseFloat(row[tIdx]) || 0;
    if (tVal < minThreshold) return;

    const pid = row[getA("IDPLAYER")]?.toString().trim();
    if (pid) actualsMap[pid] = row;
  });

  const errorMap = {};
  pData.slice(1).forEach(row => {
    if (String(row[getP("YEAR")]) !== String(targetYear)) return;

    const pid = row[getP("IDPLAYER")]?.toString().trim();
    const sys = row[getP("PROJECTIONS")]?.toString().trim().toLowerCase();
    
    if (!pid || !sys || !actualsMap[pid]) return;

    pHeaders.forEach(stat => {
      if (['IDPLAYER', 'IDFANGRAPHS', 'YEAR', 'PROJECTIONS', 'TYPE', 'PLAYERNAME', 'TEAM'].includes(stat)) return;
      if (getA(stat) === -1) return;

      const projVal = parseFloat(row[getP(stat)]);
      const actVal = parseFloat(actualsMap[pid][getA(stat)]);

      if (!isNaN(projVal) && !isNaN(actVal)) {
        if (!errorMap[stat]) errorMap[stat] = {};
        if (!errorMap[stat][sys]) errorMap[stat][sys] = { totalError: 0, count: 0 };
        
        errorMap[stat][sys].totalError += Math.abs(actVal - projVal);
        errorMap[stat][sys].count += 1;

        if (!actualsByStat[stat]) actualsByStat[stat] = {};
        actualsByStat[stat][pid] = actVal;

        if (!projByStat[stat]) projByStat[stat] = {};
        if (!projByStat[stat][pid]) projByStat[stat][pid] = {};
        projByStat[stat][pid][sys] = projVal;
      }
    });
  });

  return { errors: errorMap, actuals: actualsByStat, projections: projByStat };
}

// ============================================================================
//  PART 3: MASTER VALUATION ENGINE
// ============================================================================

function runPlayerValuation() {
  const ss = getPrimarySS();
  const dataSS = getDataSS();
  if (!dataSS) return;

  Logger.log("Starting Player Valuation Engine...");

  // 1. Build Projection Weights Dictionary from UI (Now respects dynamically injected >0 weights)
  const statList = ss.getRangeByName("ENGINE_STAT").getValues().map(r => r[0]?.toString().trim());
  const weightsMap = {}; 
  
  PROJECTION_SYSTEMS.forEach(sys => {
    const isChecked = ss.getRangeByName(sys.prefix)?.getValue() === true;
    const overrides = ss.getRangeByName(`${sys.prefix}_OVERRIDE`)?.getValues() || [];
    const weights = ss.getRangeByName(`${sys.prefix}_WEIGHT`).getValues();

    statList.forEach((stat, i) => {
      if (!stat) return;
      
      const w = parseFloat(weights[i][0]) || 0;
      
      // We pull the weight if it > 0 (meaning the engine selected it or the user overrode it)
      // OR if it's explicitly checked (even if the engine calculated it down to 0, which is handled naturally).
      if (w > 0 || isChecked) {
        if (!weightsMap[stat]) weightsMap[stat] = {};
        weightsMap[stat][sys.name.toLowerCase()] = w;
      }
    });
  });

  // 2. Fetch Yahoo Positions & Roster Context
  const posMap = {};
  const playersSheet = dataSS.getSheetByName("_PLAYERS");
  if (playersSheet && playersSheet.getLastRow() > 1) {
    const pData = playersSheet.getDataRange().getValues();
    const idIdx = pData[0].indexOf("IDPLAYER");
    const posIdx = pData[0].indexOf("POSITION");
    for (let i = 1; i < pData.length; i++) {
      if (pData[i][idIdx]) posMap[pData[i][idIdx]] = pData[i][posIdx] || "";
    }
  }

  // 3. Blend Projections
  const bStats = ["PA", "R", "HR", "RBI", "SB", "CS", "OBP", "SLG"];
  const pStats = ["IP", "SO", "QS", "SV", "HLD", "ERA", "WHIP"];
  
  let blendedPlayers = {
    ..._blendDataset(dataSS, "_FG_PROJ_B", weightsMap, "Batter", bStats, posMap),
    ..._blendDataset(dataSS, "_FG_PROJ_P", weightsMap, "Pitcher", pStats, posMap)
  };

  // 4. In-Memory Calibration (Baselines & Fallbacks)
  blendedPlayers = _calibrateAndApplyBaselines(ss, blendedPlayers);

  // 5. Calculate SGP & PAR
  blendedPlayers = _calculateSGPandPAR(ss, dataSS, blendedPlayers);

  // 6. Calculate FIT Scores (Weekly Volume & Context)
  blendedPlayers = _calculateFitScores(ss, dataSS, blendedPlayers);

  // 7. Write to _ENGINE (formerly _CALCULATED)
  const outputRows = [["IDPLAYER", "Player", "TEAM", "Position", "Type", "SGP", "Scarcity", "PAR", "Weekly Value", "Category Gap", "Positional Need", "Upgrade", "FIT", "PA", "R", "HR", "RBI", "NSB", "OPS", "IP", "K", "ERA", "WHIP", "QS", "NSVH"]];

  Object.values(blendedPlayers).sort((a, b) => b.fit - a.fit).forEach(p => {
    outputRows.push([
      p.id, p.name, p.team, p.pos, p.type,
      p.sgp.toFixed(2), p.scarcity.toFixed(2), p.par.toFixed(2), p.weeklyValue.toFixed(2),
      p.catGap.toFixed(1), p.posNeed.toFixed(1), p.upgrade.toFixed(1), p.fit.toFixed(1),
      p.stats["PA"] ? p.stats["PA"].toFixed(0) : "",
      p.stats["R"] ? p.stats["R"].toFixed(1) : "",
      p.stats["HR"] ? p.stats["HR"].toFixed(1) : "",
      p.stats["RBI"] ? p.stats["RBI"].toFixed(1) : "",
      p.stats["NSB"] !== undefined ? p.stats["NSB"].toFixed(1) : "",
      p.stats["OPS"] ? p.stats["OPS"].toFixed(3) : "",
      p.stats["IP"] ? p.stats["IP"].toFixed(1) : "",
      p.stats["SO"] ? p.stats["SO"].toFixed(1) : "",
      p.stats["ERA"] ? p.stats["ERA"].toFixed(3) : "",
      p.stats["WHIP"] ? p.stats["WHIP"].toFixed(3) : "",
      p.stats["QS"] ? p.stats["QS"].toFixed(1) : "",
      p.stats["NSVH"] !== undefined ? p.stats["NSVH"].toFixed(1) : ""
    ]);
  });

  writeToData("_ENGINE", outputRows);
  _updateTimestamp("UPDATE_ENGINE");
  Logger.log("Player Valuation Complete.");
}

// ============================================================================
//  ENGINE COMPONENTS (HELPERS)
// ============================================================================

function _blendDataset(dataSS, sheetName, statWeightsMap, playerType, statsToBlend, posMap) {
  const sheet = dataSS.getSheetByName(sheetName);
  if (!sheet || sheet.getLastRow() < 2) return {};
  
  const data = sheet.getDataRange().getValues();
  const headers = data[0].map(h => h.toString().trim().toUpperCase());
  const getCol = (name) => headers.indexOf(name);
  
  const rawPlayerMap = {};

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const pid = row[getCol("IDPLAYER")]?.toString().trim();
    const sys = row[getCol("PROJECTIONS")]?.toString().trim().toLowerCase();
    
    const anchorStat = playerType === "Batter" ? "PA" : "IP";
    if (!pid || !statWeightsMap[anchorStat] || statWeightsMap[anchorStat][sys] === undefined || row[getCol("TYPE")] !== "Pre-Season") continue;

    if (!rawPlayerMap[pid]) {
      rawPlayerMap[pid] = { 
        id: pid, 
        name: row[getCol("PLAYERNAME")] || "Unknown", 
        team: row[getCol("TEAM")] || "", 
        type: playerType,
        pos: posMap[pid] || (playerType === "Batter" ? "Util" : "P"),
        systems: {} 
      };
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

    p.stats = {};
    const volStats = p.type === "Batter" ? ["PA", "R", "HR", "RBI", "SB", "CS"] : ["IP", "SO", "QS", "SV", "HLD", "_ER", "_WH"];
    
    volStats.forEach(stat => {
      const weightLookupStat = stat === "_ER" ? "ERA" : (stat === "_WH" ? "WHIP" : stat);
      const specificWeights = statWeightsMap[weightLookupStat] || {};

      let totalWeightForStat = 0;
      availableSystems.forEach(sys => totalWeightForStat += (specificWeights[sys] || 0));

      let sum = 0;
      if (totalWeightForStat > 0) {
        availableSystems.forEach(sys => sum += (p.systems[sys][stat] || 0) * ((specificWeights[sys] || 0) / totalWeightForStat));
      }
      p.stats[stat] = sum;
    });
    
    if (p.type === "Pitcher") {
      p.stats["ERA"] = p.stats["IP"] > 0 ? (p.stats["_ER"] * 9) / p.stats["IP"] : 0;
      p.stats["WHIP"] = p.stats["IP"] > 0 ? p.stats["_WH"] / p.stats["IP"] : 0;
      p.stats["NSVH"] = (p.stats["SV"] || 0) + (p.stats["HLD"] || 0);
    } else {
      let obpSum = 0, slgSum = 0, obpW = 0, slgW = 0;
      availableSystems.forEach(sys => { obpW += (statWeightsMap["OBP"]?.[sys] || 0); slgW += (statWeightsMap["SLG"]?.[sys] || 0); });
      availableSystems.forEach(sys => {
        if (obpW > 0) obpSum += (p.systems[sys]["OBP"] || 0) * ((statWeightsMap["OBP"]?.[sys] || 0) / obpW);
        if (slgW > 0) slgSum += (p.systems[sys]["SLG"] || 0) * ((statWeightsMap["SLG"]?.[sys] || 0) / slgW);
      });
      p.stats["OBP"] = obpSum; p.stats["SLG"] = slgSum;
      p.stats["OPS"] = obpSum + slgSum;
      p.stats["NSB"] = (p.stats["SB"] || 0) - (p.stats["CS"] || 0);
    }
    
    blendedPlayers[p.id] = p;
  });
  
  return blendedPlayers;
}

function _calibrateAndApplyBaselines(ss, blendedPlayers) {
  let hitters = [], pitchers = [];
  let totalPA = 0, totalOBP_PA = 0, totalSLG_PA = 0;
  let totalIP = 0, totalER = 0, totalWH = 0, totalK = 0, totalBB = 0;

  Object.values(blendedPlayers).forEach(p => {
    if (p.type === "Batter") hitters.push(p);
    else pitchers.push(p);
  });

  hitters.sort((a, b) => (b.stats["PA"] || 0) - (a.stats["PA"] || 0));
  pitchers.sort((a, b) => (b.stats["IP"] || 0) - (a.stats["IP"] || 0));

  const targetHitters = getDashboardSetting('ENGINE_BASELINE_CALCS', 'Batters for OPS', 144);
  const targetPitchers = getDashboardSetting('ENGINE_BASELINE_CALCS', 'Pitchers for ERA/WHIP', 115);

  hitters.slice(0, targetHitters).forEach(p => {
    const pa = p.stats["PA"] || 0;
    totalPA += pa;
    totalOBP_PA += (p.stats["OBP"] || 0) * pa;
    totalSLG_PA += (p.stats["SLG"] || 0) * pa;
  });

  pitchers.slice(0, targetPitchers).forEach(p => {
    const ip = p.stats["IP"] || 0;
    totalIP += ip;
    totalER += p.stats["_ER"] || 0;
    totalWH += p.stats["_WH"] || 0;
    totalK += p.stats["SO"] || 0;
    totalBB += (p.stats["_WH"] * 0.35); 
  });

  const baseOBP = totalPA > 0 ? (totalOBP_PA / totalPA) : 0.315;
  const baseSLG = totalPA > 0 ? (totalSLG_PA / totalPA) : 0.420;
  const baseOPS = baseOBP + baseSLG;
  
  const baseERA = totalIP > 0 ? (totalER * 9) / totalIP : 3.80;
  const baseWHIP = totalIP > 0 ? (totalWH / totalIP) : 1.20;
  const baseK9 = totalIP > 0 ? (totalK * 9) / totalIP : 8.5;
  const baseBB9 = totalIP > 0 ? (totalBB * 9) / totalIP : 3.0;

  const sgpRange = ss.getRangeByName("ENGINE_SGP_VALUES");
  const sgpData = sgpRange.getValues().map(row => {
    const key = row[0]?.toString().trim().toLowerCase();
    if (key === "ops baseline") return [row[0], baseOPS.toFixed(3)];
    if (key === "era baseline") return [row[0], baseERA.toFixed(2)];
    if (key === "whip baseline") return [row[0], baseWHIP.toFixed(2)];
    return row;
  });
  sgpRange.setValues(sgpData);

  const fbRange = ss.getRangeByName("ENGINE_FALLBACKS");
  const fbData = fbRange.getValues().map(row => {
    const key = row[1]?.toString().trim().toLowerCase();
    if (key === "obp") return [baseOBP.toFixed(3), row[1]];
    if (key === "slg") return [baseSLG.toFixed(3), row[1]];
    if (key === "ops") return [baseOPS.toFixed(3), row[1]];
    if (key === "era") return [baseERA.toFixed(2), row[1]];
    if (key === "whip") return [baseWHIP.toFixed(2), row[1]];
    if (key === "k/9") return [baseK9.toFixed(1), row[1]];
    if (key === "bb/9") return [baseBB9.toFixed(1), row[1]];
    return row;
  });
  fbRange.setValues(fbData);

  Object.values(blendedPlayers).forEach(p => {
    if (p.type === "Batter" && p.stats["PA"] === 0) {
      p.stats["OBP"] = baseOBP;
      p.stats["SLG"] = baseSLG;
      p.stats["OPS"] = baseOPS;
    } else if (p.type === "Pitcher" && p.stats["IP"] === 0) {
      p.stats["ERA"] = baseERA;
      p.stats["WHIP"] = baseWHIP;
    }
  });

  return blendedPlayers;
}

function _calculateSGPandPAR(ss, dataSS, blendedPlayers) {
  const normPA = getDashboardSetting("ENGINE_SGP_VALUES", "OPS normalized PA", 500);
  const normIP_ERA = getDashboardSetting("ENGINE_SGP_VALUES", "ERA normalized IP", 150);
  const normIP_WHIP = getDashboardSetting("ENGINE_SGP_VALUES", "WHIP normalized IP", 150);
  const bOPS = getDashboardSetting("ENGINE_SGP_VALUES", "OPS baseline", 0.750);
  const bERA = getDashboardSetting("ENGINE_SGP_VALUES", "ERA baseline", 3.80);
  const bWHIP = getDashboardSetting("ENGINE_SGP_VALUES", "WHIP baseline", 1.20);

  const fR = getDashboardSetting("ENGINE_CATEGORY_SCALING", "R factor", 1);
  const fHR = getDashboardSetting("ENGINE_CATEGORY_SCALING", "HR factor", 1);
  const fRBI = getDashboardSetting("ENGINE_CATEGORY_SCALING", "RBI factor", 1);
  const fNSB = getDashboardSetting("ENGINE_CATEGORY_SCALING", "NSB factor", 1);
  const fOPS = getDashboardSetting("ENGINE_CATEGORY_SCALING", "OPS factor", 100);
  const fK = getDashboardSetting("ENGINE_CATEGORY_SCALING", "K factor", 1);
  const fQS = getDashboardSetting("ENGINE_CATEGORY_SCALING", "QS factor", 1);
  const fNSVH = getDashboardSetting("ENGINE_CATEGORY_SCALING", "NSVH factor", 1);
  const fERA = getDashboardSetting("ENGINE_CATEGORY_SCALING", "ERA factor", 50);
  const fWHIP = getDashboardSetting("ENGINE_CATEGORY_SCALING", "WHIP factor", 150);

  Object.values(blendedPlayers).forEach(p => {
    p.sgp = 0;
    if (p.type === "Batter") {
      const opsSGP = (((p.stats["OPS"] - bOPS) * p.stats["PA"]) / normPA) / (fOPS / 100); 
      p.sgp = (p.stats["R"]/fR) + (p.stats["HR"]/fHR) + (p.stats["RBI"]/fRBI) + (p.stats["NSB"]/fNSB) + opsSGP;
    } else {
      const eraSGP = ((bERA - p.stats["ERA"]) * p.stats["IP"] / normIP_ERA) / (fERA / 50);
      const whipSGP = ((bWHIP - p.stats["WHIP"]) * p.stats["IP"] / normIP_WHIP) / (fWHIP / 150);
      p.sgp = (p.stats["SO"]/fK) + (p.stats["QS"]/fQS) + (p.stats["NSVH"]/fNSVH) + eraSGP + whipSGP;
    }
  });

  const posRLP_SGP = {};
  const positions = ["C", "1B", "2B", "3B", "SS", "OF", "Util", "SP", "RP", "P"];
  
  positions.forEach(pos => {
    let pool = Object.values(blendedPlayers).filter(p => {
      if (pos === "Util" && p.type === "Batter") return true;
      if (pos === "P" && p.type === "Pitcher") return true;
      const pPosArray = p.pos.split(",").map(s => s.trim());
      return pPosArray.includes(pos) || (pos.match(/LF|CF|RF/) && pPosArray.includes("OF"));
    });
    
    pool.sort((a, b) => b.sgp - a.sgp);
    
    let baseDrafted = 12; 
    const infoSheet = dataSS.getSheetByName("_LEAGUE_INFO");
    if (infoSheet) {
      const infoData = infoSheet.getDataRange().getValues();
      const posRow = infoData.find(r => r[1]?.toString().trim().toUpperCase() === pos);
      if (posRow) baseDrafted = (parseInt(posRow[2]) || 1) * 12;
    }
    
    const buffer = getDashboardSetting("ENGINE_REPLACEMENT_LEVEL", `${pos} bench buffer`, 0);
    const targetRank = baseDrafted + buffer;
    
    const idx = Math.min(Math.max(targetRank - 1, 0), pool.length - 1);
    posRLP_SGP[pos] = (pool.length > 0 && idx >= 0) ? pool[idx].sgp : 0;
  });

  Object.values(blendedPlayers).forEach(p => {
    let floor = 999;
    const pPos = p.pos.split(",").map(s => s.trim());
    if (p.type === "Batter") pPos.push("Util");
    if (p.type === "Pitcher") pPos.push("P");

    pPos.forEach(pos => {
      if (pos === "OF") ["LF", "CF", "RF"].forEach(of => { if (posRLP_SGP[of] !== undefined && posRLP_SGP[of] < floor) floor = posRLP_SGP[of]; });
      if (posRLP_SGP[pos] !== undefined && posRLP_SGP[pos] < floor && posRLP_SGP[pos] !== 0) floor = posRLP_SGP[pos];
    });
    
    if (floor === 999) floor = 0;
    p.scarcity = floor * -1;
    p.par = p.sgp - floor;
  });

  return blendedPlayers;
}

function _calculateFitScores(ss, dataSS, blendedPlayers) {
  const myTeamId = ss.getRangeByName("MY_TEAM_ID")?.getValue()?.toString().trim();
  const schedSheet = dataSS.getSheetByName("_WEEKLY_SCHEDULE");
  const rosterSheet = dataSS.getSheetByName("_ROSTERS");

  const schedMap = {};
  if (schedSheet) {
    const sData = schedSheet.getDataRange().getValues();
    const sHead = sData[0];
    sData.slice(1).forEach(r => {
      schedMap[r[sHead.indexOf("TEAM")]] = {
        games: parseInt(r[sHead.indexOf("GAMES")]) || 0,
        hitMult: parseFloat(r[sHead.indexOf("HITTER_DIFF_MULT")]) || 1,
        pitchMult: parseFloat(r[sHead.indexOf("PITCHER_DIFF_MULT")]) || 1
      };
    });
  }

  const incumbents = {};
  const myPlayers = [];
  if (rosterSheet) {
    const rData = rosterSheet.getDataRange().getValues();
    const rHead = rData[0];
    rData.slice(1).forEach(row => {
      if (row[rHead.indexOf("TEAM_ID")]?.toString() === myTeamId) {
        const pid = row[rHead.indexOf("IDPLAYER")]?.toString();
        myPlayers.push(pid);
        const par = blendedPlayers[pid] ? blendedPlayers[pid].par : 0;
        const posStr = row[rHead.indexOf("POSITION")] || "";
        posStr.split(",").forEach(pos => {
          const p = pos.trim();
          if (incumbents[p] === undefined || par < incumbents[p]) incumbents[p] = par;
        });
      }
    });
  }

  const normBGames = getDashboardSetting("ENGINE_WEEKLY_NORM", "Batter games played", 150);
  const normSPStarts = getDashboardSetting("ENGINE_WEEKLY_NORM", "SP games started", 30);
  const normRPApps = getDashboardSetting("ENGINE_WEEKLY_NORM", "RP appearances / week", 3);
  const maxHitMult = getDashboardSetting("ENGINE_WEEKLY_NORM", "Batter difficulty ceiling", 1.30);
  const minHitMult = getDashboardSetting("ENGINE_WEEKLY_NORM", "Batter difficulty floor", 0.70);
  const maxPitMult = getDashboardSetting("ENGINE_WEEKLY_NORM", "Pitcher difficulty ceiling", 1.35);
  const minPitMult = getDashboardSetting("ENGINE_WEEKLY_NORM", "Pitcher difficulty floor", 0.65);
  
  const wCat = getDashboardSetting("ENGINE_FIT_WEIGHTING", "Category gap score", 0.50);
  const wPos = getDashboardSetting("ENGINE_FIT_WEIGHTING", "Positional need score", 0.25);
  const wUpg = getDashboardSetting("ENGINE_FIT_WEIGHTING", "Upgrade score", 0.25);
  const retention = getDashboardSetting("ENGINE_FIT_WEIGHTING", "Retention multiplier", 1.20);

  Object.values(blendedPlayers).forEach(p => {
    p.weeklyValue = p.par;
    const sched = schedMap[p.team];
    if (sched) {
      if (p.type === "Batter") {
        let mult = Math.min(maxHitMult, Math.max(minHitMult, sched.hitMult));
        p.weeklyValue = (p.par / normBGames) * sched.games * mult;
      } else {
        let mult = Math.min(maxPitMult, Math.max(minPitMult, sched.pitchMult));
        const expectedApps = p.pos.includes("SP") ? (sched.games / 5) : normRPApps;
        p.weeklyValue = (p.par / normSPStarts) * expectedApps * mult;
      }
    }

    p.catGap = Math.max(0, p.sgp * 2); 
    if (p.catGap > 100) p.catGap = 100;

    p.posNeed = 0;
    p.upgrade = 0;
    
    let incumbentPar = 999;
    const positions = p.pos.split(",").map(s => s.trim());
    if (p.type === "Batter") positions.push("Util");
    if (p.type === "Pitcher") positions.push("P");

    positions.forEach(pos => {
      if (incumbents[pos] === undefined) p.posNeed = 100; 
      else if (p.posNeed < 50) p.posNeed = 50; 
      
      if (incumbents[pos] !== undefined && incumbents[pos] < incumbentPar) {
        incumbentPar = incumbents[pos];
      }
    });

    if (incumbentPar !== 999 && incumbentPar < p.par) {
      p.upgrade = ((p.par - incumbentPar) / Math.abs(incumbentPar || 1)) * 100;
      p.upgrade = Math.min(100, Math.max(0, p.upgrade));
    } else if (incumbentPar === 999) {
      p.upgrade = 100; 
    }

    p.fit = (wCat * p.catGap) + (wPos * p.posNeed) + (wUpg * p.upgrade);
    if (myPlayers.includes(p.id)) p.fit *= retention;
  });

  return blendedPlayers;
}