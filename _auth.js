/**
 * @file _auth.gs
 * @description Manages Yahoo OAuth2 authentication for all Yahoo Fantasy Sports API calls.
 * Handles token acquisition, storage, refresh, and expiry.
 * @dependencies OAuth2 library (Script ID: 1B7FSrk5Zi6L1rSxxTDgDEUsPzlukDsi4KGuTMorsTQHhGBzBkMun4iDF)
 */

// ============================================================================
//  CREDENTIALS
//  Replace with your Yahoo app's Client ID and Client Secret.
// ============================================================================
const CLIENT_ID     = 'dj0yJmk9OU9zeHBOYkFnMlpHJmQ9WVdrOVV6RTJNakJwTmt3bWNHbzlNQT09JnM9Y29uc3VtZXJzZWNyZXQmc3Y9MCZ4PTMz';
const CLIENT_SECRET = '5308c4f752665594023bb6a3ebe885ebf3e25d4e';

// ============================================================================
//  OAUTH2 SERVICE CONFIGURATION
// ============================================================================

/**
 * Creates and returns a configured Yahoo OAuth2 service instance.
 * @returns {OAuth2.Service} Configured OAuth2 service.
 */
function _getYahooService() {
  return OAuth2.createService('Yahoo')
    .setAuthorizationBaseUrl('https://api.login.yahoo.com/oauth2/request_auth')
    .setTokenUrl('https://api.login.yahoo.com/oauth2/get_token')
    .setClientId(CLIENT_ID)
    .setClientSecret(CLIENT_SECRET)
    .setCallbackFunction('authCallback')
    .setPropertyStore(PropertiesService.getUserProperties())
    .setScope('fspt-r') // fspt-r = Fantasy Sports read-only
    .setParam('response_type', 'code');
}

// ============================================================================
//  AUTHORIZATION FLOW (PUBLIC)
// ============================================================================

/**
 * Generates the URL the user must visit to authorize this app with Yahoo.
 * Output appears in the Apps Script Execution Log.
 * @returns {string} Authorization URL.
 */
function getAuthorizationUrl() {
  const service = _getYahooService();
  if (service.hasAccess()) {
    Logger.log('Already authorized. No action needed.');
    return 'Already authorized.';
  }
  const authUrl = service.getAuthorizationUrl();
  Logger.log('Visit this URL to authorize:\n' + authUrl);
  return authUrl;
}

/**
 * OAuth2 callback handler. Called automatically by Google upon redirect.
 * @param {Object} request - The incoming HTTP request from Yahoo redirect.
 * @returns {HtmlOutput} Success or failure page.
 */
function authCallback(request) {
  const service = _getYahooService();
  const authorized = service.handleCallback(request);
  if (authorized) {
    return HtmlService.createHtmlOutput('<h2>Authorization successful.</h2><p>You can close this tab.</p>');
  } else {
    return HtmlService.createHtmlOutput('<h2>Authorization denied.</h2><p>Close this tab and try again.</p>');
  }
}

// ============================================================================
//  TOKEN ACCESS & UTILITIES
// ============================================================================

/**
 * Returns the current OAuth2 access token string.
 * @returns {string|null} Bearer token or null if unauthorized.
 */
function _getYahooAccessToken() {
  const service = _getYahooService();
  if (!service.hasAccess()) {
    _logError('_auth.gs', 'Not authorized. Run getAuthorizationUrl()', 'CRITICAL');
    return null;
  }
  return service.getAccessToken();
}

/**
 * Checks if the Yahoo OAuth2 service currently has a valid token.
 * @returns {boolean} True if authorized.
 */
function _hasYahooAccess() {
  return _getYahooService().hasAccess();
}

/**
 * Reads the league key from the LEAGUE_KEY named range in the Primary sheet.
 * @returns {string} Yahoo league key.
 */
function _getLeagueKey() {
  const ss = getPrimarySS();
  const range = ss.getRangeByName('LEAGUE_KEY');
  if (!range) {
    _logError('_auth.gs', 'Named range LEAGUE_KEY not found in Primary workbook.', 'HIGH');
    return '';
  }
  return range.getValue().toString().trim();
}

/**
 * Revokes the stored Yahoo OAuth2 token and clears it from User Properties.
 */
function revokeYahooAccess() {
  _getYahooService().reset();
  Logger.log('Token cleared. Run getAuthorizationUrl() to re-authorize.');
}