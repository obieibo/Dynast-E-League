/**
 * FILE: calculatePlayerValues.gs
 */

function calculatePlayerValues() {
  const ss = getPrimarySS();
  const dataSS = getDataSS();
  const weightsSheet = ss.getSheetByName("Weights"); 
  if (!weightsSheet) return;

  const statHeaders = weightsSheet.getRange("L4:L13").getValues();
  const statFactors = weightsSheet.getRange("P4:P13").getValues();
  const denoms = {};
  for (let i = 0; i < statHeaders.length; i++) {
    let stat = statHeaders[i][0]?.toString().trim();
    if (stat) denoms[stat] = parseFloat(statFactors[i][0]) || 1;
  }

  const baselineData = weightsSheet.getRange("F4:G6").getValues();
  const baselines = { "OPS": 0.750, "ERA": 3.80, "WHIP": 1.20 }; 
  baselineData.forEach(row => { if (row[0]) baselines[row[0].toString().trim()] = parseFloat(row[1]); });

  const rlpData = weightsSheet.getRange("I4:J14").getValues();
  const rlpRanks = {};
  rlpData.forEach(row => { if (row[0]) rlpRanks[row[0].toString().trim()] = parseInt(row[1]) || 0; });

  const yahooSheet = dataSS.getSheetByName("_PLAYERS");
  const yahooData = yahooSheet.getDataRange().getValues();
  const yHeaders = yahooData[0];
  const yahooPosMap = {};
  for (let i = 1; i < yahooData.length; i++) {
    const id = yahooData[i][yHeaders.indexOf("IDPLAYER")];
    const pos = yahooData[i][yHeaders.indexOf("POSITION")];
    if (id) yahooPosMap[id] = pos;
  }

  const projSheet = dataSS.getSheetByName("_BLEND_PROJECTIONS");
  const projData = projSheet.getDataRange().getValues();
  const projHeaders = projData[0];
  const getCol = (name) => projHeaders.indexOf(name);
  const playerSGPs = [];
  
  for (let i = 1; i < projData.length; i++) {
    const row = projData[i];
    const masterId = row[getCol("IDPLAYER")];
    const type = row[getCol("Type")];
    if (!type || !masterId) continue;
    
    let finalPos = yahooPosMap[masterId];
    if (!finalPos || finalPos === "") finalPos = (type === "Batter") ? "Util" : "P";

    let totalSGP = 0;
    try {
      if (type === "Batter") {
        const pa = parseFloat(row[getCol("PA")]) || 0;
        const ops = parseFloat(row[getCol("OPS")]) || 0;
        const opsSGP = (((ops - (baselines["OPS"] || 0.750)) * pa) / 500) / (denoms["OPS"] || 1); 
        totalSGP = (parseFloat(row[getCol("R")])/denoms["R"]) + (parseFloat(row[getCol("HR")])/denoms["HR"]) + (parseFloat(row[getCol("RBI")])/denoms["RBI"]) + (parseFloat(row[getCol("NSB")])/denoms["NSB"]) + opsSGP;
      } else {
        const ip = parseFloat(row[getCol("IP")]) || 0;
        const era = parseFloat(row[getCol("ERA")]) || 4.00;
        const whip = parseFloat(row[getCol("WHIP")]) || 1.25;
        const eraSGP = (((baselines["ERA"] || 4.00) - era) * ip / 150) / (denoms["ERA"] || 1);
        const whipSGP = (((baselines["WHIP"] || 1.25) - whip) * ip / 150) / (denoms["WHIP"] || 1);
        totalSGP = (parseFloat(row[getCol("K")])/denoms["K"]) + (parseFloat(row[getCol("QS")])/denoms["QS"]) + (parseFloat(row[getCol("NSVH")])/denoms["NSVH"]) + eraSGP + whipSGP;
      }
    } catch (e) { totalSGP = 0; }

    playerSGPs.push({ id: masterId, name: row[getCol("PlayerName")], team: row[getCol("Team")], pos: finalPos, type: type, sgp: totalSGP });
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

  const output = [["IDPLAYER", "PlayerName", "Team", "Pos", "Type", "Total SGP", "Positional Scarcity", "PAR (Value)"]];
  playerSGPs.forEach(p => {
    let floor = 999;
    const pPos = p.pos.split(",").map(s => s.trim());
    if (p.type === "Batter") pPos.push("Util");
    if (p.type === "Pitcher") pPos.push("P");

    pPos.forEach(pos => {
      if (pos === "OF") ["LF", "CF", "RF"].forEach(of => { if (posRLP_SGP[of] && posRLP_SGP[of] < floor) floor = posRLP_SGP[of]; });
      if (posRLP_SGP[pos] !== undefined && posRLP_SGP[pos] < floor && posRLP_SGP[pos] !== 0) {
        floor = posRLP_SGP[pos];
      }
    });
    
    if (floor === 999) floor = 0;
    const parValue = p.sgp - floor;
    
    output.push([
      p.id, p.name, p.team, p.pos, p.type, 
      p.sgp.toFixed(2), (floor * -1).toFixed(2), parValue.toFixed(2)
    ]);
  });

  writeToData("_VALUATIONS", [output[0], ...output.slice(1).sort((a, b) => b[7] - a[7])]);
  updateTimestamp("UPDATE_VALUATIONS");
}