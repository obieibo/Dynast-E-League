/**
 * FILE: getFanGraphsBatProj.gs
 * PURPOSE: Fetches batting projections from multiple FanGraphs 
 * systems (Steamer, ZiPS, THE BAT, etc.) for both Pre-Season 
 * and Rest-of-Season (ROS).
 */

const FG_PROJ_BAT_SHEET = '_FG_PROJ_B';

const FG_BAT_PROJ_GROUPS = {
  "Steamer":      [{ id: "steamer", type: "Pre-Season" }, { id: "steamerr", type: "ROS" }],
  "ZiPS":         [{ id: "zips", type: "Pre-Season" }, { id: "rzips", type: "ROS" }],
  "Depth_Charts": [{ id: "fangraphsdc", type: "Pre-Season" }, { id: "rfangraphsdc", type: "ROS" }],
  "ATC":          [{ id: "atc", type: "Pre-Season" }, { id: "ratcdc", type: "ROS" }],
  "THE_BAT":      [{ id: "thebat", type: "Pre-Season" }, { id: "rthebat", type: "ROS" }],
  "THE_BAT_X":    [{ id: "thebatx", type: "Pre-Season" }, { id: "rthebatx", type: "ROS" }],
  "ZiPS_DC":      [{ id: "zipsdc", type: "Pre-Season" }, { id: "rzipsdc", type: "ROS" }]
};

function getFanGraphsBatProj() {
  const ss = getPrimarySS();
  const currentYear = parseInt(ss.getRangeByName("CURRENT_YEAR")?.getValue(), 10);

  if (!currentYear) {
    Logger.log('getFanGraphsBatProj: CURRENT_YEAR not found. Aborting.');
    return;
  }

  Logger.log(`getFanGraphsBatProj: Fetching projections for ${currentYear}...`);

  const maps = getPlayerMaps("IDFANGRAPHS");
  const idCache = {}; 

  const requestQueue = [];
  const metaQueue = [];

  for (let groupName in FG_BAT_PROJ_GROUPS) {
    FG_BAT_PROJ_GROUPS[groupName].forEach(variant => {
      requestQueue.push({
        url: `${FG_PROJ_BASE_URL}?pos=all&stats=bat&type=${variant.id}`,
        ...FG_PROJ_OPTIONS // Pulling from your helperFunctions.gs!
      });
      metaQueue.push({ groupName, sysType: variant.type });
    });
  }

  // The fix: Standard Google fetch instead of the Yahoo wrapper
  const responses = UrlFetchApp.fetchAll(requestQueue); 
  
  const allObjects = [];
  const allKeys = new Set();
  const successfulUpdates = new Set(); 

  responses.forEach((response, idx) => {
    const meta = metaQueue[idx];
    if (!response || response.getResponseCode() !== 200) return;

    let json;
    try {
      json = JSON.parse(response.getContentText());
    } catch (e) {
      Logger.log(`Failed to parse JSON for ${meta.groupName} ${meta.sysType}`);
      return;
    }
    
    const data = Array.isArray(json) ? json : (json?.data || []);
    
    if (data.length > 0) {
      successfulUpdates.add(`${meta.groupName}|${meta.sysType}`);
      
      data.forEach(row => {
        const fgId  = row.playerid ? row.playerid.toString() : "";
        const mlbId = row.xMLBAMID ? row.xMLBAMID.toString() : null;
        
        const pName = (row.PlayerName || row.name || "").toString().replace(/<[^>]+>/g, '').trim();
        const teamAbbr = (row.Team || row.TeamNameAbb || "").toString().replace(/<[^>]+>/g, '').trim();
        
        const cacheKey = `${fgId}_${mlbId}_${pName}`;
        if (!idCache[cacheKey]) {
          idCache[cacheKey] = resolveMasterId(maps, fgId, mlbId, pName, 'getFanGraphsBatProj', teamAbbr);
        }

        row["IDPLAYER"]    = idCache[cacheKey];
        row["Year"]        = currentYear;
        row["Projections"] = meta.groupName;
        row["Type"]        = meta.sysType;
        
        Object.keys(row).forEach(key => allKeys.add(key));
        allObjects.push(row);
      });
    }
  });

  if (allObjects.length > 0) {
    allKeys.delete("IDPLAYER");
    allKeys.delete("Year");
    allKeys.delete("Projections");
    allKeys.delete("Type");
    
    const headers = ["IDPLAYER", "Year", "Projections", "Type", ...Array.from(allKeys)];
    const outputData = [headers];
    
    allObjects.forEach(rowObj => {
      outputData.push(headers.map(key => rowObj.hasOwnProperty(key) ? rowObj[key] : ""));
    });
    
    writeToData(FG_PROJ_BAT_SHEET, outputData);
    Logger.log(`getFanGraphsBatProj: Wrote ${outputData.length - 1} projection rows to ${FG_PROJ_BAT_SHEET}`);
    
    const now = new Date();
    successfulUpdates.forEach(updateKey => {
      const [group, type] = updateKey.split('|');
      let rangeName = `UPDATE_${group.toUpperCase()}`;
      if (type === 'ROS') rangeName += '_ROS';
      
      const range = ss.getRangeByName(rangeName);
      if (range) range.setValue(now);
    });

    flushIdMatchingQueue();
  } else {
    Logger.log('getFanGraphsBatProj: No projection data returned.');
  }
}