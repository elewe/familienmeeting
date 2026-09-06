const { bringHeaders, setCors } = require('./_shared');

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const uuid = req.query.uuid;
  const auth = req.headers.authorization;
  if (!uuid || !auth) { res.status(400).json({ error: 'uuid und Authorization erforderlich' }); return; }

  try {
    const bringRes = await fetch(`https://api.getbring.com/rest/v2/bringusers/${encodeURIComponent(uuid)}/lists`, {
      headers: bringHeaders({ Authorization: auth, 'X-BRING-USER-UUID': uuid }),
    });
    const data = await bringRes.json().catch(() => null);
    if (!bringRes.ok) { res.status(bringRes.status).json({ error: 'Listen konnten nicht geladen werden' }); return; }
    res.status(200).json({ lists: data.lists || [] });
  } catch (e) {
    res.status(502).json({ error: 'Bring ist gerade nicht erreichbar.' });
  }
};
