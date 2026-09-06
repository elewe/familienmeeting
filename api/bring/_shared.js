// Öffentlicher API-Key aus der Android-App, seit Jahren stabil in allen
// Community-Bring!-Integrationen (Home Assistant u.a.) im Einsatz.
const BRING_API_KEY = 'cof4Nc6D8saplXjE3h3HXqHH8m7VU2i1Gs0g85Sp';

function bringHeaders(extra = {}) {
  return {
    'X-BRING-API-KEY': BRING_API_KEY,
    'X-BRING-CLIENT': 'android',
    'X-BRING-CLIENT-SOURCE': 'android',
    'X-BRING-COUNTRY': 'de',
    'X-BRING-VERSION': '303070050',
    ...extra,
  };
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

module.exports = { bringHeaders, setCors };
