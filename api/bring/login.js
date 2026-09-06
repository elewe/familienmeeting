const { bringHeaders, setCors } = require('./_shared');

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const { email, password } = req.body || {};
  if (!email || !password) { res.status(400).json({ error: 'E-Mail und Passwort erforderlich' }); return; }

  try {
    const bringRes = await fetch('https://api.getbring.com/rest/v2/bringauth', {
      method: 'POST',
      headers: bringHeaders({ 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' }),
      body: new URLSearchParams({ email, password }).toString(),
    });
    const data = await bringRes.json().catch(() => null);
    if (!bringRes.ok || !data?.access_token) {
      res.status(401).json({ error: 'Bring-Login fehlgeschlagen. E-Mail/Passwort prüfen.' });
      return;
    }
    res.status(200).json({
      uuid: data.uuid,
      accessToken: data.access_token,
      expiresIn: data.expires_in,
      name: data.name,
    });
  } catch (e) {
    res.status(502).json({ error: 'Bring ist gerade nicht erreichbar.' });
  }
};
