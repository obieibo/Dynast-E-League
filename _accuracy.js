/**
 * @file _accuracy.gs
 * @description Layer 1: The Accuracy Modeling Engine (2D Stat-by-Stat Upgrade). 
 * Vaults pre-season projections and calculates the Mean Absolute Error (MAE) 
 * independently for every statistical category to generate a 2D weight matrix.
 * @dependencies _helpers.gs
 * @writesTo Archive Workbook (_ARCHIVE_PROJ_B, _ARCHIVE_PROJ_P), Primary Workbook (WEIGHTS_STATS_SYSTEMS)
 */

// ============================================================================
//  1. THE VAULT: SNAPSHOT PRE-SEASON PROJECTIONS
// ============================================================================

function vaultPreSeasonProjections() {
  const ss = getPrimarySS();
  const dataSS = getDataSS();
  const archiveSS = getArchiveSS();
  
  if (!dataSS || !archiveSS) return;

  const currentYear = parseInt(ss.getRangeByName('CURRENT_YEAR')?.getValue(), 10);
  if (!currentYear) {
    _logError('_accuracy.gs', 'CURRENT_YEAR missing for Vault.', 'CRITICAL');
    return;
  }

  Logger.log(`Vaulting Pre-Season Projections for ${currentYear}...`);

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

    const rowsToAppend = filteredData.slice(1);
    cleanArchive.push(...rowsToAppend);

    writeToArchive(mapping.dest, cleanArchive);
  });

  _updateTimestamp('UPDATE_VAULT');
  Logger.log(`Successfully vaulted ${currentYear} projections.`);
}

// ============================================================================
//  2. THE MAE ENGINE: CALIBRATE 2D SYSTEM WEIGHTS
// ============================================================================

function calibrateSystemWeights() {
  const ss = getPrimarySS();
  const archiveSS = getArchiveSS();
  if (!archiveSS) return;

  const currentYear = parseInt(ss.getRangeByName('CURRENT_YEAR')?.getValue(), 10);
  const targetYear = currentYear - 1; 

  Logger.log(`Calculating Stat-by-Stat Accuracy for ${targetYear} season...`);

  const bWeights = _calculateDatasetMAE(archiveSS, '_FG_B', '_ARCHIVE_PROJ_B', targetYear, 'Batter');
  const pWeights = _calculateDatasetMAE(archiveSS, '_FG_P', '_ARCHIVE_PROJ_P', targetYear, 'Pitcher');

  if (Object.keys(bWeights).length === 0 && Object.keys(pWeights).length === 0) {
    Logger.log("No historical data found to calculate weights. Run Vault first.");
    return;
  }

  const weightsRange = ss.getRangeByName("WEIGHTS_STATS_SYSTEMS");
  if (!weightsRange) {
    _logError('_accuracy.gs', 'WEIGHTS_STATS_SYSTEMS named range missing.', 'CRITICAL');
    return;
  }

  const currentWeightsData = weightsRange.getValues();
  const headers = currentWeightsData[0].map(h => h.toString().trim());
  
  let currentMode = "Batter"; // Start by assuming we are looking at batters

  const newWeightsData = currentWeightsData.map((row, rIdx) => {
    if (rIdx === 0) return row; // Keep headers

    const statName = row[0]?.toString().trim();
    if (!statName) return row;

    // The moment we hit 'IP', switch the engine to Pitcher mode
    if (statName === "IP") {
      currentMode = "Pitcher";
    }

    // Pull from the correct dictionary so they don't overwrite each other
    const targetWeights = currentMode === "Batter" ? bWeights : pWeights;

    // If there is no math for this stat (e.g., Pitchers haven't been loaded yet), skip it
    if (!targetWeights[statName] || Object.keys(targetWeights[statName]).length === 0) {
      return row;
    }

    // Build the new row values for this specific stat
    const newRow = [statName];
    for (let c = 1; c < headers.length; c++) {
      const sysName = headers[c];
      const newWeight = targetWeights[statName][sysName];
      newRow.push(newWeight !== undefined ? newWeight.toFixed(3) : row[c]);
    }
    return newRow;
  });

  weightsRange.setValues(newWeightsData);
  
  _updateTimestamp('UPDATE_ACCURACY');
  Logger.log("2D stat-by-stat weights dynamically updated based on historical MAE.");
}

// ============================================================================
//  HELPER: 2D MATH & ERROR CALCULATION
// ============================================================================

function _calculateDatasetMAE(archiveSS, actualsSheetName, projSheetName, targetYear, type) {
  const actualsSheet = archiveSS.getSheetByName(actualsSheetName);
  const projSheet = archiveSS.getSheetByName(projSheetName);
  
  if (!actualsSheet || !projSheet) return {};

  const actualData = actualsSheet.getDataRange().getValues();
  const projData = projSheet.getDataRange().getValues();

  const aHeaders = actualData[0].map(h => h.toString().trim().toUpperCase());
  const pHeaders = projData[0].map(h => h.toString().trim().toUpperCase());

  // Define stat targets. Including PA and IP to weight playing time models.
  const statsToGrade = type === 'Batter' 
    ? ["PA", "AB", "H", "1B", "2B", "3B", "HR", "R", "RBI", "BB", "SO", "HBP", "SB", "CS", "OBP", "SLG", "OPS"] 
    : ["IP", "TBF", "H", "R", "ER", "HR", "BB", "SO", "QS", "SV", "HLD", "ERA", "WHIP"];
  const minThresholdCol = type === 'Batter' ? "PA" : "IP";
  const minThresholdVal = type === 'Batter' ? 150 : 40; 

  // 1. Build Actuals Map
  const actualsMap = {};
  actualData.slice(1).forEach(row => {
    if (String(row[aHeaders.indexOf("YEAR")]) !== String(targetYear)) return;
    
    const pid = row[aHeaders.indexOf("IDPLAYER")]?.toString().trim();
    const threshold = parseFloat(row[aHeaders.indexOf(minThresholdCol)]) || 0;
    
    if (pid && threshold >= minThresholdVal) {
      actualsMap[pid] = {};
      statsToGrade.forEach(stat => {
        actualsMap[pid][stat] = parseFloat(row[aHeaders.indexOf(stat)]) || 0;
      });
    }
  });

  // 2. Calculate Absolute Errors
  // Structure: errorMap[stat][system] = { totalError: 0, count: 0 }
  const errorMap = {}; 
  statsToGrade.forEach(stat => errorMap[stat] = {});

  projData.slice(1).forEach(row => {
    if (String(row[pHeaders.indexOf("YEAR")]) !== String(targetYear)) return;

    const pid = row[pHeaders.indexOf("IDPLAYER")]?.toString().trim();
    const sys = row[pHeaders.indexOf("PROJECTIONS")]?.toString().trim();
    
    if (!pid || !sys || !actualsMap[pid]) return;

    statsToGrade.forEach(stat => {
      if (!errorMap[stat][sys]) errorMap[stat][sys] = { totalError: 0, count: 0 };
      
      const projVal = parseFloat(row[pHeaders.indexOf(stat)]) || 0;
      const actualVal = actualsMap[pid][stat];
      
      errorMap[stat][sys].totalError += Math.abs(actualVal - projVal);
      errorMap[stat][sys].count += 1;
    });
  });

  // 3. Calculate MAE and Convert to Weight per Stat
  const finalStatWeights = {}; // finalStatWeights[stat][system] = normalized weight

  Object.keys(errorMap).forEach(stat => {
    finalStatWeights[stat] = {};
    const systemsForStat = errorMap[stat];
    
    let totalInverseMAE = 0;
    const rawSystemScores = {};

    // Calculate raw inverse MAE
    Object.keys(systemsForStat).forEach(sys => {
      const data = systemsForStat[sys];
      if (data.count > 0) {
        const mae = data.totalError / data.count;
        const inverseMAE = 1 / (mae + 0.01); // Buffer prevents divide-by-zero
        rawSystemScores[sys] = inverseMAE;
        totalInverseMAE += inverseMAE;
      }
    });

    // Normalize so weights for THIS SPECIFIC STAT equal 1.0 (100%)
    if (totalInverseMAE > 0) {
      Object.keys(rawSystemScores).forEach(sys => {
        finalStatWeights[stat][sys] = rawSystemScores[sys] / totalInverseMAE;
      });
    }
  });

  return finalStatWeights;
}