/**
 * @file _dashboards.gs
 * @description Populates the "All Players", "Batters", and "Pitchers" scouting 
 * dashboards using a dynamic configuration engine.
 */

// ============================================================================
// DASHBOARD CONFIGURATION (DATA DICTIONARY)
// ============================================================================
// HOW TO EDIT:
// source: "ENGINE", "FG_B" (Batting Actuals), "FG_P" (Pitching Actuals), 
//         "BS_B" (Savant Bat), "BS_P" (Savant Pitch), "PLAYERS", "ROSTERS", 
//         "FP" (Ranks), "SGP" (System SGP Calcs), "CALC" (Custom Math), "BLANK"
// header: The exact column name found in that source sheet
// format: "cStat" (Forces 0 for counting stats), "rStat" (Rate stat -> needs volHeader), 
//         "roster" (Adds 'Team'), "1dec" (1 decimal place)
// volHeader: Used only for "rStat". Determines which volume stat to check (PA or IP).
// ============================================================================

const ALL_PLAYERS_LAYOUT = [
 
  // Player Information
  /** A  IDPLAYER **/    { source: "ENGINE", header: "IDPLAYER" },
  /** B  MLB Code **/    { source: "ENGINE", header: "TEAM" },
  /** C  Status **/      { source: "ROSTERS", header: "TEAM_ID", format: "roster" },
  /** D  IL **/          { source: "PLAYERS", header: "IL" },
  /** E  NA **/          { source: "PLAYERS", header: "NA" },
  /** F  Taken **/       { source: "BLANK" },
  /** G  Taken **/       { source: "BLANK" },
  /** H  Player **/      { source: "ENGINE", header: "Player" },
  /** I  MLB Logo **/    { source: "BLANK" },
  /** J  Position(s) **/ { source: "ENGINE", header: "Position" },
  /** K  IL Icon **/     { source: "BLANK" },
  /** L  NA Icon **/     { source: "BLANK" },
  /** M  Team Logo **/   { source: "BLANK" },
  /** N  Status **/      { source: "BLANK" },
  /** O  Favorite **/    { source: "BLANK" },
  /** P  Favorite **/    { source: "BLANK" },
 
  // Actual Statistics
  /** Q  PA **/   { source: "FG_B", header: "PA", format: "cStat" },
  /** R  R **/    { source: "FG_B", header: "R", format: "cStat" },
  /** S  HR **/   { source: "FG_B", header: "HR", format: "cStat" },
  /** T  RBI **/  { source: "FG_B", header: "RBI", format: "cStat" },
  /** U  OPS **/  { source: "FG_B", header: "OPS", format: "rStat", volHeader: "PA" },
  /** V  NSB **/  { source: "CALC", type: "bNSB" },
  /** W  IP **/   { source: "FG_P", header: "IP", format: "cStat" },
  /** X  K **/    { source: "FG_P", header: "SO", format: "cStat" },
  /** Y  ERA **/  { source: "FG_P", header: "ERA", format: "rStat", volHeader: "IP" },
  /** Z  WHIP **/ { source: "FG_P", header: "WHIP", format: "rStat", volHeader: "IP" },
  /** AA QS **/   { source: "FG_P", header: "QS", format: "cStat" },
  /** AB NSVH **/ { source: "CALC", type: "pNSVH" },
 
  // Projected Statistics
  /** AC PA **/   { source: "ENGINE", header: "PA", format: "cStat" },
  /** AD R **/    { source: "ENGINE", header: "R", format: "cStat" },
  /** AE HR **/   { source: "ENGINE", header: "HR", format: "cStat" },
  /** AF RBI **/  { source: "ENGINE", header: "RBI", format: "cStat" },
  /** AG OPS **/  { source: "ENGINE", header: "OPS", format: "rStat", volHeader: "PA" },
  /** AH NSB **/  { source: "ENGINE", header: "NSB", format: "cStat" },
  /** AI IP **/   { source: "ENGINE", header: "IP", format: "cStat" },
  /** AJ K **/    { source: "ENGINE", header: "K", format: "cStat" },
  /** AK ERA **/  { source: "ENGINE", header: "ERA", format: "rStat", volHeader: "IP" },
  /** AL WHIP **/ { source: "ENGINE", header: "WHIP", format: "rStat", volHeader: "IP" },
  /** AM QS **/   { source: "ENGINE", header: "QS", format: "cStat" },
  /** AN NSVH **/ { source: "ENGINE", header: "NSVH", format: "cStat" },
  
  // Rankings
  /** AO FP Rank **/   { source: "FP", header: "RANK" },
  /** AP PL SP **/     { source: "BLANK" },
  /** AQ PL RP **/     { source: "BLANK" },
  /** AR PL Hitters **/{ source: "BLANK" },
  
  // Optimal Blend Model (Moved)
  /** AS PAR **/       { source: "ENGINE", header: "PAR" },
  /** AT FIT **/       { source: "ENGINE", header: "FIT" },

  // System SGP (Shifted)
  /** AU SGP **/       { source: "ENGINE", header: "SGP" },
  /** AV ATC **/       { source: "SGP", header: "ATC" },
  /** AW THE BAT X **/ { source: "SGP", header: "THE BAT X" },
  /** AX OOPSY **/     { source: "SGP", header: "OOPSY" },
];

const BATTERS_LAYOUT = [
  
  // Player Information
  /** A  IDPLAYER **/    { source: "ENGINE", header: "IDPLAYER" },
  /** B  MLB Code **/    { source: "ENGINE", header: "TEAM" },
  /** C  Status **/      { source: "ROSTERS", header: "TEAM_ID", format: "roster" },
  /** D  IL **/          { source: "PLAYERS", header: "IL" },
  /** E  NA **/          { source: "PLAYERS", header: "NA" },
  /** F  Taken **/       { source: "BLANK" },
  /** G  Taken **/       { source: "BLANK" },
  /** H  Player **/      { source: "ENGINE", header: "Player" },
  /** I  MLB Logo **/    { source: "BLANK" },
  /** J  Position(s) **/ { source: "ENGINE", header: "Position" },
  /** K  IL Icon **/     { source: "BLANK" },
  /** L  NA Icon **/     { source: "BLANK" },
  /** M  Team Logo **/   { source: "BLANK" },
  /** N  Status **/      { source: "BLANK" },
  /** O  Favorite **/    { source: "BLANK" },
  /** P  Favorite **/    { source: "BLANK" },
  
  // Actual Statistics
  /** Q  PA **/   { source: "FG_B", header: "PA", format: "cStat" },
  /** R  R **/    { source: "FG_B", header: "R", format: "cStat" },
  /** S  HR **/   { source: "FG_B", header: "HR", format: "cStat" },
  /** T  RBI **/  { source: "FG_B", header: "RBI", format: "cStat" },
  /** U  OPS **/  { source: "FG_B", header: "OPS", format: "rStat", volHeader: "PA" },
  /** V  NSB **/  { source: "CALC", type: "bNSB" },
  
  // Projected Statistics
  /** W  PA **/   { source: "ENGINE", header: "PA", format: "cStat" },
  /** X  R **/    { source: "ENGINE", header: "R", format: "cStat" },
  /** Y  HR **/   { source: "ENGINE", header: "HR", format: "cStat" },
  /** Z  RBI **/  { source: "ENGINE", header: "RBI", format: "cStat" },
  /** AA OPS **/  { source: "ENGINE", header: "OPS", format: "rStat", volHeader: "PA" },
  /** AB NSB **/  { source: "ENGINE", header: "NSB", format: "cStat" },
  
  // Rankings
  /** AC FP Rank **/   { source: "FP", header: "RANK" },
  /** AD PL **/        { source: "BLANK" },

  // Optimal Blend Model (Moved)
  /** AE PAR **/       { source: "ENGINE", header: "PAR" },
  /** AF FIT **/       { source: "ENGINE", header: "FIT" },
  
  // System SGP (Shifted)
  /** AG SGP **/       { source: "ENGINE", header: "SGP" },
  /** AH ATC **/       { source: "SGP", header: "ATC" },
  /** AI THE BAT X **/ { source: "SGP", header: "THE BAT X" },
  /** AJ OOPSY **/     { source: "SGP", header: "OOPSY" },
  
  // Overall
  /** AK Batting **/ { source: "FG_B", header: "Batting" },
  /** AL wRC+ **/    { source: "FG_B", header: "wRC+" },
  /** AM xwOBA **/   { source: "FG_B", header: "xwOBA" },
  /** AN ΔxwOBA **/  { source: "CALC", type: "ΔxwOBA" },
  /** AO xISO **/    { source: "CALC", type: "xISO" },
  /** AP Barrel% **/ { source: "FG_B", header: "Barrel%" },
  /** AQ Hard% **/   { source: "FG_B", header: "HardHit%" },
  /** AR SqUp% **/   { source: "FG_B", header: "SquaredUpSwing%" },
  /** AS EV90 **/    { source: "FG_B", header: "EV90" },
  /** AT BB% **/     { source: "FG_B", header: "BB%" },
  /** AU K% **/      { source: "FG_B", header: "K%" },
  /** AV O-Sw% **/   { source: "FG_B", header: "O-Swing%" },
  /** AW SwStr% **/  { source: "FG_B", header: "SwStr%" },
  /** AX Bat Spd **/ { source: "FG_B", header: "AvgBatSpeed" },
  /** AY FastSw% **/ { source: "FG_B", header: "FastSwing%" },
  /** AZ SwLen **/   { source: "FG_B", header: "SwingLength" },
  /** BA GB% **/     { source: "FG_B", header: "GB%" },
  /** BB LD% **/     { source: "FG_B", header: "LD%" },
  /** BC HR/FB **/   { source: "FG_B", header: "HR/FB" },
  /** BD BABIP **/   { source: "FG_B", header: "BABIP" },
  /** BE Sprint **/  { source: "FG_B", header: "Spd" }
];

const PITCHERS_LAYOUT = [
  
  // Player Information
  /** A  IDPLAYER **/    { source: "ENGINE", header: "IDPLAYER" },
  /** B  MLB Code **/    { source: "ENGINE", header: "TEAM" },
  /** C  Status **/      { source: "ROSTERS", header: "TEAM_ID", format: "roster" },
  /** D  IL **/          { source: "PLAYERS", header: "IL" },
  /** E  NA **/          { source: "PLAYERS", header: "NA" },
  /** F  Taken **/       { source: "BLANK" },
  /** G  Taken **/       { source: "BLANK" },
  /** H  Player **/      { source: "ENGINE", header: "Player" },
  /** I  MLB Logo **/    { source: "BLANK" },
  /** J  Position(s) **/ { source: "ENGINE", header: "Position" },
  /** K  IL Icon **/     { source: "BLANK" },
  /** L  NA Icon **/     { source: "BLANK" },
  /** M  Team Logo **/   { source: "BLANK" },
  /** N  Status **/      { source: "BLANK" },
  /** O  Favorite **/    { source: "BLANK" },
  /** P  Favorite **/    { source: "BLANK" },
  
  // Actual Statistics
  /** Q  IP **/   { source: "FG_P", header: "IP", format: "cStat" },
  /** R  K **/    { source: "FG_P", header: "SO", format: "cStat" },
  /** S  ERA **/  { source: "FG_P", header: "ERA", format: "rStat", volHeader: "IP" },
  /** T  WHIP **/ { source: "FG_P", header: "WHIP", format: "rStat", volHeader: "IP" },
  /** U  QS **/   { source: "FG_P", header: "QS", format: "cStat" },
  /** V  NSVH **/ { source: "CALC", type: "pNSVH" },

  // Projected Statistics
  /** W  IP **/   { source: "ENGINE", header: "IP", format: "cStat" },
  /** X  K **/    { source: "ENGINE", header: "K", format: "cStat" },
  /** Y  ERA **/  { source: "ENGINE", header: "ERA", format: "rStat", volHeader: "IP" },
  /** Z  WHIP **/ { source: "ENGINE", header: "WHIP", format: "rStat", volHeader: "IP" },
  /** AA QS **/   { source: "ENGINE", header: "QS", format: "cStat" },
  /** AB NSVH **/ { source: "ENGINE", header: "NSVH", format: "cStat" },

  // Rankings
  /** AC FP Rank **/   { source: "FP", header: "RANK" },
  /** AD PL SP **/     { source: "BLANK" },
  /** AE PL RP **/     { source: "BLANK" },
  
  // Optimal Blend Model (Moved)
  /** AF PAR **/       { source: "ENGINE", header: "PAR" },
  /** AG FIT **/       { source: "ENGINE", header: "FIT" },

  // System SGP (Shifted)
  /** AH SGP **/       { source: "ENGINE", header: "SGP" },
  /** AI ATC **/       { source: "SGP", header: "ATC" },
  /** AJ THE BAT X **/ { source: "SGP", header: "THE BAT X" },
  /** AK OOPSY **/     { source: "SGP", header: "OOPSY" },

  // Stuff and Velocity
  /** AL Stuff+ **/  { source: "FG_P", header: "sp_stuff" },
  /** AM Pitch+ **/  { source: "FG_P", header: "sp_pitching" },
  /** AN FB Velo **/ { source: "FG_P", header: "FBv" },
  /** AO SwStr% **/  { source: "FG_P", header: "SwStr%" },
  /** AP O-Sw% **/   { source: "FG_P", header: "O-Swing%" },
  /** AQ CSW% **/    { source: "FG_P", header: "C+SwStr%" },
  /** AR K% **/      { source: "FG_P", header: "K%" },
  /** AS BB% **/     { source: "FG_P", header: "BB%" },
  /** AT K-BB% **/   { source: "FG_P", header: "K-BB%" },
  /** AU xERA **/    { source: "FG_P", header: "xERA" },
  /** AV ΔxERA **/   { source: "CALC", type: "ΔxERA" },
  /** AW xFIP **/    { source: "FG_P", header: "xFIP" },
  /** AX ΔxFIP **/   { source: "CALC", type: "ΔxFIP" },
  /** AY SIERA **/   { source: "FG_P", header: "SIERA" },
  /** AZ Barrel% **/ { source: "FG_P", header: "Barrel%" },
  /** BA Hard% **/   { source: "FG_P", header: "HardHit%" },
  /** BB GB% **/     { source: "FG_P", header: "GB%" },
  /** BC HR/FB **/   { source: "FG_P", header: "HR/FB" },
  /** BD P / IP **/  { source: "CALC", type: "P / IP" }
];

// ============================================================================
// LOGIC ENGINE
// ============================================================================

function updatePlayerDashboards() {
  const ss = getPrimarySS();
  const dataSS = getDataSS();
  if (!ss || !dataSS) return;

  Logger.log("Updating Player Dashboards via Config Layouts...");

  // 1. Fetch Accurate SGP Calibration Data
  const normPA = getDashboardSetting("ENGINE_SGP_VALUES", "OPS normalized PA", 500);
  const normIP_ERA = getDashboardSetting("ENGINE_SGP_VALUES", "ERA normalized IP", 150);
  const normIP_WHIP = getDashboardSetting("ENGINE_SGP_VALUES", "WHIP normalized IP", 150);
  
  let bOPS = 0.750, bERA = 3.80, bWHIP = 1.20;
  const baseData = ss.getRangeByName("WEIGHTS_BASELINES")?.getValues() || [];
  baseData.forEach(row => { 
    const stat = row[0]?.toString().trim().toUpperCase();
    if (stat === "OPS") bOPS = parseFloat(row[1]) || 0.750;
    if (stat === "ERA") bERA = parseFloat(row[1]) || 3.80;
    if (stat === "WHIP") bWHIP = parseFloat(row[1]) || 1.20;
  });

  const statCats = ss.getRangeByName("WEIGHTS_CATEGORIES")?.getValues() || [];
  const statFacts = ss.getRangeByName("WEIGHTS_FACTORS")?.getValues() || [];

  let fR = 18, fHR = 7, fRBI = 18, fNSB = 5, fOPS = 0.004, fK = 20, fQS = 4, fNSVH = 5, fERA = 0.04, fWHIP = 0.01;
  
  for (let i = 0; i < statCats.length; i++) {
    const stat = statCats[i][0]?.toString().trim().toUpperCase();
    const val = parseFloat(statFacts[i]?.[0]);
    if (stat && !isNaN(val) && val !== 0) {
      if (stat === "R") fR = val;
      if (stat === "HR") fHR = val;
      if (stat === "RBI") fRBI = val;
      if (stat === "NSB" || stat === "SB") fNSB = val;
      if (stat === "OPS") fOPS = val;
      if (stat === "K" || stat === "SO") fK = val;
      if (stat === "QS") fQS = val;
      if (stat === "NSVH" || stat === "SV") fNSVH = val;
      if (stat === "ERA") fERA = val;
      if (stat === "WHIP") fWHIP = val;
    }
  }

  // 2. Load Source Data Maps
  const engineData = _sheetToMap(dataSS, "_ENGINE", "IDPLAYER", true); 
  const playersMap = _sheetToMap(dataSS, "_PLAYERS", "IDPLAYER");
  const rostersMap = _sheetToMap(dataSS, "_ROSTERS", "IDPLAYER");
  const fgBatMap = _sheetToMap(dataSS, "_FG_B", "IDPLAYER");
  const fgPitMap = _sheetToMap(dataSS, "_FG_P", "IDPLAYER");
  const bsBatMap = _sheetToMap(dataSS, "_BS_B", "player_id"); 
  const bsPitMap = _sheetToMap(dataSS, "_BS_P", "player_id"); 
  
  // Phase Logic (Pre-Season vs ROS)
  let fpMap;
  let projPhase = "Pre-Season"; 
  const fpRosSheet = dataSS.getSheetByName("_FP_ROS");
  if (fpRosSheet && fpRosSheet.getLastRow() > 1) {
    fpMap = _sheetToMap(dataSS, "_FP_ROS", "IDPLAYER");
    projPhase = "ROS"; 
  } else {
    fpMap = _sheetToMap(dataSS, "_FP_PRE", "IDPLAYER");
  }

  const projBatMap = _buildSystemProjMap(dataSS, "_FG_PROJ_B");
  const projPitMap = _buildSystemProjMap(dataSS, "_FG_PROJ_P");

  // 3. Formatting Math Helpers
  const cStat = (val) => { const num = parseFloat(val); return isNaN(num) ? 0 : num; };
  const rStat = (rateVal, volVal) => { if (cStat(volVal) === 0) return "-"; return (rateVal !== undefined && rateVal !== "" && rateVal !== null) ? rateVal : "-"; };
  const _diff = (v1, v2, dec) => { const n1 = parseFloat(v1); const n2 = parseFloat(v2); return (isNaN(n1) || isNaN(n2)) ? "" : (n1 - n2).toFixed(dec); };

  const _getSafePid = (map, pid) => {
    if (!pid) return pid;
    if (map[pid]) return pid;
    const noP = pid.endsWith('p') ? pid.slice(0, -1) : pid;
    if (map[noP]) return noP;
    const withP = noP + 'p';
    if (map[withP]) return withP;
    if (pid.includes('ohtansh01')) {
       if (map['ohtansh01']) return 'ohtansh01';
       if (map['ohtansh01p']) return 'ohtansh01p';
    }
    return pid;
  };

  const safeLookup = (map, pid, header) => {
    const safePid = _getSafePid(map, pid);
    return map[safePid] ? map[safePid][header] : undefined;
  };

  const calcSystemSGP = (pid, sysName, type) => {
    sysName = sysName.toLowerCase();
    if (type === "Batter") {
      const safePid = _getSafePid(projBatMap, pid);
      const pData = projBatMap[safePid]?.[sysName];
      if (!pData || !pData["PA"]) return "";
      const opsSGP = (((pData["OPS"] || 0) - bOPS) * pData["PA"] / normPA) / fOPS;
      const sgp = ((pData["R"] || 0)/fR) + ((pData["HR"] || 0)/fHR) + ((pData["RBI"] || 0)/fRBI) + (((pData["SB"] || 0) - (pData["CS"] || 0))/fNSB) + opsSGP;
      return sgp.toFixed(2);
    } else {
      const safePid = _getSafePid(projPitMap, pid);
      const pData = projPitMap[safePid]?.[sysName];
      if (!pData || !pData["IP"]) return "";
      const eraSGP = ((bERA - (pData["ERA"] || 0)) * pData["IP"] / normIP_ERA) / fERA;
      const whipSGP = ((bWHIP - (pData["WHIP"] || 0)) * pData["IP"] / normIP_WHIP) / fWHIP;
      const nsvh = (pData["SV"] || 0) + (pData["HLD"] || 0);
      const sgp = ((pData["SO"] || 0)/fK) + ((pData["QS"] || 0)/fQS) + (nsvh/fNSVH) + eraSGP + whipSGP;
      return sgp.toFixed(2);
    }
  };

  // 4. The Data Compiler (Processes 1 Cell based on Config Layout)
  const _processCell = (cfg, pid, type, row) => {
    if (cfg.source === "BLANK") return "";

    const isBatStat = ["FG_B", "BS_B"].includes(cfg.source) || (cfg.source === "CALC" && ["bNSB", "ΔxwOBA", "xISO"].includes(cfg.type));
    const isPitStat = ["FG_P", "BS_P"].includes(cfg.source) || (cfg.source === "CALC" && ["pNSVH", "P / PA", "ΔERA", "ΔFIP"].includes(cfg.type));

    if (isBatStat && type === "Pitcher") return "";
    if (isPitStat && type === "Batter") return "";

    let rawVal = "";
    if (cfg.source === "ENGINE") {
      rawVal = row[cfg.header];
      if (cfg.header === "IDPLAYER" && rawVal === "ohtansh01p") rawVal = "ohtansh01";
    }
    else if (cfg.source === "FG_B") rawVal = safeLookup(fgBatMap, pid, cfg.header);
    else if (cfg.source === "FG_P") rawVal = safeLookup(fgPitMap, pid, cfg.header);
    else if (cfg.source === "BS_B") rawVal = safeLookup(bsBatMap, pid, cfg.header);
    else if (cfg.source === "BS_P") rawVal = safeLookup(bsPitMap, pid, cfg.header);
    else if (cfg.source === "PLAYERS") rawVal = safeLookup(playersMap, pid, cfg.header);
    else if (cfg.source === "ROSTERS") rawVal = safeLookup(rostersMap, pid, cfg.header);
    else if (cfg.source === "FP") rawVal = safeLookup(fpMap, pid, "RANK") || safeLookup(fpMap, pid, "BEST");
    
    if (cfg.source === "SGP") return calcSystemSGP(pid, cfg.header, type);

    if (cfg.source === "CALC") {
       if (cfg.type === "bNSB") return cStat( (safeLookup(fgBatMap, pid, "SB")||0) - (safeLookup(fgBatMap, pid, "CS")||0) );
       if (cfg.type === "pNSVH") return cStat( (safeLookup(fgPitMap, pid, "SV")||0) + (safeLookup(fgPitMap, pid, "HLD")||0) );
       if (cfg.type === "P / IP") { const val = cStat((safeLookup(fgPitMap, pid, "Pitches")||0) / (safeLookup(fgPitMap, pid, "IP")||0)); return val === 0 ? "" : val; }
       if (cfg.type === "ΔxwOBA") return _diff(safeLookup(fgBatMap, pid, "xwOBA"), safeLookup(fgBatMap, pid, "wOBA"), 3);
       if (cfg.type === "xISO") return _diff(safeLookup(fgBatMap, pid, "xSLG"), safeLookup(fgBatMap, pid, "xAVG"), 3);
       if (cfg.type === "ΔxERA") return _diff(safeLookup(fgPitMap, pid, "xERA"), safeLookup(fgPitMap, pid, "ERA"), 2);
       if (cfg.type === "ΔxFIP") return _diff(safeLookup(fgPitMap, pid, "xFIP"), safeLookup(fgPitMap, pid, "FIP"), 2);
    }

    if (cfg.format === "roster") {
      if (!rawVal || rawVal.toString().trim() === "") return "FA"; 
      const s = rawVal.toString().trim();
      if (s.toLowerCase() === "free agent" || s.toUpperCase() === "FA") return "FA";
      if (s.toLowerCase() === "waivers" || s.toUpperCase() === "W") return "W";
      return s.replace(/Team /ig, "");
    }
    if (cfg.format === "cStat") return cStat(rawVal);
    if (cfg.format === "1dec") { const num = parseFloat(rawVal); return !isNaN(num) ? num.toFixed(1) : ""; }
    if (cfg.format === "rStat") {
       let vol = 0;
       if (cfg.source === "ENGINE") vol = row[cfg.volHeader];
       else if (cfg.source === "FG_B") vol = safeLookup(fgBatMap, pid, cfg.volHeader);
       else if (cfg.source === "FG_P") vol = safeLookup(fgPitMap, pid, cfg.volHeader);
       return rStat(rawVal, vol);
    }

    return (rawVal !== undefined && rawVal !== null) ? rawVal : "";
  };

  // 5. Build Final Output Arrays
  const outAll = [];
  const outBat = [];
  const outPit = [];

  const minBatPA = getDashboardSetting("ENGINE_SEASON_BLENDING", "Minimum batter PA", 150) || 150;
  const minSpIP = getDashboardSetting("ENGINE_SEASON_BLENDING", "Minimum SP IP", 40) || 40;
  const minRpIP = getDashboardSetting("ENGINE_SEASON_BLENDING", "Minimum RP IP", 15) || 15;

  engineData.forEach(row => {
    const pid = row["IDPLAYER"];
    const type = row["Type"];
    const pos = row["Position"] || "";

    const rawRoster = safeLookup(rostersMap, pid, "TEAM_ID");
    let isRostered = false;
    if (rawRoster) {
      const s = rawRoster.toString().trim().toUpperCase();
      if (s !== "" && s !== "FA" && s !== "FREE AGENT" && s !== "W" && s !== "WAIVERS") {
        isRostered = true;
      }
    }

    // DASHBOARD FILTER: Keep non-rostered ghost players completely off the boards
    if (!isRostered) {
      if (type === "Batter") {
        const projPA = cStat(row["PA"]);
        const actPA = cStat(safeLookup(fgBatMap, pid, "PA"));
        if (Math.max(projPA, actPA) < minBatPA) return; 
      } else if (type === "Pitcher") {
        const projIP = cStat(row["IP"]);
        const actIP = cStat(safeLookup(fgPitMap, pid, "IP"));
        const isSP = pos.includes("SP");
        const minIP = isSP ? minSpIP : minRpIP;
        if (Math.max(projIP, actIP) < minIP) return; 
      }
    }

    outAll.push(ALL_PLAYERS_LAYOUT.map(cfg => _processCell(cfg, pid, type, row)));

    if (type === "Batter") {
      outBat.push(BATTERS_LAYOUT.map(cfg => _processCell(cfg, pid, type, row)));
    } else if (type === "Pitcher") {
      outPit.push(PITCHERS_LAYOUT.map(cfg => _processCell(cfg, pid, type, row)));
    }
  });

  // 6. Write Data to Dashboards
  const colStatus = 2; // Column C is index 2
  _writeToDashboard(ss, "All Players", outAll, colStatus, ALL_PLAYERS_LAYOUT.findIndex(c => c.header === "PAR"));
  _writeToDashboard(ss, "Batters", outBat, colStatus, BATTERS_LAYOUT.findIndex(c => c.header === "PAR"));
  _writeToDashboard(ss, "Pitchers", outPit, colStatus, PITCHERS_LAYOUT.findIndex(c => c.header === "PAR"));

  const batSource = getDominantBatSource(projBatMap);
  const iconFormula = batSource === "the bat x" ? "=ICON_THE_BAT_X" : "=ICON_THE_BAT";

  // Targeting the precise new columns for THE BAT X
  // All Players → AW4
  ss.getSheetByName("All Players")?.getRange("AW4").setFormula(iconFormula);
  // Batters → AI4
  ss.getSheetByName("Batters")?.getRange("AI4").setFormula(iconFormula);
  // Pitchers → AJ4
  ss.getSheetByName("Pitchers")?.getRange("AJ4").setFormula(iconFormula);

  Logger.log("Dashboards Compiled Successfully.");
}

// --- HELPER FUNCTIONS ---

function _writeToDashboard(ss, sheetName, dataArray, statusIndex, parIndex) {
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) return;
  
  const lastRow = sheet.getMaxRows();
  if (lastRow >= 5) {
    sheet.getRange(5, 1, lastRow - 4, sheet.getMaxColumns()).clearContent();
  }

  if (dataArray.length > 0) {
    if (statusIndex !== undefined && parIndex !== undefined && statusIndex !== -1 && parIndex !== -1) {
      dataArray.sort((a, b) => {
        const aIsFAW = a[statusIndex] === "FA" || a[statusIndex] === "W";
        const bIsFAW = b[statusIndex] === "FA" || b[statusIndex] === "W";
        
        if (aIsFAW && !bIsFAW) return -1;
        if (!aIsFAW && bIsFAW) return 1;
        
        return (parseFloat(b[parIndex]) || 0) - (parseFloat(a[parIndex]) || 0);
      });
    }
    sheet.getRange(5, 1, dataArray.length, dataArray[0].length).setValues(dataArray);
  }
}

function _sheetToMap(dataSS, sheetName, keyHeader, returnArray = false) {
  const sheet = dataSS.getSheetByName(sheetName);
  const map = returnArray ? [] : {};
  if (!sheet || sheet.getLastRow() < 2) return map;

  const data = sheet.getDataRange().getValues();
  const headers = data[0].map(h => h.toString().trim()); 
  const keyIdx = headers.findIndex(h => h.toUpperCase() === keyHeader.toUpperCase());

  if (keyIdx === -1) return map;

  for (let i = 1; i < data.length; i++) {
    const key = data[i][keyIdx]?.toString().trim();
    if (!key) continue;

    const rowObj = {};
    headers.forEach((h, idx) => { rowObj[h] = data[i][idx]; });

    if (returnArray) map.push(rowObj);
    else map[key] = rowObj;
  }
  return map;
}

function _buildSystemProjMap(dataSS, sheetName) {
  const sheet = dataSS.getSheetByName(sheetName);
  const map = {};
  if (!sheet || sheet.getLastRow() < 2) return map;

  const data = sheet.getDataRange().getValues();
  const headers = data[0].map(h => h.toString().trim().toUpperCase());

  const getCol = (name) => headers.indexOf(name);
  const idIdx = getCol("IDPLAYER");
  const sysIdx = getCol("PROJECTIONS");
  const typeIdx = getCol("TYPE");

  const temp = {};

  for (let i = 1; i < data.length; i++) {
    const pid = data[i][idIdx]?.toString().trim();
    const sys = data[i][sysIdx]?.toString().trim().toLowerCase();
    const type = data[i][typeIdx]?.toString().trim(); 

    if (!pid || !sys || !type) continue;

    if (!temp[pid]) temp[pid] = {};
    if (!temp[pid][sys]) temp[pid][sys] = {};

    const rowObj = {};
    headers.forEach((h, idx) => {
      if (['IDPLAYER','IDFANGRAPHS','YEAR','PROJECTIONS','TYPE','PLAYERNAME','TEAM'].includes(h)) return;
      rowObj[h] = parseFloat(data[i][idx]) || 0;
    });

    temp[pid][sys][type] = rowObj;
  }

  function pickWithSource(pid, systems) {
    for (let s of systems) {
      const sys = temp[pid]?.[s];
      if (!sys) continue;

      if (sys["ROS"]) return { data: sys["ROS"], source: s };
      if (sys["Pre-Season"]) return { data: sys["Pre-Season"], source: s };
    }
    return { data: null, source: null };
  }

  for (let pid in temp) {
    map[pid] = {};

    const result = pickWithSource(pid, ["the bat x", "the bat"]);
    map[pid]["the bat x"] = result.data;

    if (!map["_meta"]) map["_meta"] = {};
    map["_meta"][pid] = result.source;

    for (let sys in temp[pid]) {
      if (sys === "the bat x" || sys === "the bat") continue;
      map[pid][sys] = temp[pid][sys]["ROS"] || temp[pid][sys]["Pre-Season"];
    }
  }

  return map;
}

function getDominantBatSource(projMap) {
  const counts = { "the bat x": 0, "the bat": 0 };
  if (!projMap["_meta"]) return "the bat x";
  for (let pid in projMap["_meta"]) {
    const src = projMap["_meta"][pid];
    if (counts[src] !== undefined) counts[src]++;
  }
  return counts["the bat x"] >= counts["the bat"] ? "the bat x" : "the bat";
}