/**
 * FILE: yahooAuthentication.gs
 * PURPOSE: Manages Yahoo OAuth2 authentication for all Yahoo Fantasy
 * Sports API calls. Handles token acquisition, storage,
 * refresh, and expiry. All Yahoo API scripts route through
 * this file — nothing calls the Yahoo API directly.
 *
 * READS FROM: Named ranges in master sheet (LEAGUE_KEY)
 * Google Apps Script Properties (token storage)
 * Google Apps Script Properties (Script Properties for credentials)
 * WRITES TO:  Google Apps Script Properties (token storage)
 * CALLED BY:  helperFunctions.gs (fetchYahooAPI, fetchAllYahooAPI)
 * Any script needing Yahoo API access
 * DEPENDENCIES: OAuth2 library (must be added via Apps Script library manager)
 *
 * OAUTH2 LIBRARY SETUP (one-time):
 * 1. In Apps Script editor → Libraries (+ icon)
 * 2. Script ID: 1B7FSrk5Zi6L1rSxxTDgDEUsPzlukDsi4KGuTMorsTQHhGBzBkMun4iDF
 * 3. Select latest version → Add
 * Docs: https://github.com/googleworkspace/apps-script-oauth2
 *
 * YAHOO APP SETUP (one-time):
 * 1. https://developer.yahoo.com/apps/create/
 * 2. Application Type: Installed Application (Native)
 * 3. API Permissions: Fantasy Sports → Read
 * 4. Add YAHOO_CLIENT_ID and YAHOO_CLIENT_SECRET to Apps Script 
 * Project Settings -> Script Properties.
 * 5. Add your script's callback URL to the Yahoo app's redirect URIs:
 * Run getAuthorizationUrl() once — it logs the callback URL to use
 *
 * FIRST-TIME AUTH FLOW:
 * 1. Run getAuthorizationUrl() — logs a URL to the Apps Script console
 * 2. Open that URL in your browser
 * 3. Approve access on the Yahoo consent screen
 * 4. You will be redirected to a success page
 * 5. Token is now stored in Apps Script User Properties
 * 6. Run checkAuthStatus() to confirm — should log 'Authorized: true'
 * Token is valid for 1 hour then auto-refreshed by the OAuth2 library.
 * Re-authorization is only required if you revoke access or the
 * refresh token expires (typically after extended inactivity).
 *
 * SECURITY NOTE:
 * Client ID and Client Secret are now stored in Script Properties.
 * They are no longer hardcoded in this file, making it safe to
 * commit to a public GitHub repository.
 */

// ============================================================
//  OAUTH2 SERVICE
// ============================================================

/**
 * Creates and returns a configured Yahoo OAuth2 service instance.
 * The service handles token storage, refresh, and expiry automatically.
 * Tokens are stored per-user in Apps Script User Properties —
 * they persist across executions until revoked or expired.
 *
 * Pulls the YAHOO_CLIENT_ID and YAHOO_CLIENT_SECRET securely from 
 * the Apps Script Project Settings (Script Properties).
 *
 * @returns {OAuth2.Service} Configured OAuth2 service
 */
function getYahooService() {
  // Retrieve secure credentials from Script Properties instead of hardcoding
  const scriptProps = PropertiesService.getScriptProperties();
  const clientId = scriptProps.getProperty('YAHOO_CLIENT_ID');
  const clientSecret = scriptProps.getProperty('YAHOO_CLIENT_SECRET');

  // Failsafe: Alert the user if the properties are missing
  if (!clientId || !clientSecret) {
    throw new Error('Missing Yahoo API credentials. Please add YAHOO_CLIENT_ID and YAHOO_CLIENT_SECRET to your Apps Script Project Settings -> Script Properties.');
  }

  return OAuth2.createService('Yahoo')
    .setAuthorizationBaseUrl('https://api.login.yahoo.com/oauth2/request_auth')
    .setTokenUrl('https://api.login.yahoo.com/oauth2/get_token')
    .setClientId(clientId)
    .setClientSecret(clientSecret)
    .setCallbackFunction('authCallback')
    .setPropertyStore(PropertiesService.getUserProperties())
    .setScope('fspt-r')         // fspt-r = Fantasy Sports read-only
    .setParam('response_type', 'code');
}


// ============================================================
//  AUTHORIZATION FLOW
// ============================================================

/**
 * Returns the URL the user must visit to authorize this app with Yahoo.
 * Run this function manually from the Apps Script editor on first setup,
 * or any time you need to re-authorize.
 *
 * Output appears in the Apps Script Execution Log (View → Logs).
 * Copy the URL, open it in a browser, and approve access.
 *
 * @returns {string} Authorization URL or confirmation if already authorized
 */
function getAuthorizationUrl() {
  const service = getYahooService();

  if (service.hasAccess()) {
    Logger.log('Already authorized. No action needed.');
    Logger.log('Run revokeYahooAccess() first if you need to re-authorize.');
    return 'Already authorized.';
  }

  const authUrl = service.getAuthorizationUrl();
  Logger.log('Visit this URL to authorize:');
  Logger.log(authUrl);
  return authUrl;
}


/**
 * OAuth2 callback handler. Called automatically by Google when the user
 * completes the Yahoo authorization flow and is redirected back.
 * Must be named exactly 'authCallback' to match setCallbackFunction above.
 * Do not rename or call this function manually.
 *
 * @param {Object} request - The incoming HTTP request from Yahoo redirect
 * @returns {HtmlOutput} Success or failure page shown to the user
 */
function authCallback(request) {
  const service    = getYahooService();
  const authorized = service.handleCallback(request);

  if (authorized) {
    Logger.log('authCallback: authorization successful.');
    return HtmlService.createHtmlOutput(
      '<h2>Authorization successful.</h2>' +
      '<p>You can close this tab and return to Google Sheets.</p>'
    );
  } else {
    Logger.log('authCallback: authorization denied or failed.');
    return HtmlService.createHtmlOutput(
      '<h2>Authorization denied.</h2>' +
      '<p>Close this tab and run getAuthorizationUrl() again to retry.</p>'
    );
  }
}


// ============================================================
//  TOKEN ACCESS
// ============================================================

/**
 * Returns the current OAuth2 access token string.
 * Used by fetchYahooAPI() in helperFunctions.gs to set the
 * Authorization header on all Yahoo API requests.
 *
 * Returns null if not authorized — callers should check
 * hasYahooAccess() before calling this.
 *
 * @returns {string|null} Bearer token or null
 */
function getYahooAccessToken() {
  const service = getYahooService();
  if (!service.hasAccess()) {
    Logger.log('getYahooAccessToken: not authorized. Run getAuthorizationUrl().');
    return null;
  }
  return service.getAccessToken();
}


/**
 * Returns whether the Yahoo OAuth2 service currently has a valid token.
 * Call this as a guard before any Yahoo API operation.
 *
 * @returns {boolean}
 */
function hasYahooAccess() {
  return getYahooService().hasAccess();
}


// ============================================================
//  UTILITIES
// ============================================================

/**
 * Reads the league key from the LEAGUE_KEY named range in the master sheet.
 * Centralizes this lookup so all scripts use the same source.
 * The named range must exist in the master (active) spreadsheet Settings sheet.
 *
 * @returns {string} Yahoo league key, e.g. '431.l.12345'
 */
function getLeagueKey() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const range = ss.getRangeByName('LEAGUE_KEY');
  if (!range) {
    Logger.log('getLeagueKey: named range LEAGUE_KEY not found in master sheet.');
    return '';
  }
  return range.getValue().toString().trim();
}


/**
 * Logs current authorization status to the Apps Script execution log.
 * Run manually to confirm auth is working before running data scripts.
 * Also useful for debugging — if data scripts return null, run this first.
 */
function checkAuthStatus() {
  const service = getYahooService();
  Logger.log('Authorized: ' + service.hasAccess());

  if (service.hasAccess()) {
    Logger.log('Token appears valid. Yahoo API calls should work.');
  } else {
    Logger.log('Not authorized. Run getAuthorizationUrl() and complete the flow.');
  }
}


/**
 * Revokes the stored Yahoo OAuth2 token and clears it from User Properties.
 * Use this if you need to switch Yahoo accounts, rotate credentials,
 * or troubleshoot authorization issues.
 * After revoking, run getAuthorizationUrl() to re-authorize.
 */
function revokeYahooAccess() {
  const service = getYahooService();
  service.reset();
  Logger.log('revokeYahooAccess: token cleared. Run getAuthorizationUrl() to re-authorize.');
}