/**
 * FILE: blendProjections.gs
 */

function blendProjections() {
  const ss = getPrimarySS();
  const dataSS = getDataSS();
  const maps = getPlayerMaps("YAHOO_ID"); 
  const weightsSheet = ss.getSheetByName("Weights");

  const weightData = weightsSheet.getRange("C4:D6").getValues();
  const SYSTEM_WEIGHTS = {};
  weightData.forEach(row => {
    const sysName = row[0]?.toString().trim();
    const sysWeight = parseFloat(row[1]);
    if (sysName && !isNaN(sysWeight)) SYSTEM_WEIGHTS[sysName] = sysWeight;
  });

  const hitterStats = ["PA", "R", "HR", "RBI", "SB", "CS", "OPS"];
  const blendedBatters = _blendTallData(dataSS, "_FG_PROJ_B", SYSTEM_WEIGHTS, "Batter", hitterStats, maps);

  const pitcherStats = ["IP", "SO", "QS", "SV", "HLD", "ERA", "WHIP"];
  const blendedPitchers = _blendTallData(dataSS, "_FG_PROJ_P", SYSTEM_WEIGHTS, "Pitcher", pitcherStats, maps);

  const outputHeaders = ["IDPLAYER", "PlayerName", "Team", "Pos", "Type", "PA", "R", "HR", "RBI", "NSB", "OPS", "IP", "K", "QS", "NSVH", "ERA", "WHIP"];
  const allRows = [outputHeaders];

  Object.values(blendedBatters).forEach(p => {
    const nsb = (p.stats["SB"] || 0) - (p.stats["CS"] || 0);
    allRows.push([p.id, p.name, p.team, "", "Batter", p.stats["PA"].toFixed(0), p.stats["R"].toFixed(1), p.stats["HR"].toFixed(1), p.stats["RBI"].toFixed(1), nsb.toFixed(1), p.stats["OPS"].toFixed(3), "", "", "", "", "", ""]);
  });

  Object.values(blendedPitchers).forEach(p => {
    const nsvh = (p.stats["SV"] || 0) + (p.stats["HLD"] || 0);
    allRows.push([p.id, p.name, p.team, "", "Pitcher", "", "", "", "", "", "", p.stats["IP"].toFixed(1), p.stats["SO"].toFixed(1), p.stats["QS"].toFixed(1), nsvh.toFixed(1), p.stats["ERA"].toFixed(3), p.stats["WHIP"].toFixed(3)]);
  });

  writeToData("_BLEND_PROJECTIONS", allRows);
  updateTimestamp("UPDATE_BLEND_PROJECTIONS");
  flushIdMatchingQueue();
}

function _blendTallData(dataSS, sheetName, weightsMap, playerType, statsToBlend, maps) {
  const sheet = dataSS.getSheetByName(sheetName);
  if (!sheet) return {};
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const getCol = (name) => headers.indexOf(name);
  
  const rawPlayerMap = {};

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const fgId = row[getCol("IDPLAYER")];
    const sys = row[getCol("Projections")];
    if (!fgId || !weightsMap[sys] || row[getCol("Type")] !== "Pre-Season") continue;

    const playerName = (row[getCol("PlayerName")] || row[getCol("name")] || "Unknown").toString();
    const team = (row[getCol("Team")] || row[getCol("TeamNameAbb")] || "").toString();
    
    const masterId = resolveMasterId(maps, null, null, playerName, "Blender", team, fgId);
    const finalId = masterId || ("MISSING_" + fgId);

    if (!rawPlayerMap[finalId]) {
      rawPlayerMap[finalId] = { id: finalId, name: playerName, team: team, systems: {} };
    }

    const stats = {};
    statsToBlend.forEach(stat => { stats[stat] = parseFloat(row[getCol(stat)]) || 0; });
    if (playerType === "Pitcher") {
      stats["_ER"] = (stats["ERA"] * stats["IP"]) / 9;
      stats["_WH"] = (stats["WHIP"] * stats["IP"]);
    }
    rawPlayerMap[finalId].systems[sys] = stats;
  }

  const blendedPlayers = {};
  Object.values(rawPlayerMap).forEach(p => {
    let totalWeight = 0;
    const availableSystems = Object.keys(p.systems);
    availableSystems.forEach(sys => totalWeight += weightsMap[sys]);
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