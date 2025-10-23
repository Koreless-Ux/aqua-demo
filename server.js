const express = require('express');
const QRCode = require('qrcode');
const path = require('path');
const puppeteer = require('puppeteer');
const { kv } = require('@vercel/kv');  // NUEVO: Import para Vercel KV
const app = express();
app.set('trust proxy', true);
// app.use(express.static('public'));  // COMENTADO: Ignorado en Vercel, usa CDN para /public
app.use(express.json());
app.get('/favicon.ico', (req, res) => res.status(204).end());

function logDebug(mensaje) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${mensaje}`);
}

function formatearFecha(fechaISO) {
  const fecha = new Date(fechaISO);
  const opciones = {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
    timeZone: 'America/Bogota' 
  };
  return fecha.toLocaleDateString('es-BO', opciones); 
}

// NUEVO: Funciones helper para KV (persistente y con limpieza de expirados)
async function loadPendingEntregas() {
  const json = await kv.get('pending-entregas');
  if (json) {
    const arr = JSON.parse(json);
    const now = Date.now();
    const active = arr.filter(e => !e.asistido && now < e.expira);
    if (active.length !== arr.length) {
      await savePendingEntregas(active);  // Limpia expirados/asistidos automáticamente
      logDebug(`Limpieza KV: ${arr.length - active.length} tokens removidos. Activos: ${active.length}`);
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
  logDebug(`DEBUG loadConfirmed: Raw JSON ${JSON.stringify(json)}`);  // Para logs
  return json ? JSON.parse(json) : [];
}

async function saveConfirmed(arr) {
  await kv.set('confirmed', JSON.stringify(arr));
}

// NUEVO: Agregar confirmación a KV (sin fs)
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
  logDebug(`Confirmación guardada en KV: ${cliente} | Ruta: ${ruta} | Productos: ${productosStr}`);
}

app.get('/', (req, res) => {
  const filePath = path.join(__dirname, 'public', 'admin.html');
  res.type('text/html'); 
  res.sendFile(filePath);
});

// Rutas explícitas para HTML (funcionan en Vercel)
app.get('/cliente.html', (req, res) => {
  try {
    res.sendFile(path.join(__dirname, 'public', 'cliente.html'));
  } catch (e) {
    console.log('Error sirviendo cliente.html:', e);
    res.status(404).send('Archivo no encontrado');
  }
});
app.get('/confirmar.html', (req, res) => {
  try {
    res.sendFile(path.join(__dirname, 'public', 'confirmar.html'));
  } catch (e) {
    console.log('Error sirviendo confirmar.html:', e);
    res.status(404).send('Archivo no encontrado');
  }
});
app.get('/admin.html', (req, res) => {
  try {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
  } catch (e) {
    console.log('Error sirviendo admin.html:', e);
    res.status(404).send('Archivo no encontrado');
  }
});

app.get('/generate-token', async (req, res) => {  // ASYNC: NUEVO
  const { cliente = 'Cliente Test', ruta = 'Ruta Test', productos = '[]' } = req.query;
  const token = Math.random().toString(36).substring(7); 
  const expira = Date.now() + 24 * 60 * 60 * 1000;  // 24 horas
  let productosParsed = [];
  try {
    productosParsed = JSON.parse(decodeURIComponent(productos));
  } catch (e) {
    console.log('Error parseando productos:', e);
  }
  const entregas = await loadPendingEntregas();  // NUEVO: Carga desde KV
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
  await savePendingEntregas(entregas);  // NUEVO: Guarda en KV
   
  const baseUrl = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : `${req.protocol}://${req.get('host')}`;
  const urlCliente = `${baseUrl}/cliente.html?token=${token}`;
  
  const logMsg = `Token generado: ${token} | Cliente: ${cliente} | Ruta: ${ruta} | Productos: ${JSON.stringify(productosParsed)} | Expira: ${new Date(expira).toISOString()} | BaseURL: ${baseUrl}`;
  logDebug(logMsg); 
  
  res.json({ token, urlCliente }); 
});

app.get('/generar-qr/:cliente/:ruta', async (req, res) => {  // ASYNC: NUEVO
  const { cliente, ruta } = req.params;
  const { productos = '[]' } = req.query;
  const token = Math.random().toString(36).substring(7); 
  const expira = Date.now() + 24 * 60 * 60 * 1000;  // 24 horas
  let productosParsed = [];
  try {
    productosParsed = JSON.parse(decodeURIComponent(productos));
  } catch (e) {
    console.log('Error parseando productos:', e);
  }
  const entregas = await loadPendingEntregas();  // NUEVO: Carga desde KV
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
  await savePendingEntregas(entregas);  // NUEVO: Guarda en KV
  
  const baseUrl = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : `${req.protocol}://${req.get('host')}`;
  const urlCliente = `${baseUrl}/cliente.html?token=${token}`;
  
  const logMsg = `Token generado: ${token} | Cliente: ${cliente} | Ruta: ${ruta} | Productos: ${JSON.stringify(productosParsed)} | Expira: ${new Date(expira).toISOString()} | BaseURL: ${baseUrl}`;
  logDebug(logMsg);
  
  res.json({ token, urlCliente }); 
});

app.get('/qr-image/:token', async (req, res) => {  // ASYNC: NUEVO
  const { token } = req.params;
  const userAgentShort = req.headers['user-agent']?.substring(0, 30) || 'Unknown';
  logDebug(`Solicitando QR para token: ${token} | User-Agent: ${userAgentShort}`);
  
  const entregas = await loadPendingEntregas();  // NUEVO: Carga desde KV
  const entrega = entregas.find(e => e.token === token);
  let reason = '';
  if (!entrega) {
    reason = 'no token match';
  } else if (entrega.asistido) {
    reason = 'already asistido';
  } else if (Date.now() >= entrega.expira) {
    reason = 'expired';
  }
  
  if (!entrega || reason) {
    const logMsg = `ERROR: ${reason || 'unknown'}: ${token} | Tokens activos: ${entregas.length}`;
    logDebug(logMsg);
    return res.status(404).send('Expirado, ya usado o inválido');
  }
  
  const logMsgOK = `Token OK: ${entrega.cliente} | Expira: ${new Date(entrega.expira).toISOString()}`;
  logDebug(logMsgOK);
  
  const timestamp = Date.now();
  const subToken = Buffer.from(token + timestamp).toString('base64').substring(0, 10); 
  
  const baseUrl = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : `${req.protocol}://${req.get('host')}`;
  const data = `${baseUrl}/confirmar.html?token=${token}&subToken=${subToken}&timestamp=${timestamp}`;
  
  const logMsgQR = `QR data URL generada: ${data}`;
  logDebug(logMsgQR);
  
  const qr = await QRCode.toDataURL(data);
  res.send(qr);
});

app.post('/confirmar-sub', async (req, res) => {  // ASYNC: NUEVO
  const { subToken, timestamp, mainToken } = req.body;  

  if (!mainToken || mainToken === 'undefined' || mainToken.trim() === '') {
    const logMsg = 'Error: mainToken undefined o vacío en POST body';
    logDebug(logMsg);
    return res.json({ ok: false, msg: 'Token requerido (verifica QR y URL)' });
  }
  
  logDebug(`Confirmando: token=${mainToken}, subToken=${subToken}, timestamp=${timestamp}`);
  
  const expectedSub = Buffer.from(mainToken + timestamp).toString('base64').substring(0, 10);
  if (subToken !== expectedSub || Date.now() > (parseInt(timestamp) + 24 * 60 * 60 * 1000)) {
    const logMsg = `Sub inválido: ${subToken} vs ${expectedSub} | Timestamp: ${timestamp} | Diferencia: ${(Date.now() - parseInt(timestamp)) / 1000}s`;
    logDebug(logMsg);
    return res.json({ ok: false, msg: 'Sub-token inválido o expirado (regenera QR)' });
  }
  
  const entregas = await loadPendingEntregas();  // NUEVO: Carga desde KV
  const entrega = entregas.find(e => e.token === mainToken && !e.asistido && Date.now() < e.expira);
  if (!entrega) {
    const logMsg = `Entrega no encontrada para ${mainToken} | Tokens activos: ${entregas.length}`;
    logDebug(logMsg);
    return res.json({ ok: false, msg: 'Token expirado o ya usado' });
  }
  
  entrega.asistido = true;
  entrega.llegada = new Date().toISOString();
  await savePendingEntregas(entregas);  // NUEVO: Guarda pending (ahora con asistido=true, se filtrará después)
  
  // NUEVO: Mueve a confirmed y log
  await agregarConfirmacion(entrega.cliente, entrega.ruta, entrega.llegada, entrega.productos);
  
  res.json({ ok: true, msg: `¡Asistencia confirmada para ${entrega.cliente} en ruta ${entrega.ruta}! Productos: ${entrega.productos.map(p => `${p.cantidad} ${p.nombre}`).join(', ')}` });
});

app.get('/asistencias', async (req, res) => {  // ASYNC: NUEVO
  const confirmed = await loadConfirmed();  // NUEVO: De historial confirmado
  const asistidas = confirmed.map(conf => ({  // Mapea al formato viejo
    cliente: conf.cliente,
    ruta: conf.ruta,
    productos: conf.productosStr ? conf.productosStr.split(', ').map(str => {  // Parsea simple si es string
      const [cant, ...nom] = str.split(' ');
      return { cantidad: cant, nombre: nom.join(' ') };
    }) : [],
    llegada: conf.fechaISO
  }));
  res.json(asistidas);
});

// Endpoint para debug: lista tokens activos
app.get('/finalizar-pdf', async (req, res) => {
  try {
    logDebug('DEBUG PDF: Iniciando carga de KV');
    const rawConfirmed = await kv.get('confirmed');
    logDebug(`DEBUG PDF: Raw KV 'confirmed': ${JSON.stringify(rawConfirmed)}`);  // Para ver si hay data

    const confirmaciones = await loadConfirmed();  // Función helper KV
    logDebug(`DEBUG PDF: Confirmaciones parseadas: ${confirmaciones.length}`);  // Count

    if (confirmaciones.length === 0) {
      logDebug('DEBUG PDF: 0 confirmaciones - abort');
      return res.status(400).send('No hay confirmaciones para generar PDF. (Genera una asistencia primero).');
    }

    logDebug(`DEBUG PDF: Generando PDF con ${confirmaciones.length} entradas`);
    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();

    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <title>Reporte de Confirmaciones de Asistencia</title>
          <style>
            body { 
              font-family: Arial, sans-serif; 
              margin: 20px; 
              background-color: #042b17ff;
              color: #ffffffff;
            }
            h1 { 
              text-align: center; 
              color: #ffffffff;
            }
            table { 
              width: 100%; 
              border-collapse: collapse; 
              background-color: #082519ff;
            }
            th, td { 
              border: 1px solid #ffffffff;
              padding: 8px; 
              text-align: left; 
              color: #ffffffff;
            }
            th { 
              background-color: #042b17ff;
              font-weight: bold; 
            }
            .cliente { width: 25%; }
            .ruta { width: 20%; }
            .productos { width: 35%; }
            .fecha { width: 20%; }
            tr:nth-child(even) { 
              background-color: #052913ff;
            }
            tr:nth-child(odd) { 
              background-color: #082519ff;
            }
            p { 
              color: #ffffffff;
            }
          </style>
        </head>
        <body>
          <h1>Reporte de Confirmaciones de Asistencia (Acumulado por Clientes)</h1>
          <p><strong>Total confirmaciones:</strong> ${confirmaciones.length}</p>
          <p><strong>Última actualización:</strong> ${new Date().toLocaleDateString('es-CO', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'America/Bogota' })}</p>
          <table>
            <thead>
              <tr>
                <th class="cliente">Cliente</th>
                <th class="ruta">Ruta (Camión)</th>
                <th class="productos">Productos Entregados</th>
                <th class="fecha">Hora de Confirmación</th>
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
          <p><strong>Fin de reporte.</strong> </p>
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
    res.setHeader('Content-Disposition', `attachment; filename=reporte-confirmaciones-${new Date().toISOString().split('T')[0]}.pdf`);
    res.send(pdfBuffer);

    logDebug(`PDF generado exitoso desde KV (${confirmaciones.length} confirmaciones).`);
  } catch (error) {
    logDebug(`ERROR PDF: ${error.message}`);
    res.status(500).send('Error al generar PDF: ' + error.message);
  }
});

// NUEVO: Endpoint para obtener detalles de entrega por token
app.get('/get-entrega/:token', async (req, res) => {  // ASYNC: NUEVO
  const { token } = req.params;
  const entregas = await loadPendingEntregas();  // NUEVO: De KV
  const entrega = entregas.find(e => e.token === token && !e.asistido && Date.now() < e.expira);
  if (!entrega) {
    return res.status(404).json({ error: 'Token inválido o expirado' });
  }
  res.json({
    cliente: entrega.cliente,
    ruta: entrega.ruta,
    productos: entrega.productos || []
  });
});

// NUEVO: Endpoint para borrar confirmed (reinicia reporte)
app.delete('/borrar-logs', async (req, res) => {  // ASYNC: NUEVO
  await kv.del('confirmed');
  logDebug('Confirmaciones borradas de KV.');
  return res.json({ ok: true, msg: 'Reporte reiniciado.' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor en puerto ${PORT}`);
  console.log('Debug: Ve a /debug-tokens para ver tokens activos');
  console.log('Nuevo: Ve a /finalizar-pdf para generar PDF desde KV');
});

// NUEVO: Export para Vercel
module.exports = app;