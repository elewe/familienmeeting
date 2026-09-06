const { bringHeaders, setCors } = require('./_shared');

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const auth = req.headers.authorization;
  const { uuid, listUuid, items } = req.body || {};
  if (!auth || !uuid || !listUuid || !Array.isArray(items) || !items.length) {
    res.status(400).json({ error: 'uuid, listUuid und items erforderlich' });
    return;
  }

  try {
    for (const item of items) {
      const body = new URLSearchParams({
        purchase: item.name || '',
        specification: item.specification || '',
        recently: '',
        remove: '',
        sender: 'null',
      }).toString();
      const bringRes = await fetch(`https://api.getbring.com/rest/v2/bringlists/${encodeURIComponent(listUuid)}`, {
        method: 'PUT',
        headers: bringHeaders({
          Authorization: auth,
          'X-BRING-USER-UUID': uuid,
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        }),
        body,
      });
      if (!bringRes.ok) {
        res.status(bringRes.status).json({ error: `Artikel "${item.name}" konnte nicht gesendet werden` });
        return;
      }
    }
    res.status(200).json({ ok: true, count: items.length });
  } catch (e) {
    res.status(502).json({ error: 'Bring ist gerade nicht erreichbar.' });
  }
};
