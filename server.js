const express = require('express');
const QRCode = require('qrcode');
const path = require('path');
const crypto = require('crypto');  // Para tokens seguros en todas las rutas

// Puppeteer condicional: full para local, core + chromium para Vercel
let puppeteer, chromium;
if (process.env.VERCEL_URL) {
  // Prod: Serverless
  puppeteer = require('puppeteer-core');
  chromium = require('@sparticuz/chromium');
} else {
  // Local: Full con Chrome embebido
  puppeteer = require('puppeteer');
}
const { kv } = require('@vercel/kv');  // KV real (sin mock)

const app = express();
app.set('trust proxy', true);
app.use(express.json());
app.get('/favicon.ico', (req, res) => res.status(204).end());

function logDebug(mensaje) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${mensaje}`);
}

function formatearFecha(fechaISO) {
  try {
    const fecha = new Date(fechaISO);
    if (isNaN(fecha.getTime())) return 'Fecha inválida';
    const opciones = {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
      timeZone: 'America/Bogota' 
    };
    return fecha.toLocaleDateString('es-CO', opciones);  // Uniformizado a es-CO
  } catch (e) {
    return 'Fecha inválida';
  }
}

// Helpers KV (persistente)
async function loadPendingEntregas() {
  logDebug('[KV DEBUG] Cargando pending-entregas con Vercel KV');  // Log para debug
  const json = await kv.get('pending-entregas');
  logDebug(`[KV DEBUG] Raw json from get: ${json ? 'OK (' + (typeof json === 'string' ? json.length : 'object') + ' chars)' : 'NULL - No data yet'}`);
  if (json) {
    const arr = JSON.parse(json);
    const now = Date.now();
    const active = arr.filter(e => !e.asistido && now < e.expira);
    logDebug(`[KV LOAD] Filtrando: ${arr.length} total -> ${active.length} activos. Removidos: ${arr.length - active.length} (expirados/usados)`);
    if (active.length !== arr.length) {
      await savePendingEntregas(active);
      logDebug(`Limpieza KV: Removidos ${arr.length - active.length}. Activos: ${active.length}`);
    }
    return active;
  }
  return [];
}

async function savePendingEntregas(arr) {
  await kv.set('pending-entregas', JSON.stringify(arr));
}

async function loadConfirmed() {
  const json = await kv.get('confirmed');
  logDebug(`DEBUG loadConfirmed: Raw ${JSON.stringify(json)}`);  // Para logs
  return json ? JSON.parse(json) : [];
}

async function saveConfirmed(arr) {
  await kv.set('confirmed', JSON.stringify(arr));
}

async function agregarConfirmacion(cliente, ruta, fechaISO, productos = []) {
  const timestamp = new Date().toISOString();
  const productosStr = productos.map(p => `${p.cantidad} ${p.nombre}`).join(', ');
  const newConf = { 
    timestamp, 
    cliente, 
    ruta, 
    fechaISO, 
    productosStr 
  };
  const confirmed = await loadConfirmed();
  confirmed.push(newConf);
  await saveConfirmed(confirmed);
  logDebug(`Confirmación guardada KV: ${cliente} | Ruta: ${ruta} | Productos: ${productosStr}`);
}

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/cliente.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'cliente.html')));
app.get('/confirmar.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'confirmar.html')));
app.get('/admin.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

app.get('/generate-token', async (req, res) => {
  const { cliente = 'Cliente Test', ruta = 'Ruta Test', productos = '[]' } = req.query;
  const token = crypto.randomBytes(16).toString('hex');  // 32 chars, más seguro
  const expira = Date.now() + 24 * 60 * 60 * 1000;
  let productosParsed = [];
  try {
    productosParsed = JSON.parse(decodeURIComponent(productos));
  } catch (e) {
    logDebug(`[ERROR] Parse productos: ${e} - Usando []`);  // Log mejorado
    productosParsed = [];
  }
  const entregas = await loadPendingEntregas();
  entregas.push({ 
    id: Date.now(), 
    token, 
    cliente, 
    ruta, 
    productos: productosParsed,
    expira, 
    asistido: false, 
    llegada: null 
  });
  await savePendingEntregas(entregas);
  
  // Delay temporal para KV sync (opcional, quítalo después)
  await new Promise(resolve => setTimeout(resolve, 500));
  
  logDebug(`[DEBUG] Post-save: Verificando token ${token} en entregas...`);
  const verify = await loadPendingEntregas();  // Recarga para check
  const found = verify.find(e => e.token === token);
  if (!found) {
    logDebug(`[ERROR] Token ${token} NO se guardó en KV!`);
  } else {
    logDebug(`[OK] Token ${token} guardado: expira ${new Date(found.expira).toISOString()}`);
  }
   
  const baseUrl = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : `${req.protocol}://${req.get('host')}`;
  const urlCliente = `${baseUrl}/cliente.html?token=${token}`;
  
  logDebug(`Token generado: ${token} | Cliente: ${cliente} | Ruta: ${ruta} | Expira: ${new Date(expira).toISOString()}`);
  res.json({ token, urlCliente }); 
});

app.get('/generar-qr/:cliente/:ruta', async (req, res) => {
  const { cliente, ruta } = req.params;
  const { productos = '[]' } = req.query;
  const token = crypto.randomBytes(16).toString('hex');  // Uniformizado con crypto
  const expira = Date.now() + 24 * 60 * 60 * 1000;
  let productosParsed = [];
  try {
    productosParsed = JSON.parse(decodeURIComponent(productos));
  } catch (e) {
    logDebug(`[ERROR] Parse productos: ${e} - Usando []`);
    productosParsed = [];
  }
  const entregas = await loadPendingEntregas();
  entregas.push({ 
    id: Date.now(), 
    token, 
    cliente, 
    ruta, 
    productos: productosParsed,
    expira, 
    asistido: false,
    llegada: null
  });
  await savePendingEntregas(entregas);
  
  // Delay temporal para KV sync
  await new Promise(resolve => setTimeout(resolve, 500));
  
  logDebug(`[DEBUG] Post-save: Verificando token ${token} en entregas...`);
  const verify = await loadPendingEntregas();
  const found = verify.find(e => e.token === token);
  if (!found) {
    logDebug(`[ERROR] Token ${token} NO se guardó en KV!`);
  } else {
    logDebug(`[OK] Token ${token} guardado: expira ${new Date(found.expira).toISOString()}`);
  }
  
  const baseUrl = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : `${req.protocol}://${req.get('host')}`;
  const urlCliente = `${baseUrl}/cliente.html?token=${token}`;
  
  logDebug(`QR token: ${token} | Cliente: ${cliente} | Ruta: ${ruta} | Expira: ${new Date(expira).toISOString()}`);
  res.json({ token, urlCliente }); 
});

app.get('/qr-image/:token', async (req, res) => {
  const { token } = req.params;
  logDebug(`Solicitando QR para token: ${token}`);
  
  const entregas = await loadPendingEntregas();
  logDebug(`[DEBUG QR] Buscando token ${token}: ${entregas.length} pendientes total`);
  const entrega = entregas.find(e => e.token === token);
  let reason = '';
  if (!entrega) { 
    reason = 'no token match - Entregas vacías o no match'; 
    logDebug(`[ERROR QR] ${reason} para ${token}. Entregas tokens: ${entregas.map(e => e.token).join(', ')}`);
  } else if (entrega.asistido) { reason = 'already asistido'; }
  else if (Date.now() >= entrega.expira) { 
    reason = `expired - now ${Date.now()} vs expira ${entrega.expira}`; 
  }
  
  if (!entrega || reason) {
    logDebug(`ERROR QR: ${reason}: ${token}`);
    return res.status(404).send('Expirado, ya usado o inválido');
  }
  
  const timestamp = Date.now();
  const subToken = Buffer.from(token + timestamp).toString('base64').substring(0, 10); 
  
  const baseUrl = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : `${req.protocol}://${req.get('host')}`;
  const data = `${baseUrl}/confirmar.html?token=${token}&subToken=${subToken}&timestamp=${timestamp}`;
  
  logDebug(`QR data: ${data}`);
  
  const qr = await QRCode.toDataURL(data);
  res.send(qr);
});

app.post('/confirmar-sub', async (req, res) => {
  const { subToken, timestamp, mainToken } = req.body;  

  if (!mainToken || mainToken === 'undefined' || mainToken.trim() === '') {
    logDebug('Error: mainToken vacío en POST');
    return res.json({ ok: false, msg: 'Token requerido' });
  }
  
  logDebug(`Confirmando: token=${mainToken}, subToken=${subToken}, timestamp=${timestamp}`);
  
  const expectedSub = Buffer.from(mainToken + timestamp).toString('base64').substring(0, 10);
  if (subToken !== expectedSub || Date.now() > (parseInt(timestamp) + 24 * 60 * 60 * 1000)) {
    logDebug(`Sub inválido: ${subToken} vs ${expectedSub}`);
    return res.json({ ok: false, msg: 'Sub-token inválido o expirado' });
  }
  
  const entregas = await loadPendingEntregas();
  const entrega = entregas.find(e => e.token === mainToken && !e.asistido && Date.now() < e.expira);
  if (!entrega) {
    logDebug(`Entrega no encontrada para ${mainToken}`);
    return res.json({ ok: false, msg: 'Token expirado o ya usado' });
  }
  
  entrega.asistido = true;
  entrega.llegada = new Date().toISOString();
  await savePendingEntregas(entregas);
  
  await agregarConfirmacion(entrega.cliente, entrega.ruta, entrega.llegada, entrega.productos);
  
  res.json({ ok: true, msg: `¡Asistencia confirmada para ${entrega.cliente} en ruta ${entrega.ruta}! Productos: ${entrega.productos.map(p => `${p.cantidad} ${p.nombre}`).join(', ')}` });
});

app.get('/asistencias', async (req, res) => {
  const confirmed = await loadConfirmed();
  const asistidas = confirmed.map(conf => ({
    cliente: conf.cliente,
    ruta: conf.ruta,
    productos: conf.productosStr ? conf.productosStr.split(', ').map(str => {
      const [cant, ...nom] = str.split(' ');
      return { cantidad: cant, nombre: nom.join(' ') };
    }) : [],
    llegada: conf.fechaISO
  }));
  res.json(asistidas);
});

app.get('/debug-tokens', async (req, res) => {
  const entregas = await loadPendingEntregas();
  res.json(entregas.map(e => ({ 
    token: e.token, 
    cliente: e.cliente, 
    productos: e.productos,
    expira: new Date(e.expira).toISOString(),  // Formato legible
    asistido: e.asistido 
  })));
});

app.get('/finalizar-pdf', async (req, res) => {
  try {
    logDebug('DEBUG PDF: Iniciando');
    const rawConfirmed = await kv.get('confirmed');
    logDebug(`DEBUG PDF: Raw KV: ${JSON.stringify(rawConfirmed)}`);

    const confirmaciones = await loadConfirmed();
    logDebug(`DEBUG PDF: Length: ${confirmaciones.length}`);

    if (confirmaciones.length === 0) {
      logDebug('DEBUG PDF: Vacío - abort');
      return res.status(400).send('No hay confirmaciones para generar PDF. (Genera una asistencia primero).');
    }

    logDebug(`DEBUG PDF: Generando con ${confirmaciones.length}`);
    let browser;
    if (process.env.VERCEL_URL) {
      // Prod: Usa chromium serverless
      browser = await puppeteer.launch({
        args: chromium.args,
        defaultViewport: chromium.defaultViewport,
        executablePath: await chromium.executablePath(),
        headless: chromium.headless,
        ignoreHTTPSErrors: true,
      });
    } else {
      // Local: Usa full Puppeteer con Chrome embebido
      browser = await puppeteer.launch({ 
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']  // Fix común para local
      });
    }
    const page = await browser.newPage();
    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <title>Reporte de Confirmaciones</title>
          <style>
            body { font-family: Arial, sans-serif; margin: 20px; background-color: #042b17ff; color: #ffffffff; }
            h1 { text-align: center; color: #ffffffff; }
            table { width: 100%; border-collapse: collapse; background-color: #082519ff; }
            th, td { border: 1px solid #ffffffff; padding: 8px; text-align: left; color: #ffffffff; }
            th { background-color: #042b17ff; font-weight: bold; }
            .cliente { width: 25%; }
            .ruta { width: 20%; }
            .productos { width: 35%; }
            .fecha { width: 20%; }
            tr:nth-child(even) { background-color: #052913ff; }
            tr:nth-child(odd) { background-color: #082519ff; }
            p { color: #ffffffff; }
          </style>
        </head>
        <body>
          <h1>Reporte de Confirmaciones</h1>
          <p><strong>Total:</strong> ${confirmaciones.length}</p>
          <p><strong>Actualización:</strong> ${new Date().toLocaleDateString('es-CO', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'America/Bogota' })}</p>
          <table>
            <thead>
              <tr>
                <th class="cliente">Cliente</th>
                <th class="ruta">Ruta</th>
                <th class="productos">Productos</th>
                <th class="fecha">Hora</th>
              </tr>
            </thead>
            <tbody>
              ${confirmaciones.map(conf => `
                <tr>
                  <td class="cliente">${conf.cliente}</td>
                  <td class="ruta">${conf.ruta}</td>
                  <td class="productos">${conf.productosStr || 'Sin productos'}</td>
                  <td class="fecha">${formatearFecha(conf.fechaISO)}</td>
                </tr>
              `).reverse().join('')}
            </tbody>
          </table>
          <p><strong>Fin.</strong></p>
        </body>
      </html>
    `;

    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '20px', right: '20px', bottom: '20px', left: '20px' }
    });

    await browser.close();

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=reporte-${new Date().toISOString().split('T')[0]}.pdf`);
    res.send(pdfBuffer);

    logDebug(`PDF exitoso (${confirmaciones.length})`);
  } catch (error) {
    logDebug(`ERROR PDF: ${error.message}`);
    res.status(500).send('Error PDF: ' + error.message);
  }
});

app.get('/get-entrega/:token', async (req, res) => {
  const { token } = req.params;
  const entregas = await loadPendingEntregas();
  const entrega = entregas.find(e => e.token === token && !e.asistido && Date.now() < e.expira);
  if (!entrega) return res.status(404).json({ error: 'Token inválido' });
  res.json({
    cliente: entrega.cliente,
    ruta: entrega.ruta,
    productos: entrega.productos || []
  });
});

app.delete('/borrar-logs', async (req, res) => {
  await kv.del('confirmed');
  logDebug('Borrado KV confirmed');
  res.json({ ok: true, msg: 'Reiniciado' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor en puerto ${PORT}`);
});

module.exports = app;