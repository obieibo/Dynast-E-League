function optimizeLineup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const myTeamSheet = ss.getSheetByName("My Team"); 
  
  console.log('Fetching external data sheet ID');
  const dataIdRange = ss.getRangeByName("SHEET_DATA_ID");
  if (!dataIdRange) {
    throw new Error("Named range 'SHEET_DATA_ID' not found.");
  }
  
  const dataSheetId = dataIdRange.getValue();
  const externalSs = SpreadsheetApp.openById(dataSheetId);
  const infoSheet = externalSs.getSheetByName("_LEAGUE_INFO");

  if (!infoSheet) {
    throw new Error("Tab '_LEAGUE_INFO' not found in the external sheet.");
  }
  
  console.log('Fetching dynamic slots and quantities from _LEAGUE_INFO');
  const infoData = infoSheet.getRange("A2:C").getValues();
  let slots = [];
  
  infoData.forEach(row => {
    if (row[0] === "Roster Position" && row[1] !== "BN" && row[1] !== "") {
      let count = parseInt(row[2]);
      if (isNaN(count) || count < 1) count = 1; 
      for (let c = 0; c < count; c++) {
        slots.push(row[1]);
      }
    }
  });

  console.log('Fetching player data from My Team');
  const namesData = myTeamSheet.getRange("AK4:AK37").getValues();
  const positionsData = myTeamSheet.getRange("AQ4:AQ37").getValues();
  const ilData = myTeamSheet.getRange("AU4:AU37").getValues(); 
  const naData = myTeamSheet.getRange("AV4:AV37").getValues(); 
  const contextualData = myTeamSheet.getRange("AW4:AW37").getValues(); 
  
  let players = [];
  for (let i = 0; i < namesData.length; i++) {
    let name = namesData[i][0];
    if (name === "") continue; 
    
    let contextVal = parseFloat(contextualData[i][0]);
    let finalSortValue = (!isNaN(contextVal) && contextualData[i][0] !== "") ? contextVal : 1000 - i;

    players.push({
      originalRowIndex: i, 
      name: name,
      positions: positionsData[i][0].toString().split(',').map(p => p.trim()),
      isUnavailable: (ilData[i][0] !== "" || naData[i][0] !== ""),
      value: finalSortValue
    });
  }
  
  console.log('Sorting player data by value');
  let sortedPlayers = [...players].sort((a, b) => b.value - a.value);
  
  let slotUsed = new Array(slots.length).fill(false);
  let playerAssignments = new Array(namesData.length).fill(["BN"]); 
  let usedPlayers = new Set();

  function assignToFirstAvailable(player, slotChoices) {
    for (let i = 0; i < slotChoices.length; i++) {
      let targetSlot = slotChoices[i];
      let index = slots.findIndex((s, idx) => s === targetSlot && !slotUsed[idx]);
      if (index !== -1) {
        slotUsed[index] = true;
        playerAssignments[player.originalRowIndex] = [targetSlot];
        usedPlayers.add(player.name);
        return true;
      }
    }
    return false;
  }

  console.log('Pass 1: Pitchers - Pure Relievers (RP/P into RP, then P)');
  for (let i = 0; i < sortedPlayers.length; i++) {
    let player = sortedPlayers[i];
    if (player.isUnavailable || usedPlayers.has(player.name)) continue;

    let hasSP = player.positions.includes("SP");
    let hasRP = player.positions.includes("RP") || player.positions.includes("P");

    if (hasRP && !hasSP) {
      assignToFirstAvailable(player, ["RP", "P"]);
    }
  }

  console.log('Pass 2: Pitchers - Dual Eligible (SP/RP into RP, then P, then SP)');
  for (let i = 0; i < sortedPlayers.length; i++) {
    let player = sortedPlayers[i];
    if (player.isUnavailable || usedPlayers.has(player.name)) continue;

    let hasSP = player.positions.includes("SP");
    let hasRP = player.positions.includes("RP") || player.positions.includes("P");

    if (hasRP && hasSP) {
      assignToFirstAvailable(player, ["RP", "P", "SP"]);
    }
  }

  console.log('Pass 3: Pitchers - Pure Starters (SP into SP, then P)');
  for (let i = 0; i < sortedPlayers.length; i++) {
    let player = sortedPlayers[i];
    if (player.isUnavailable || usedPlayers.has(player.name)) continue;

    let hasSP = player.positions.includes("SP");
    let hasRP = player.positions.includes("RP") || player.positions.includes("P");

    if (hasSP && !hasRP) {
      assignToFirstAvailable(player, ["SP", "P"]);
    }
  }

  console.log('Pass 4: Batters - Universal strict allocations for single-eligibility players');
  for (let i = 0; i < sortedPlayers.length; i++) {
    let player = sortedPlayers[i];
    if (player.isUnavailable || usedPlayers.has(player.name)) continue;

    let isPitcher = player.positions.includes("SP") || player.positions.includes("RP") || player.positions.includes("P");

    if (!isPitcher && player.positions.length === 1) {
      assignToFirstAvailable(player, [player.positions[0]]);
    }
  }
  
  console.log('Pass 5: Batters - Evaluating primary positional allocations');
  for (let i = 0; i < sortedPlayers.length; i++) {
    let player = sortedPlayers[i];
    if (player.isUnavailable || usedPlayers.has(player.name)) continue;
    
    let isPitcher = player.positions.includes("SP") || player.positions.includes("RP") || player.positions.includes("P");

    if (!isPitcher) {
      assignToFirstAvailable(player, player.positions);
    }
  }

  console.log('Pass 6: Batters - Evaluating secondary flex allocations');
  for (let i = 0; i < sortedPlayers.length; i++) {
    let player = sortedPlayers[i];
    if (player.isUnavailable || usedPlayers.has(player.name)) continue;
    
    let isPitcher = player.positions.includes("SP") || player.positions.includes("RP") || player.positions.includes("P");

    if (!isPitcher) {
      let assigned = false;
      for (let p = 0; p < player.positions.length; p++) {
        let pos = player.positions[p];
        
        if (["1B", "3B"].includes(pos)) {
          assigned = assignToFirstAvailable(player, ["CI"]);
        } else if (["2B", "SS"].includes(pos)) {
          assigned = assignToFirstAvailable(player, ["MI"]);
        }
        if (assigned) break;
      }
      
      if (!assigned) {
        assignToFirstAvailable(player, ["UTIL"]);
      }
    }
  }

  for (let i = 0; i < namesData.length; i++) {
    if (namesData[i][0] === "") {
      playerAssignments[i] = [""];
    }
  }
  
  console.log('Writing results to AI4:AI37');
  myTeamSheet.getRange("AI4:AI37").setValues(playerAssignments);
}